// Consolidation (Phase 4 "sleep" job): episode replay → candidate extraction → entity
// resolution → schema-fit gate → apply.
// Follows src/consolidation/README.md contract and docs/ROADMAP.md Phase 4.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openIndex } from '../index/db.ts';
import { STATE_DIR, type Config } from '../config.ts';
import type { ParsedNote, Fact } from '../types.ts';
import { parseVault } from '../index/indexer.ts';
import { setConsolidatedDate, hasFencedFrontmatter } from '../vault/episode-mark.ts';
import { localDateString, parseInstant } from '../vault/time.ts';
import { asWikiLink, shortHash } from '../vault/util.ts';
import { writeFactToNote, type WritableFact } from '../vault/fact-write.ts';
import { extractCandidates, type Candidate } from './candidate.ts';
import { resolveEntity } from './entity.ts';
import { evaluateGate } from './schema.ts';
import { promoteTriplesToCandidates } from './promote.ts';
import { supersede } from './supersede.ts';

export interface ConsolidationResult {
  promoted: number;
  queued: number;
  superseded: number;
  processedEpisodes: string[];
  pendingPath: string;
}

/** An episode is unconsolidated when it has no valid `consolidated:` date. */
function isUnconsolidated(n: ParsedNote): boolean {
  const consolidated = n.frontmatter.consolidated;
  if (!consolidated) return true;
  if (typeof consolidated !== 'string') return true;
  return Number.isNaN(Date.parse(consolidated));
}

export interface ConsolidateOptions {
  dryRun?: boolean;
  reflectionThreshold?: number;
  commit?: boolean;
}

/**
 * Run consolidation: replay episodes, extract candidates, resolve entities, apply gate,
 * promote/queue/supersede.
 */
