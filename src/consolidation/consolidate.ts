// Consolidation (Phase 4 "sleep" job): episode replay → candidate extraction → entity resolution → schema-fit gate → apply.
// Follows src/consolidation/README.md contract and docs/ROADMAP.md Phase 4.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openIndex } from '../index/db.ts';
import type { Config } from '../config.ts';
import type { ParsedNote } from '../types.ts';
import { parseVault } from '../index/indexer.ts';
import { parseFrontmatter } from '../vault/frontmatter.ts';
import { extractCandidates, type Candidate } from './candidate.ts';
import { resolveEntity } from './entity.ts';
import { evaluateGate } from './schema.ts';
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

  // Collect all candidates
  const allCandidates: Candidate[] = [];
  for (const ep of episodes) {
    if (cfg.extraction.provider === 'none') {
      // Without extraction, skip candidate generation
      continue;
    }
    const candidates = await extractCandidates(ep, cfg);
    allCandidates.push(...candidates);
  }

  // Apply schema-fit gate
  const pendingPath = join(vault, '.circadia', 'pending.jsonl');
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

  // Mark episodes as consolidated
  const today = new Date().toISOString().slice(0, 10);
  for (const ep of episodes) {
    if (opts.dryRun) {
      processedEpisodes.push(ep.path);
      continue;
    }
    const raw = readFileSync(join(vault, ep.path), 'utf8');
    const { frontmatter: fmSrc, body } = splitFrontmatter(raw);
    const fm = parseFrontmatter(fmSrc ?? '').data;
    fm.consolidated = today;
    const fmOut = serializeFrontmatter(fm);
    writeFileSync(join(vault, ep.path), fmOut + body, 'utf8');
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

  db.close();

  return { promoted, queued, superseded, processedEpisodes, pendingPath };
}

// Simple frontmatter split/serialize for episode updates
function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}
