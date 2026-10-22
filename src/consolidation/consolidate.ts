// Consolidation (Phase 4 "sleep" job): episode replay → candidate extraction → entity
// resolution → schema-fit gate → apply.
// Follows src/consolidation/README.md contract and docs/ROADMAP.md Phase 4.
//
// C6: candidates carry a stable key; a key already pending, rejected, or promoted is
//     skipped, and a triple is only re-proposed when its passage content changed.
// C7: the whole run is computed as an in-memory change set. A dry run prints an
//     in-process unified diff and writes nothing (no git, no state files).
// C8: the commit stages only the paths this run wrote, and refuses when one of them was
//     already dirty before the run.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openIndex } from '../index/db.ts';
import { STATE_DIR, type Config } from '../config.ts';
import type { ParsedNote, Fact, SourceKind } from '../types.ts';
import { parseVault } from '../index/indexer.ts';
import { setConsolidatedDate, hasFencedFrontmatter } from '../vault/episode-mark.ts';
import { localDateString, systemDateNow } from '../vault/time.ts';
import { asWikiLink, shortHash } from '../vault/util.ts';
import { appendFactLine, replaceLine, type WritableFact } from '../vault/fact-write.ts';
import { formatFact, confForSupport, strengthenConf, sourceWeight } from '../vault/facts.ts';
import { unifiedDiff } from '../vault/diff.ts';
import { getPreexistingModifiedPaths, createConsolidationCommit } from '../vault/git.ts';
import { extractCandidates, isPlausibleEntityName, type Candidate } from './candidate.ts';
import { resolveEntity, deriveEntityNote } from './entity.ts';
import { evaluateGate, factObjectKey } from './schema.ts';
import { promoteTriplesToCandidates, readSeenHashes, serializeSeenHashes } from './promote.ts';
import { applySupersede } from './supersede.ts';
import { readAccessLog } from '../retrieval/activation.ts';
import { renderReflection } from './reflection.ts';
import {
  CONSOLIDATED_STATE_VERSION,
  consolidatedStatePath,
  noteBodyHash,
  readConsolidatedState,
  serializeConsolidatedState,
  type ConsolidatedState,
} from './consolidated-state.ts';
import {
  PENDING_RECORD_VERSION,
  candidateKey,
  pendingPath as pendingPathFor,
  rejectedPath as rejectedPathFor,
  readKeys,
  readRecords,
  serializeRecords,
  type PendingRecord,
} from './pending.ts';

export interface ConsolidationResult {
  promoted: number;
  queued: number;
  superseded: number;
  processedEpisodes: string[];
  pendingPath: string;
  /** unified diff of the change set; only set for a dry run */
  diff?: string;
}

/** An in-memory file edit: what the file was, and what it would become. */
interface FileChange {
  /** vault-relative posix path */
  path: string;
  before: string;
  after: string;
}

/**
 * An episode is unconsolidated when it has no valid `consolidated:` date, or when its body
 * has changed since consolidation last ran (C22).
 *
 * Decision (C22): re-selection is driven by a body hash, not mtime. A vault copy, checkout,
 * rsync, or restore moves mtimes without changing content, and an mtime rule would re-select
 * every episode — re-extracting it (LLM cost) and, because an old episode can contradict a
 * newer fact, silently reverting memory to a stale value. A body hash changes only on a real
 * edit, which is the "manual fix" case the roadmap wants to catch. An episode consolidated
 * before this mechanism existed has no recorded baseline; its current body is adopted as the
 * baseline (backfilled below) rather than re-processed. See docs/ROADMAP.md Phase 4.
 */
function isUnconsolidated(n: ParsedNote, bodyHash: string, state: ConsolidatedState): boolean {
  const consolidated = n.frontmatter.consolidated;
  if (!consolidated) return true;
  if (typeof consolidated !== 'string') return true;
  if (Number.isNaN(Date.parse(consolidated))) return true;
  const recorded = state.hashes[n.path];
  if (recorded === undefined) return false;
  return bodyHash !== recorded;
}

