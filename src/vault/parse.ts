// Parse one markdown note into the structure the indexer consumes (docs/SCHEMA.md §2–4).

import type { Config } from '../config.ts';
import type { Fact, NoteType, ParsedNote, Passage, Problem, WikiLink, FrontmatterValue } from '../types.ts';
import { asStringList, parseFrontmatter, splitFrontmatter } from './frontmatter.ts';
import { parseFactLine } from './facts.ts';
import { parseInstant } from './time.ts';
import { findWikiLinks } from './util.ts';

const NOTE_TYPES = new Set<NoteType>(['entity', 'episode', 'schema', 'procedure']);

const REQUIRED: Record<NoteType, string[]> = {
  entity: ['kind'],
  episode: ['started', 'source', 'by'],
  schema: ['derived', 'sources', 'generated'],
  procedure: [],
};

function linksInValue(v: FrontmatterValue): WikiLink[] {
  if (typeof v === 'string') return findWikiLinks(v);
  if (Array.isArray(v)) return v.flatMap(linksInValue);
  return [];
}

export function parseNote(path: string, text: string, mtime: number, config: Config): ParsedNote {
  const problems: Problem[] = [];
  const warn = (code: string, message: string, line?: number) =>
    problems.push({ severity: 'warning', path, line, code, message });
  const err = (code: string, message: string, line?: number) =>
    problems.push({ severity: 'error', path, line, code, message });

  const { frontmatter: fmSrc, body, bodyLineOffset } = splitFrontmatter(text);
  const fmParse = fmSrc !== null ? parseFrontmatter(fmSrc) : { data: {}, errors: [] };
  for (const e of fmParse.errors) err('frontmatter.parse', e.message, e.line);
  const fm = fmParse.data;

  const base = path.split('/').pop()!.replace(/\.md$/i, '');
  const id = typeof fm.id === 'string' && fm.id ? fm.id : base;

  let type: NoteType | null = null;
  if (fm.type === undefined) err('note.missing-type', 'frontmatter must set type: entity | episode | schema | procedure');
  else if (typeof fm.type === 'string' && NOTE_TYPES.has(fm.type as NoteType)) type = fm.type as NoteType;
  else err('note.bad-type', `unknown type "${String(fm.type)}"`);

  if (type) {
    for (const k of REQUIRED[type]) {
      if (fm[k] === undefined || fm[k] === null || fm[k] === '') err('note.missing-field', `type: ${type} requires "${k}"`);
    }
    const folderHint: Record<NoteType, string> = {
      entity: 'entities/',
      episode: 'episodes/',
      schema: 'schemas/',
      procedure: 'procedures/',
    };
    if (!path.startsWith(folderHint[type])) warn('note.folder', `type: ${type} notes normally live under ${folderHint[type]}`);
  }

  let importance = 0.5;
  if (fm.importance !== undefined && fm.importance !== null) {
    if (typeof fm.importance === 'number' && fm.importance >= 0 && fm.importance <= 1) importance = fm.importance;
    else err('note.bad-importance', 'importance must be a number in [0, 1]');
  }

  // encoding time: created, else an episode's `started`, else a schema's `generated`
  const created = parseInstant((fm.created ?? fm.started ?? fm.generated) as string | undefined);
  const updated = parseInstant(fm.updated as string | undefined);
  if (fm.created !== undefined && created === null) err('note.bad-date', 'created is not a valid date');
  if (fm.updated !== undefined && updated === null) err('note.bad-date', 'updated is not a valid date');

  if (fm.graph !== undefined && !['wikilink', 'typed', 'hipporag'].includes(String(fm.graph))) {
    err('note.bad-graph', 'graph must be wikilink, typed, or hipporag');
  }

  const factsH = config.vault.factsHeading.toLowerCase();
  const historyH = config.vault.historyHeading.toLowerCase();
  const defaultRecordedAt = updated ?? created ?? mtime;

  const passages: Passage[] = [];
  const links: { link: WikiLink; line: number; passage: string | null }[] = [];
  const facts: Fact[] = [];
  const factLines: string[] = [];

  let title: string | null = typeof fm.title === 'string' ? fm.title : null;
  let cur: { heading: string | null; level: number; lines: string[] } = { heading: null, level: 0, lines: [] };
  let factSection: 'facts' | 'history' | null = null;
  let inFence = false;

  const flush = () => {
    const text = cur.lines.join('\n').trim();
    if (text) {
      passages.push({ id: `${id}#${passages.length}`, heading: cur.heading, level: cur.level, text, kind: 'prose' });
    }
  };

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = bodyLineOffset + i + 1;

    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = inFence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);

    if (h && h[1].length <= 3) {
      const level = h[1].length;
      const text = h[2];
      if (level === 1 && title === null) title = text;
      if (level <= 2) {
        const name = text.toLowerCase();
        factSection = level === 2 && name === factsH ? 'facts' : level === 2 && name === historyH ? 'history' : null;
      }
      if (factSection) {
        flush();
        cur = { heading: text, level, lines: [] };
        continue;
      }
      flush();
      cur = { heading: text, level, lines: [line] };
      continue;
    }

    if (factSection && !inFence) {
      if (!line.trim()) continue;
      const r = parseFactLine(line, {
        noteId: id,
        path,
        line: lineNo,
        section: factSection,
        defaultRecordedAt,
      });
      problems.push(...r.problems);
      if (r.fact) facts.push(r.fact);
      factLines.push(line.trim());
      continue;
    }

    cur.lines.push(line);
    if (!inFence) {
      for (const link of findWikiLinks(line)) links.push({ link, line: lineNo, passage: `${id}#${passages.length}` });
    }
  }
  flush();

  if (factLines.length) {
    passages.push({
      id: `${id}#facts`,
      heading: config.vault.factsHeading,
      level: 2,
      text: factLines.join('\n'),
      kind: 'facts',
    });
  }

  for (const [k, v] of Object.entries(fm)) {
    if (k === 'id' || k === 'title') continue;
    for (const link of linksInValue(v)) links.push({ link, line: 1, passage: null });
  }

  const ids = new Set<string>();
  for (const f of facts) {
    if (ids.has(f.id)) err('fact.duplicate-id', `duplicate fact id ${f.id}`, f.line);
    ids.add(f.id);
  }

  return {
    id,
    path,
    type,
    title: title ?? id,
    frontmatter: fm,
    aliases: asStringList(fm.aliases),
    tags: asStringList(fm.tags).map((t) => t.replace(/^#/, '')),
    importance,
    created,
    updated,
    mtime,
    passages,
    links,
    facts,
    problems,
  };
}
