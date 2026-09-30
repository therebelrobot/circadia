// Consolidation (Phase 4 "sleep" job): episode replay → candidate extraction → entity resolution → schema-fit gate → apply.
// Follows src/consolidation/README.md contract and docs/ROADMAP.md Phase 4.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openIndex } from '../index/db.ts';
import { STATE_DIR, type Config } from '../config.ts';
import type { ParsedNote } from '../types.ts';
import { parseVault } from '../index/indexer.ts';
import { setConsolidatedDate, hasFencedFrontmatter } from '../vault/episode-mark.ts';
import { localDateString } from '../vault/time.ts';
import { extractCandidates, type Candidate } from './candidate.ts';
import { resolveEntity } from './entity.ts';
import { evaluateGate } from './schema.ts';
import { promoteTriplesToCandidates } from './promote.ts';
import type { Fact } from '../types.ts';

export interface ConsolidationResult {
  promoted: number;
  queued: number;
  superseded: number;
  processedEpisodes: string[];
  pendingPath: string;
}

/**
 * Select episodes without consolidated: date.
 */
function selectEpisodes(vault: string, cfg: Config): ParsedNote[] {
  const notes = parseVault(vault, cfg);
  return notes.filter((n) => {
    if (n.type !== 'episode') return false;
    const consolidated = n.frontmatter.consolidated;
    if (!consolidated) return true; // no consolidation date
    if (typeof consolidated !== 'string') return true;
    // Skip episodes with a valid consolidated date
    const consolidatedMs = Date.parse(consolidated);
    if (Number.isNaN(consolidatedMs)) return true;
    return false; // episode is marked as consolidated
  });
}

/**
 * Run consolidation: replay episodes, extract candidates, resolve entities, apply gate, promote/queue.
 */
export interface ConsolidateOptions {
  dryRun?: boolean;
  reflectionThreshold?: number;
  commit?: boolean;
}

export async function consolidate(
  vault: string,
  cfg: Config,
  opts: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const episodes = selectEpisodes(vault, cfg);
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

  // Collect high-confidence triples from HippoRAG triple cache (Phase 5: promotion path)
  // These triples are proposed as consolidation candidates but still go through the gate
  const tripleCandidates = promoteTriplesToCandidates(vault, cfg);
  allCandidates.push(...tripleCandidates);

  // Apply schema-fit gate
  const pendingPath = join(vault, STATE_DIR, 'pending.jsonl');
  mkdirSync(dirname(pendingPath), { recursive: true });

  for (const c of allCandidates) {
    const subjectRef = resolveEntity(db, c.subject);
    const objectRef = resolveEntity(db, c.object.replace(/^[[\s*|\s*]]/g, ''));
    const decision = evaluateGate(c, cfg, subjectRef, objectRef);

    if (decision.action === 'promote' && subjectRef) {
      promoted++;

      // Build fact from candidate
      const fact: Fact = {
        id: `f-${Date.now()}`,
        predicate: c.predicate,
        object: { kind: 'literal', value: c.object },
        valid: { from: null, to: null },
        recordedAt: Date.now(),
        supersededAt: null,
        by: 'agent',
        trust: 'medium',
        conf: c.confidence,
        src: { target: c.episodeId },
        status: 'current',
        comment: null,
        line: 0,
        raw: '',
      };

      // Track for reflection
      const entityName = subjectRef.path.split('/').pop()?.replace('.md', '') ?? '';
      if (!entityFacts.has(entityName)) {
        entityFacts.set(entityName, []);
      }
      entityFacts.get(entityName)!.push(fact);
    } else {
      queued++;
      // Append to pending.jsonl
      const line = JSON.stringify(decision) + '\n';
      writeFileSync(pendingPath, line, { flag: 'a' });
    }
  }

  // Mark episodes as consolidated.
  // Episodes are append-only: the only permitted mutation is the `consolidated:` field.
  // setConsolidatedDate performs a minimal in-place text edit (one line changed) so
  // quotes, comments, block lists, and the `---` fences survive untouched.
  // Local calendar date, not UTC: an evening run in a negative-offset timezone must not
  // stamp tomorrow's date on the episode.
  const today = localDateString();
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