export interface ConsolidateOptions {
  dryRun?: boolean;
  reflectionThreshold?: number;
  commit?: boolean;
  /** run the REM pass after the commit (RFC-0001 Stage 2) */
  dream?: boolean;
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
  const noteById = new Map(allNotes.map((n) => [n.id, n]));

  // C22: re-selection is content-based. Hash each episode's body once; a vault copy,
  // checkout, or restore changes mtimes but not content, so it must not re-trigger
  // consolidation. The recorded baseline lives in .circadia/consolidated.json.
  const statePath = consolidatedStatePath(vault);
  const state = readConsolidatedState(statePath);
  const episodeRaw = new Map<string, string>();
  const episodeHashes = new Map<string, string>();
  for (const n of allNotes) {
    if (n.type !== 'episode') continue;
    const raw = readFileSync(join(vault, n.path), 'utf8');
    episodeRaw.set(n.path, raw);
    episodeHashes.set(n.path, noteBodyHash(raw));
  }
  const episodes = allNotes.filter(
    (n) => n.type === 'episode' && isUnconsolidated(n, episodeHashes.get(n.path) ?? '', state),
  );

  const { db } = openIndex(join(vault, cfg.index.path));

  // C18: reconsolidation window. A fact recalled in the same session as the episode that
  // contradicts it was active when it was contradicted, so its queued record is prioritized
  // for review. The access log records the passage id (`<noteId>#<n>`); the note id is the
  // part before `#`. Only events that carry a session id participate. This is derived state
  // (the log is not the vault), so it never changes what is written — only review order.
  const recalledBySession = new Map<string, Set<string>>();
  for (const e of readAccessLog(join(vault, cfg.index.accessLog))) {
    if (!e.session) continue;
    const noteId = e.node.split('#')[0];
    const set = recalledBySession.get(e.session) ?? new Set<string>();
    set.add(noteId);
    recalledBySession.set(e.session, set);
  }

  // Track consolidated facts per entity for reflection
  const entityFacts = new Map<string, Fact[]>();

  let promoted = 0;
  let queued = 0;
  let superseded = 0;
  const processedEpisodes: string[] = [];

  // --- In-memory change set (C7) -------------------------------------------------
  // Nothing is written until the whole run is computed. A dry run prints the diff and
  // writes nothing at all.
  const changes = new Map<string, FileChange>();
  const stage = (path: string, transform: (before: string) => string): void => {
    const existing = changes.get(path);
    const before = existing
      ? existing.before
      : existsSync(join(vault, path))
        ? readFileSync(join(vault, path), 'utf8')
        : '';
    const after = transform(existing ? existing.after : before);
    changes.set(path, { path, before, after });
  };

  // --- Candidate collection ------------------------------------------------------
  const allCandidates: Candidate[] = [];
  let droppedCandidates = 0;
  // Episodes whose extraction failed. They are isolated: the rest of the night still
  // runs, and the failed ones are left unmarked so the next run re-selects them. One
  // poisoned episode (a body the model can never parse, say) must not block every other
  // memory from consolidating forever.
  const failedExtraction = new Set<string>();
  for (const ep of episodes) {
    if (cfg.extraction.provider === 'none') {
      // Without extraction, skip candidate generation
      continue;
    }
    try {
      const { candidates, dropped } = await extractCandidates(ep, cfg);
      droppedCandidates += dropped;
      allCandidates.push(...candidates);
    } catch (e) {
      failedExtraction.add(ep.path);
      console.warn(`warning: extract.failed ${ep.path}: ${(e as Error).message}`);
    }
  }
  if (droppedCandidates > 0) {
    // Surface invalid model output instead of silently discarding it (C11).
    console.warn(`warning: candidate.invalid-items dropped ${droppedCandidates} invalid candidate(s)`);
  }

  // Triple-cache candidates (Phase 5). Only passages whose contentHash changed since the
  // last run are proposed (C6).
  const seenPath = join(vault, STATE_DIR, 'triples-seen.json');
  const seenHashes = readSeenHashes(seenPath);
  const { candidates: tripleCandidates, seen: nextSeenHashes } = promoteTriplesToCandidates(
    vault,
    cfg,
    undefined,
    seenHashes,
  );
  allCandidates.push(...tripleCandidates);

