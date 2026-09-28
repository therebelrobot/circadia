// Fact-line parser/serializer implementing docs/SCHEMA.md §4.

import type { Fact, FactStatus, Interval, Problem, SourceKind, Trust, WikiLink } from '../types.ts';
import { asWikiLink, shortHash } from './util.ts';
import { parseInstant, parseInterval } from './time.ts';

export const RESERVED_KEYS = new Set(['valid', 'at', 'superseded', 'by', 'src', 'trust', 'conf', 'id']);
const SOURCE_KINDS = new Set<SourceKind>(['user', 'agent', 'tool', 'web', 'import']);
const TRUSTS = new Set<Trust>(['high', 'medium', 'low']);

export const DEFAULT_TRUST: Record<SourceKind, Trust> = {
  user: 'high',
  import: 'medium',
  agent: 'medium',
  tool: 'low',
  web: 'low',
};

export interface RawField {
  key: string;
  value: string;
  /** field was inside a ~~strikethrough~~ span */
  struck: boolean;
}

/**
 * Extract `[key:: value]` fields with balanced-bracket matching, so values may contain
 * wikilinks (`[runs_on:: [[host|alias]]]`). Returns fields and the leftover text.
 */
export function extractFields(s: string): { fields: RawField[]; rest: string; struck: boolean } {
  const fields: RawField[] = [];
  let rest = '';
  let struck = false;
  let inStrike = false;
  let i = 0;
  while (i < s.length) {
    if (s.startsWith('~~', i)) {
      inStrike = !inStrike;
      struck = true;
      i += 2;
      continue;
    }
    if (s[i] === '[' && s[i + 1] !== '[') {
      const head = /^\[([A-Za-z_][\w-]*)::\s?/.exec(s.slice(i));
      if (head) {
        let depth = 0;
        let j = i;
        for (; j < s.length; j++) {
          if (s[j] === '[') depth++;
          else if (s[j] === ']') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth === 0) {
          fields.push({ key: head[1], value: s.slice(i + head[0].length, j).trim(), struck: inStrike });
          i = j + 1;
          continue;
        }
      }
    }
    rest += s[i];
    i++;
  }
  return { fields, rest: rest.replace(/\s+/g, ' ').trim(), struck };
}

export interface FactParseContext {
  noteId: string;
  path: string;
  line: number;
  section: 'facts' | 'history';
  /** fallback system time when the line has no `at::` */
  defaultRecordedAt: number | null;
}

export interface FactParse {
  fact: Fact | null;
  problems: Problem[];
}

export function parseFactLine(rawLine: string, ctx: FactParseContext): FactParse {
  const problems: Problem[] = [];
  const p = (severity: Problem['severity'], code: string, message: string) =>
    problems.push({ severity, path: ctx.path, line: ctx.line, code, message });

  const item = /^\s*[-*+]\s+(.*)$/.exec(rawLine);
  if (!item) {
    if (rawLine.trim()) p('warning', 'fact.not-list-item', 'non-list text in a facts section is ignored');
    return { fact: null, problems };
  }
  let body = item[1].trim();

  let blockId: string | null = null;
  const bid = /\s\^([A-Za-z0-9-]+)\s*$/.exec(' ' + body);
  if (bid) {
    blockId = bid[1];
    body = (' ' + body).slice(0, bid.index).trim();
  }

  const { fields, rest, struck } = extractFields(body);
  if (fields.length === 0) {
    p('warning', 'fact.no-fields', 'list item has no [key:: value] fields; not a fact');
    return { fact: null, problems };
  }

  const claims = fields.filter((f) => !RESERVED_KEYS.has(f.key));
  if (claims.length === 0) {
    p('error', 'fact.no-predicate', 'fact line has metadata but no predicate field');
    return { fact: null, problems };
  }
  if (claims.length > 1) {
    p('error', 'fact.multiple-predicates', `one predicate per line; found ${claims.map((c) => c.key).join(', ')}`);
    return { fact: null, problems };
  }
  const claim = claims[0];
  if (!/^[a-z][a-z0-9_]*$/.test(claim.key)) {
    p('warning', 'fact.predicate-case', `predicate "${claim.key}" should be snake_case`);
  }

  const meta = new Map<string, string>();
  for (const f of fields) {
    if (!RESERVED_KEYS.has(f.key)) continue;
    if (meta.has(f.key)) p('warning', 'fact.duplicate-field', `duplicate field "${f.key}"; last wins`);
    meta.set(f.key, f.value);
  }

  const linkObj = asWikiLink(claim.value);
  const object: Fact['object'] = linkObj
    ? { kind: 'link', link: linkObj }
    : { kind: 'literal', value: claim.value.replace(/^["']|["']$/g, '') };
  if (!linkObj && claim.value.includes('[[')) {
    p('warning', 'fact.mixed-object', 'object mixes text and wikilinks; treated as a literal');
  }

  let valid: Interval = { from: null, to: null };
  if (meta.has('valid')) {
    const iv = parseInterval(meta.get('valid')!.replace(/\s*→\s*/, '..'));
    if (iv) valid = iv;
    else p('error', 'fact.bad-valid', `cannot parse valid:: "${meta.get('valid')}" (want from..to)`);
  }

  let recordedAt = ctx.defaultRecordedAt;
  if (meta.has('at')) {
    const t = parseInstant(meta.get('at')!);
    if (t === null) p('error', 'fact.bad-at', `cannot parse at:: "${meta.get('at')}"`);
    else recordedAt = t;
  }

  let supersededAt: number | null = null;
  if (meta.has('superseded')) {
    supersededAt = parseInstant(meta.get('superseded')!);
    if (supersededAt === null) p('error', 'fact.bad-superseded', `cannot parse superseded:: "${meta.get('superseded')}"`);
  }

  let by: SourceKind = 'user';
  if (meta.has('by')) {
    const v = meta.get('by')! as SourceKind;
    if (SOURCE_KINDS.has(v)) by = v;
    else p('error', 'fact.bad-by', `by:: must be one of ${[...SOURCE_KINDS].join(', ')}`);
  }

  let trust: Trust = DEFAULT_TRUST[by];
  if (meta.has('trust')) {
    const v = meta.get('trust')! as Trust;
    if (TRUSTS.has(v)) trust = v;
    else p('error', 'fact.bad-trust', 'trust:: must be high, medium, or low');
  }

  let conf = 1;
  if (meta.has('conf')) {
    const n = Number(meta.get('conf'));
    if (Number.isFinite(n) && n >= 0 && n <= 1) conf = n;
    else p('error', 'fact.bad-conf', 'conf:: must be a number in [0, 1]');
  }

  let src: WikiLink | null = null;
  if (meta.has('src')) {
    src = asWikiLink(meta.get('src')!);
    if (!src) p('error', 'fact.bad-src', 'src:: must be a single wikilink');
  }
  if (by !== 'user' && by !== 'import' && !src) {
    p('error', 'fact.missing-src', `facts with by:: ${by} must cite src:: [[episode]] (source monitoring)`);
  }

  let comment: string | null = null;
  if (rest) {
    const c = /^(?:—|--)\s*(.*)$/.exec(rest);
    if (c) comment = c[1] || null;
    else p('warning', 'fact.stray-text', `stray text outside fields: "${rest.slice(0, 40)}" (prefix comments with —)`);
  }

  let status: FactStatus = 'current';
  if (struck || supersededAt !== null) status = 'superseded';
  else if (ctx.section === 'history') status = 'historical';
  if (struck && supersededAt === null) {
    p('warning', 'fact.struck-no-date', 'struck-through fact should carry [superseded:: date]');
  }
  if (status === 'current' && ctx.section === 'history') {
    p('warning', 'fact.current-in-history', 'fact in History has no end; add valid:: ..to or superseded::');
  }

  const objectKey = object.kind === 'link' ? `[[${object.link.target}]]` : object.value;
  const id = blockId ?? meta.get('id') ?? `f-${shortHash(ctx.noteId, claim.key, objectKey, valid.from)}`;

  return {
    fact: {
      id,
      predicate: claim.key,
      object,
      valid,
      recordedAt,
      supersededAt,
      by,
      trust,
      conf,
      src,
      status,
      comment,
      line: ctx.line,
      raw: rawLine,
    },
    problems,
  };
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Serialize a fact back to canonical line form (used by consolidation in Phase 4). */
export function formatFact(f: Omit<Fact, 'line' | 'raw' | 'trust'> & { trust?: Trust }): string {
  const obj = f.object.kind === 'link' ? `[[${f.object.link.target}]]` : f.object.value;
  const claim = `[${f.predicate}:: ${obj}]`;
  const parts: string[] = [];
  const validStr =
    f.valid.from === null && f.valid.to === null
      ? null
      : `${f.valid.from !== null ? fmtDate(f.valid.from) : ''}..${f.valid.to !== null ? fmtDate(f.valid.to) : ''}`;
  const head = validStr ? `${claim} [valid:: ${validStr}]` : claim;
  parts.push(f.status === 'superseded' ? `~~${head}~~` : head);
  if (f.recordedAt !== null) parts.push(`[at:: ${fmtDate(f.recordedAt)}]`);
  if (f.supersededAt !== null) parts.push(`[superseded:: ${fmtDate(f.supersededAt)}]`);
  parts.push(`[by:: ${f.by}]`);
  if (f.src) parts.push(`[src:: [[${f.src.target}]]]`);
  if (f.trust && f.trust !== DEFAULT_TRUST[f.by]) parts.push(`[trust:: ${f.trust}]`);
  if (f.conf !== 1) parts.push(`[conf:: ${f.conf}]`);
  if (f.comment) parts.push(`— ${f.comment}`);
  parts.push(`^${f.id}`);
  return `- ${parts.join(' ')}`;
}
