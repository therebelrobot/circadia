// Decide how much structure to extract for a note (docs/SCHEMA.md §6, docs/RETRIEVAL.md).
// Precedence: note `graph:` frontmatter > first matching config scope rule > defaultExtraction.

import type { Config, ScopeRule } from '../config.ts';
import type { GraphMode, ParsedNote } from '../types.ts';
import { matchesAnyGlob } from '../vault/util.ts';

export const MODE_RANK: Record<GraphMode, number> = { wikilink: 0, typed: 1, hipporag: 2 };

export function ruleMatches(rule: ScopeRule, note: ParsedNote): boolean {
  const m = rule.match;
  if (m.tags && !m.tags.some((t) => note.tags.includes(t))) return false;
  if (m.paths && !matchesAnyGlob(note.path, m.paths)) return false;
  if (m.kinds && !m.kinds.includes(String(note.frontmatter.kind ?? ''))) return false;
  if (m.types && !m.types.includes(String(note.type ?? ''))) return false;
  return true;
}

export function extractionModeFor(note: ParsedNote, config: Config): { mode: GraphMode; reason: string } {
  const g = note.frontmatter.graph;
  if (typeof g === 'string' && g in MODE_RANK) return { mode: g as GraphMode, reason: 'frontmatter' };
  const idx = config.graph.scopes.findIndex((r) => ruleMatches(r, note));
  if (idx !== -1) return { mode: config.graph.scopes[idx].extract, reason: `graph.scopes[${idx}]` };
  return { mode: config.graph.defaultExtraction, reason: 'graph.defaultExtraction' };
}