  // --- Dedup (C6) ----------------------------------------------------------------
  // A candidate is skipped when its key is already pending, rejected, or promoted.
  const seenKeys = new Set<string>([
    ...readKeys(pendingPathFor(vault)),
    ...readKeys(rejectedPathFor(vault)),
  ]);
  for (const note of allNotes) {
    for (const f of note.facts) {
      if (f.status !== 'current') continue;
      seenKeys.add(
        candidateKey({
          subject: note.id,
          predicate: f.predicate,
          object: factObjectKey(f),
          src: f.src?.target ?? '',
        }),
      );
    }
  }

  // --- Additive corroboration (opt-in) -------------------------------------------
  // Support is the number of DISTINCT episodes asserting the same resolved claim, counted
  // across the pending queue and this run. An already-current claim is strengthened (its
  // `conf::` moves one step toward 1) rather than re-written. Corroboration never applies
  // to a claim a human rejected, nor to a contradiction or untrusted source (the gate
  // returns those before the corroboration check).
  const pendingRecords = readRecords(pendingPathFor(vault));
  const claimKeyOfRecord = (r: PendingRecord): string => {
    const subj = resolveEntity(db, r.subject);
    const link = asWikiLink(r.object);
    const ob = resolveEntity(db, link ? link.target : r.object);
    const objectKey = ob ? `[[${ob.id}]]` : (asWikiLink(r.object)?.target ?? r.object);
    return `${subj?.id ?? r.subject}|${r.predicate}|${objectKey}`;
  };
  // episode id -> source kind, per claim, so support can be weighted (a human assertion
  // counts double an agent's; see `sourceWeight`).
  const pendingClaimEpisodes = new Map<string, Map<string, SourceKind>>();
  for (const r of pendingRecords) {
    const k = claimKeyOfRecord(r);
    const m = pendingClaimEpisodes.get(k) ?? new Map<string, SourceKind>();
    m.set(r.episode, r.by);
    pendingClaimEpisodes.set(k, m);
  }
  const rejectedClaimKeys = new Set(readRecords(rejectedPathFor(vault)).map(claimKeyOfRecord));
  const runClaimEpisodes = new Map<string, Map<string, SourceKind>>();
  const promotedClaimKeys = new Set<string>();

  // System time for `at::`/`superseded::` is the LOCAL calendar date (systemDateNow), so
  // an evening run in a negative-offset timezone does not stamp tomorrow's UTC date.
  const now = Date.now();
  const today = localDateString(new Date(now));
  const todayMs = systemDateNow(now);
  const newPending: PendingRecord[] = [];

