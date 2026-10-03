// Wikilinks, slugs, globs, hashing — small shared helpers.

import { createHash } from 'node:crypto';
import type { WikiLink } from '../types.ts';

const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

export function parseWikiLinkInner(inner: string): WikiLink {
  let target = inner;
  let alias: string | undefined;
  const pipe = target.indexOf('|');
  if (pipe !== -1) {
    alias = target.slice(pipe + 1).trim();
    target = target.slice(0, pipe);
  }
  let heading: string | undefined;
  const hash = target.indexOf('#');
  if (hash !== -1) {
    heading = target.slice(hash + 1).trim();
    target = target.slice(0, hash);
  }
  target = target.trim().replace(/\.md$/i, '');
  // links may be path-qualified (entities/projects/foo); resolution uses the basename
  const slash = target.lastIndexOf('/');
  if (slash !== -1) target = target.slice(slash + 1);
  const link: WikiLink = { target };
  if (alias) link.alias = alias;
  if (heading) link.heading = heading;
  return link;
}

/** All wikilinks in a string (embeds `![[x]]` included). */
export function findWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) out.push(parseWikiLinkInner(m[2]));
  return out;
}

/** If the whole string is exactly one wikilink, return it. */
export function asWikiLink(s: string): WikiLink | null {
  const t = s.trim();
  const m = /^\[\[([^\[\]\n]+?)\]\]$/.exec(t);
  return m ? parseWikiLinkInner(m[1]) : null;
}

export function normKey(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Maximum length of a slug. A slug becomes a filename component (episode names,
 * phrase node ids), and a path component over 255 bytes raises ENAMETOOLONG. 100 is a
 * conservative cap that leaves room for the date prefix and a collision suffix.
 */
export const SLUG_MAX_LENGTH = 100;

export function slugify(s: string): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= SLUG_MAX_LENGTH) return slug;
  // Truncate and append a deterministic hash of the FULL slug, so two long inputs that
  // share a prefix do not collide on the same filename. The result is exactly
  // SLUG_MAX_LENGTH chars: body + '-' + 8 hex.
  const suffix = createHash('sha256').update(slug).digest('hex').slice(0, 8);
  return `${slug.slice(0, SLUG_MAX_LENGTH - suffix.length - 1)}-${suffix}`;
}

export function shortHash(...parts: (string | number | null)[]): string {
  return createHash('sha256').update(parts.map((p) => String(p)).join('\u0000')).digest('hex').slice(0, 10);
}

/**
 * Minimal glob → RegExp. Supports `**` (any path segments), `*` (within a segment),
 * `?` (one char). Paths are vault-relative with posix separators.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