export async function consolidate(
  vault: string,
  cfg: Config,
  opts: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const allNotes = parseVault(vault, cfg);
  const episodes = allNotes.filter((n) => n.type === 'episode' && isUnconsolidated(n));
  const noteById = new Map(allNotes.map((n) => [n.id, n]));
  const { db } = openIndex(join(vault, cfg.index.path));

  // Track consolidated facts per entity for reflection
  const entityFacts = new Map<string, Fact[]>();

  let promoted = 0;
  let queued = 0;
  let superseded = 0;
  const processedEpisodes: string[] = [];

  // Collect all candidates from episodes
  const allCandidates: Candidate[] = [];
  for (const ep of episodes) {
    if (cfg.extraction.provider === 'none') {
      // Without extraction, skip candidate generation
      continue;
    }
    const candidates = await extractCandidates(ep, cfg);
    allCandidates.push(...candidates);
  }

  // Collect high-confidence triples from HippoRAG triple cache (Phase 5: promotion path).
  // These triples are proposed as consolidation candidates but always queue (ADR-0006).
  const tripleCandidates = promoteTriplesToCandidates(vault, cfg);
  allCandidates.push(...tripleCandidates);

  const pendingPath = join(vault, STATE_DIR, 'pending.jsonl');
  mkdirSync(dirname(pendingPath), { recursive: true });

  const today = localDateString();
  const todayMs = parseInstant(today);

  for (const c of allCandidates) {
    const subjectRef = resolveEntity(db, c.subject);
    const objLink = asWikiLink(c.object);
    const objectRef = resolveEntity(db, objLink ? objLink.target : c.object);

    // The gate is pure: read the subject note's current facts here and pass them in.
    const subjectNote = subjectRef ? noteById.get(subjectRef.id) : undefined;
    const currentFacts = subjectNote ? subjectNote.facts.filter((f) => f.status === 'current') : [];

    const decision = evaluateGate(c, cfg, subjectRef, objectRef, currentFacts);

    if (decision.action === 'promote' && subjectRef) {
      const fact = buildFact(c, subjectRef.id, objectRef?.id ?? null, todayMs, null);
      writeFactToNote(vault, subjectRef.path, fact, { factsHeading: cfg.vault.factsHeading });
      promoted++;
      trackFact(entityFacts, subjectRef.path, fact);
    } else if (decision.action === 'supersede' && subjectRef) {
      const supersededAt = todayMs ?? Date.now();
      // World time is when the change happened (the episode's `started`), not the run
      // date. `at::` and `superseded::` keep the run date (system time).
      const validAt = noteById.get(c.episodeId)?.created ?? supersededAt;
      const newFact = buildFact(c, subjectRef.id, objectRef?.id ?? null, supersededAt, validAt);
      const result = supersede(join(vault, subjectRef.path), { supersededAt, validAt, newFact });
      if (result.changed) {
        superseded++;
        trackFact(entityFacts, subjectRef.path, newFact);
      } else {
        queued++;
        writeFileSync(pendingPath, JSON.stringify(decision) + '\n', { flag: 'a' });
      }
    } else if (decision.action === 'noop') {
      // Corroboration: the fact is already current. Nothing to write.
    } else {
      queued++;
      // Append to pending.jsonl
      writeFileSync(pendingPath, JSON.stringify(decision) + '\n', { flag: 'a' });
    }
  }

  // Mark episodes as consolidated.
  // Episodes are append-only: the only permitted mutation is the `consolidated:` field.
  // setConsolidatedDate performs a minimal in-place text edit (one line changed) so
  // quotes, comments, block lists, and the `---` fences survive untouched.
  // Local calendar date, not UTC: an evening run in a negative-offset timezone must not
  // stamp tomorrow's date on the episode.
  for (const ep of episodes) {
    if (opts.dryRun) {
      processedEpisodes.push(ep.path);
      continue;
    }
    const raw = readFileSync(join(vault, ep.path), 'utf8');
    if (!hasFencedFrontmatter(raw)) {
      // Don't corrupt a malformed episode; surface it instead.
      console.warn(`warning: episode-mark.no-frontmatter ${ep.path}`);
      processedEpisodes.push(ep.path);
      continue;
    }
    const updated = setConsolidatedDate(raw, today);
    if (updated !== raw) {
      writeFileSync(join(vault, ep.path), updated, 'utf8');
    }
    processedEpisodes.push(ep.path);
  }

  // Reflection: generate schema notes for entities with sufficient importance
  const threshold = opts.reflectionThreshold ?? 3;
  for (const [entity, facts] of entityFacts) {
    const { reflect } = await import('./reflection.ts');
    const result = reflect(vault, entity, facts, threshold);
    if (result?.changed) {
      console.log(`reflected: ${entity}`);
    }
  }

  // Handle git commit
  if (opts.commit && !opts.dryRun) {
    try {
      const { createConsolidationCommit } = await import('../vault/git.ts');
      const commitResult = createConsolidationCommit(vault, {
        promoted,
        queued,
        superseded,
      });
      if (commitResult) {
        console.log(`committed: ${commitResult.hash.slice(0, 7)}`);
      }
    } catch (e) {
      console.error(`warning: git commit failed: ${(e as Error).message}`);
    }
  }

  db.close();

  return { promoted, queued, superseded, processedEpisodes, pendingPath };
}

/**
 * Build the fact a promoted/superseding candidate becomes.
 *
 * - `object` is a wikilink when the object resolved to a note, else a literal.
 * - `by: agent` with `src:: [[episode]]` — consolidation is the only writer of agent
 *   facts (SCHEMA §4.5), and provenance is mandatory.
 * - `trust` is inherited from the source episode, never hardcoded.
 * - `id` is a content hash (not `Date.now()`), so re-running is idempotent.
 */
function buildFact(
  c: Candidate,
  subjectId: string,
  objectId: string | null,
  recordedAt: number | null,
  validFrom: number | null,
): WritableFact {
  const object: Fact['object'] = objectId
    ? { kind: 'link', link: { target: objectId } }
    : { kind: 'literal', value: asWikiLink(c.object)?.target ?? c.object };
  const objectKey = object.kind === 'link' ? `[[${object.link.target}]]` : object.value;
  return {
    id: `f-${shortHash(subjectId, c.predicate, objectKey, validFrom)}`,
    predicate: c.predicate,
    object,
    valid: { from: validFrom, to: null },
    recordedAt,
    supersededAt: null,
    by: 'agent',
    trust: c.trust,
    conf: c.confidence,
    src: { target: c.episodeId },
    status: 'current',
    comment: null,
  };
}

function trackFact(entityFacts: Map<string, Fact[]>, notePath: string, fact: WritableFact): void {
  const entityName = notePath.split('/').pop()?.replace('.md', '') ?? '';
  const list = entityFacts.get(entityName) ?? [];
  list.push({ ...fact, line: 0, raw: '' });
  entityFacts.set(entityName, list);
}