  for (const c of allCandidates) {
    const subjectRef = resolveEntity(db, c.subject);
    const objLink = asWikiLink(c.object);
    const objectRef = resolveEntity(db, objLink ? objLink.target : c.object);

    // Stable key over the resolved identity, so a re-run sees the same key.
    const objectKey = objectRef
      ? `[[${objectRef.id}]]`
      : (asWikiLink(c.object)?.target ?? c.object);
    const key = candidateKey({
      subject: subjectRef?.id ?? c.subject,
      predicate: c.predicate,
      object: objectKey,
      src: c.episodeId,
    });
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Weighted corroboration support for this claim: distinct episodes across the pending
    // queue and this run, weighted by source (human > agent). Disabled when a human already
    // rejected the claim.
    const claimKey = `${subjectRef?.id ?? c.subject}|${c.predicate}|${objectKey}`;
    const runSet = runClaimEpisodes.get(claimKey) ?? new Map<string, SourceKind>();
    runSet.set(c.episodeId, c.by);
    runClaimEpisodes.set(claimKey, runSet);
    const merged = new Map<string, SourceKind>([...(pendingClaimEpisodes.get(claimKey) ?? []), ...runSet]);
    let support = 0;
    for (const by of merged.values()) support += sourceWeight(by);
    const corroborationOn = cfg.consolidation.corroboration && !rejectedClaimKeys.has(claimKey);

    // The gate is pure: read the subject note's current facts here and pass them in.
    const subjectNote = subjectRef ? noteById.get(subjectRef.id) : undefined;
    const currentFacts = subjectNote ? subjectNote.facts.filter((f) => f.status === 'current') : [];

    // Additive strengthening: a new independent episode that agrees with a fact already
    // current moves its conf one step toward 1 instead of re-writing it. This runs before
    // the gate so it applies whether or not the predicate is declared.
    const existingFact = subjectNote?.facts.find(
      (f) => f.status === 'current' && f.predicate === c.predicate && factObjectKey(f) === objectKey,
    );
    if (corroborationOn && existingFact && subjectRef) {
      if (existingFact.conf < 1) {
        const newConf = strengthenConf(existingFact.conf, c.by);
        stage(subjectRef.path, (raw) =>
          replaceLine(raw, existingFact.line, formatFact({ ...existingFact, conf: newConf })),
        );
      }
      continue;
    }

    // World time is when the claim was made (the episode's `started`), not the run date.
    // `at::` and `superseded::` keep the run date (system time). The gate needs it to refuse
    // a supersession that would close a newer fact with an older claim.
    const validAt = noteById.get(c.episodeId)?.created ?? todayMs;

    // C18: prioritize a queued contradiction when the subject fact was recalled in the same
    // session as the contradicting episode. The episode's `session` frontmatter is the
    // session id; the access log's `session` is the same id. A subject that did not resolve
    // to a note (a new entity) cannot have been recalled, so it is never prioritized.
    const episodeSession = noteById.get(c.episodeId)?.frontmatter.session;
    const session = typeof episodeSession === 'string' ? episodeSession : undefined;
    const priority =
      session && subjectRef && recalledBySession.get(session)?.has(subjectRef.id)
        ? ('reconsolidation' as const)
        : undefined;

    const decision = evaluateGate(c, cfg, subjectRef, objectRef, currentFacts, validAt, corroborationOn ? support : 1);
    const corroborated = decision.reason.startsWith('corroborated');

    // A predicate declared `object: entity` must carry a [[link]], not a literal. If the
    // object did not resolve, derive its entity note (symmetric with a new subject) and use
    // the link; the note is staged only when a fact is actually written (#17).
    const objectName = asWikiLink(c.object)?.target ?? c.object;
    const wantsEntityObject = cfg.predicates.defs[c.predicate]?.object === 'entity';
    // #23: only stub a *plausible* object name. Otherwise the candidate can produce neither a
    // valid link nor a valid literal, so it queues for a human instead.
    const derivedObject =
      !objectRef && wantsEntityObject && isPlausibleEntityName(objectName)
        ? deriveEntityNote(objectName, today)
        : null;
    const objectId = objectRef?.id ?? derivedObject?.id ?? null;
    const objectReady = !wantsEntityObject || objectId !== null;

    if (decision.action === 'promote' && objectReady) {
      // A corroborated promotion may be about a subject the vault has never seen: create a
      // minimal entity note so the fact has somewhere to live (tier-0 resolvable next run).
      let target = subjectRef;
      if (!target) {
        const derived = deriveEntityNote(c.subject, today);
        stage(derived.path, () => derived.content);
        target = { id: derived.id, title: c.subject, path: derived.path };
      }
      if (derivedObject) stage(derivedObject.path, () => derivedObject.content);
      const fact = buildFact(c, target.id, objectId, todayMs, validAt);
      if (corroborated) fact.conf = confForSupport(support);
      stage(target.path, (raw) =>
        appendFactLine(raw, fact, { factsHeading: cfg.vault.factsHeading }),
      );
      promoted++;
      trackFact(entityFacts, target.path, fact);
      // Drop any pending record(s) for this claim so review no longer shows a stale queue.
      if (corroborated) promotedClaimKeys.add(claimKey);
    } else if (decision.action === 'promote') {
      // #23: the predicate wants an entity object, but the object name is not one we will stub.
      queued++;
      newPending.push(pendingRecord(key, c, 'entity object not resolvable', todayMs, priority));
    } else if (decision.action === 'supersede' && subjectRef && objectReady) {
      const supersededAt = todayMs;
      const newFact = buildFact(c, subjectRef.id, objectId, supersededAt, validAt);
      let changed = false;
      stage(subjectRef.path, (raw) => {
        const r = applySupersede(raw, {
          path: subjectRef.path,
          supersededAt,
          validAt,
          newFact,
        });
        changed = r.changed;
        return r.content;
      });
      if (changed) {
        superseded++;
        // Only materialize the derived object entity if the supersession actually wrote.
        if (derivedObject) stage(derivedObject.path, () => derivedObject.content);
        trackFact(entityFacts, subjectRef.path, newFact);
      } else {
        queued++;
        newPending.push(pendingRecord(key, c, decision.reason, todayMs, priority));
      }
    } else if (decision.action === 'noop') {
      // Corroboration: the fact is already current. Nothing to write.
    } else {
      queued++;
      newPending.push(pendingRecord(key, c, decision.reason, todayMs, priority));
    }
  }

