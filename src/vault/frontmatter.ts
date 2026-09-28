// Zero-dependency parser for the frontmatter YAML subset defined in docs/SCHEMA.md §2.
// Deliberately small: flat maps, scalars, inline lists, block lists, comments.

import type { Frontmatter, FrontmatterValue } from '../types.ts';

export interface SplitResult {
  frontmatter: string | null;
  body: string;
  /** number of lines consumed by frontmatter incl. fences (0 if none) */
  bodyLineOffset: number;
}

export function splitFrontmatter(text: string): SplitResult {
  const src = text.replace(/^﻿/, '');
  if (!src.startsWith('---\n') && !src.startsWith('---\r\n')) {
    return { frontmatter: null, body: src, bodyLineOffset: 0 };
  }
  const lines = src.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      return {
        frontmatter: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
        bodyLineOffset: i + 1,
      };
    }
  }
  // unterminated fence: treat whole file as body
  return { frontmatter: null, body: src, bodyLineOffset: 0 };
}

export function parseScalar(raw: string): FrontmatterValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (s.startsWith('[') && s.endsWith(']') && !s.startsWith('[[')) return parseInlineList(s);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Split `[a, "b, c", d]` respecting quotes and nested wikilink brackets. */
export function parseInlineList(s: string): FrontmatterValue[] {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === ']') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => parseScalar(p));
}

export interface FrontmatterParse {
  data: Frontmatter;
  errors: { line: number; message: string }[];
}

export function parseFrontmatter(src: string): FrontmatterParse {
  const data: Frontmatter = {};
  const errors: { line: number; message: string }[] = [];
  const lines = src.split(/\r?\n/);
  let listKey: string | null = null;
  const bareKeys = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 2; // +1 for 1-based, +1 for opening fence
    if (/^\s*(#.*)?$/.test(line)) continue;

    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as FrontmatterValue[]).push(parseScalar(item[1]));
      continue;
    }

    const kv = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line);
    if (kv) {
      const key = kv[1];
      const rest = (kv[2] ?? '').trim();
      if (rest === '') {
        data[key] = [];
        listKey = key;
        bareKeys.add(key);
      } else {
        data[key] = parseScalar(rest);
        listKey = null;
      }
      continue;
    }

    if (/^\s+\S/.test(line)) {
      errors.push({ line: lineNo, message: 'nested maps and multi-line values are not supported' });
    } else {
      errors.push({ line: lineNo, message: `unparseable frontmatter line: ${line.slice(0, 60)}` });
    }
    listKey = null;
  }
  // `key:` with no following block items means null, not an empty list
  for (const k of bareKeys) {
    const v = data[k];
    if (Array.isArray(v) && v.length === 0) data[k] = null;
  }
  return { data, errors };
}

export function asStringList(v: FrontmatterValue | undefined): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.filter((x) => x !== null).map((x) => String(x));
  return [String(v)];
}
