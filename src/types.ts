// Shared types. Kept dependency-free and erasable (no enums) so the code runs
// under `node --experimental-strip-types` with no build step.

export type NoteType = 'entity' | 'episode' | 'schema' | 'procedure';
export type SourceKind = 'user' | 'agent' | 'tool' | 'web' | 'import';
export type Trust = 'high' | 'medium' | 'low';
export type GraphMode = 'wikilink' | 'typed' | 'hipporag';
export type QueryMode = GraphMode | 'auto';
export type FactStatus = 'current' | 'superseded' | 'historical';

/** Edge origins. Which origins a mode uses is defined in src/retrieval/modes.ts. */
export type EdgeOrigin =
  | 'contains' // note -> passage (always)
  | 'link' // note -> note via body wikilink
  | 'fact' // note -> note/literal via typed fact line
  | 'provenance' // fact subject note -> source episode (src::)
  | 'triple' // phrase -> phrase, LLM-extracted (hipporag)
  | 'synonym'; // phrase <-> phrase, embedding similarity (hipporag)

export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface Interval {
  /** epoch ms, inclusive; null = unbounded */
  from: number | null;
  /** epoch ms, exclusive; null = unbounded */
  to: number | null;
}

export interface WikiLink {
  target: string;
  alias?: string;
  heading?: string;
}

export interface Fact {
  id: string;
  predicate: string;
  object: { kind: 'link'; link: WikiLink } | { kind: 'literal'; value: string };
  valid: Interval;
  recordedAt: number | null;
  supersededAt: number | null;
  by: SourceKind;
  trust: Trust;
  conf: number;
  src: WikiLink | null;
  status: FactStatus;
  comment: string | null;
  /** 1-based line in the source file, for lint messages */
  line: number;
  raw: string;
}

export interface Passage {
  /** stable within a note: `<noteId>#<index>` */
  id: string;
  heading: string | null;
  level: number;
  text: string;
  kind: 'prose' | 'facts';
}

export interface ParsedNote {
  id: string;
  path: string; // vault-relative, posix separators
  type: NoteType | null;
  title: string;
  frontmatter: Frontmatter;
  aliases: string[];
  tags: string[];
  importance: number;
  created: number | null;
  updated: number | null;
  mtime: number;
  passages: Passage[];
  /** passage = id of the passage the link appears in; null for frontmatter links */
  links: { link: WikiLink; line: number; passage: string | null }[];
  facts: Fact[];
  problems: Problem[];
}

export interface Problem {
  severity: 'error' | 'warning';
  path: string;
  line?: number;
  code: string;
  message: string;
}

export interface RecallHit {
  passageId: string;
  noteId: string;
  path: string;
  title: string;
  heading: string | null;
  text: string;
  score: number;
  components: { graph: number; activation: number; importance: number; seed: number };
  trust: Trust;
}

/**
 * C17: for an as-of query, whether passage prose was read from git history (the note at
 * the last commit <= as-of) or fell back to the current text. `reason` is human-readable
 * so the CLI can say which happened.
 */
export interface AsOfProse {
  fromGit: boolean;
  reason: string;
}

export interface RecallResult {
  query: string;
  modeRequested: QueryMode;
  modeUsed: GraphMode;
  escalations: { from: GraphMode; to: GraphMode; reason: string }[];
  asOf: number | null;
  hits: RecallHit[];
  seeds: { nodeId: string; score: number; via: string[] }[];
  keywordBackend: 'fts5' | 'bm25-js';
  /** C17: set only for an as-of query; absent for a now-query. */
  asOfProse?: AsOfProse;
}