  // --- Episode marks -------------------------------------------------------------
  // Episodes are append-only: the only permitted mutation is the `consolidated:` field.
  // setConsolidatedDate performs a minimal in-place text edit (one line changed) so
  // quotes, comments, block lists, and the `---` fences survive untouched.
  // Local calendar date, not UTC: an evening run in a negative-offset timezone must not
  // stamp tomorrow's date on the episode.
  for (const ep of episodes) {
    // An episode whose extraction failed is not marked: it must be re-selected next run.
    if (failedExtraction.has(ep.path)) continue;
    const raw = episodeRaw.get(ep.path) ?? readFileSync(join(vault, ep.path), 'utf8');
    if (!hasFencedFrontmatter(raw)) {
      // Don't corrupt a malformed episode; surface it instead.
      console.warn(`warning: episode-mark.no-frontmatter ${ep.path}`);
      processedEpisodes.push(ep.path);
      continue;
    }
    stage(ep.path, (r) => setConsolidatedDate(r, today));
    processedEpisodes.push(ep.path);
  }

  // --- Pending queue -------------------------------------------------------------
  // Drop any record for a claim that corroborated and promoted this run, whether it came
  // from a previous run or from an earlier episode in this one. A plain queue run keeps the
  // append-only shape, so re-running stays byte-identical (C6).
  const retainedPending = pendingRecords.filter((r) => !promotedClaimKeys.has(claimKeyOfRecord(r)));
  const keptNewPending = newPending.filter((r) => !promotedClaimKeys.has(claimKeyOfRecord(r)));
  queued = keptNewPending.length;
  if (retainedPending.length > 0 || keptNewPending.length > 0 || promotedClaimKeys.size > 0) {
    const rel = join(STATE_DIR, 'pending.jsonl');
    stage(rel, () => serializeRecords([...retainedPending, ...keptNewPending]));
  }

  // --- Triple seen-hash state ----------------------------------------------------
  // Record the passage hashes we saw so an unchanged passage is not re-proposed. Staged
  // like any other write so a dry run leaves it untouched (C7) and the commit includes it.
  if (nextSeenHashes.size > 0 || existsSync(seenPath)) {
    const rel = join(STATE_DIR, 'triples-seen.json');
    stage(rel, () => serializeSeenHashes(nextSeenHashes));
  }

  // --- Consolidated body-hash state (C22) ----------------------------------------
  // Record each episode's body hash so a later run re-selects only on a real edit. Built
  // fresh from the episodes on disk, so a deleted episode's hash is pruned. Staged like any
  // other write so a dry run leaves it untouched (C7) and the commit includes it.
  if (episodeHashes.size > 0 || existsSync(statePath)) {
    const nextHashes: Record<string, string> = {};
    for (const [path, hash] of episodeHashes) {
      if (failedExtraction.has(path)) {
        // The episode was not consolidated, so do NOT adopt its current body as the
        // baseline. Carry the previous hash forward so an edited-but-failed episode keeps
        // differing from its baseline and is re-selected next run; omitting it would look
        // "already consolidated with no baseline" (isUnconsolidated returns false).
        const prev = state.hashes[path];
        if (prev !== undefined) nextHashes[path] = prev;
        continue;
      }
      nextHashes[path] = hash;
    }
    const rel = join(STATE_DIR, 'consolidated.json');
    stage(rel, () => serializeConsolidatedState({ v: CONSOLIDATED_STATE_VERSION, hashes: nextHashes }));
  }

  // --- Reflection ----------------------------------------------------------------
  // Generate schema notes for entities with sufficient importance.
  const threshold = opts.reflectionThreshold ?? 3;
  for (const [entity, facts] of entityFacts) {
    const render = renderReflection(vault, entity, facts, threshold, today);
    if (render?.changed) {
      stage(render.relPath, () => render.content);
    }
  }

  db.close();

  // --- Apply or print ------------------------------------------------------------
  const written = [...changes.values()].filter((c) => c.after !== c.before);
  const writtenPaths = written.map((c) => c.path);

  if (opts.dryRun) {
    const diff = written.map((c) => unifiedDiff(c.path, c.before, c.after)).join('');
    return {
      promoted,
      queued,
      superseded,
      processedEpisodes,
      pendingPath: pendingPathFor(vault),
      diff,
    };
  }

  // C8/B2: capture pre-existing modifications to *tracked* paths we are about to write,
  // BEFORE writing. Untracked paths — the episodes `remember` just wrote, and the state
  // files this run creates — are not counted: they have no committed baseline to protect
  // and must be part of the night's commit (B2). A human's in-progress edit to a tracked
  // note still refuses the commit.
  const preDirty = getPreexistingModifiedPaths(vault, writtenPaths);

  for (const c of written) {
    const abs = join(vault, c.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, c.after, 'utf8');
  }

  // --- Commit (C8) ---------------------------------------------------------------
  if (opts.commit && writtenPaths.length > 0) {
    if (preDirty.length > 0) {
      console.warn(
        `warning: refusing to commit; these paths had uncommitted changes before this run: ${preDirty.join(', ')}`,
      );
    } else {
      try {
        const commitResult = createConsolidationCommit(vault, writtenPaths, {
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
  }

  // --- REM pass (Phase 8) --------------------------------------------------------
  // Runs after the commit, including when the commit was refused (C25). A dream error
  // never fails consolidation. The commit above stages only the paths this run wrote, so
  // dream files are never swept into it.
  if (opts.dream && cfg.dreaming.enabled) {
    try {
      const { runRem } = await import('../dreams/rem.ts');
      const rem = await runRem(vault, cfg, {
        consolidation: { ran: true, episodes: processedEpisodes.length, promoted, queued },
      });
      if (rem.skipped) console.log(`dream: skipped (${rem.skipped})`);
      else console.log(`dream: ${rem.samples} sample(s), ${rem.kept} kept, ${rem.pruned} pruned`);
    } catch (e) {
      console.error(`warning: dream pass failed: ${(e as Error).message}`);
    }
  }

  return { promoted, queued, superseded, processedEpisodes, pendingPath: pendingPathFor(vault) };
}

/** Build the versioned pending record for a queued candidate. */
function pendingRecord(
  key: string,
  c: Candidate,
  reason: string,
  queuedAt: number | null,
  priority?: 'reconsolidation',
): PendingRecord {
  return {
    v: PENDING_RECORD_VERSION,
    key,
    subject: c.subject,
    predicate: c.predicate,
    object: c.object,
    episode: c.episodeId,
    by: c.by,
    trust: c.trust,
    origin: c.origin,
    reason,
    queuedAt: queuedAt ?? Date.now(),
    // Omit the field entirely when absent, so a non-prioritized record keeps the v1 shape.
    ...(priority ? { priority } : {}),
  };
}

/**
 * Build the fact a promoted/superseding candidate becomes.
 *
 * - `object` is a wikilink when the object resolved to a note, else a literal. The
 *   wikilink target comes from the vault's parser (`asWikiLink`), never a regex.
 * - `by: agent` with `src:: [[episode]]` — consolidation is the only writer of agent
 *   facts (SCHEMA §4.5), and provenance is mandatory.
 * - `trust` is inherited from the source episode, never hardcoded.
 * - `id` is a content hash (not `Date.now()`), so re-running is idempotent.
 */
export function buildFact(
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
