// Entity resolution: match candidate subjects/objects to existing notes by id, alias, or title.

import { DatabaseSync } from 'node:sqlite';
import { slugify } from '../vault/util.ts';

export interface NoteRef {
  id: string;
  title: string;
  path: string;
}

/**
 * Resolve a candidate name (subject or object) to an existing note.
 * Uses the names table which stores lower-cased id/alias/title entries.
 * Priority: exact id match > exact alias match > title match (case-insensitive).
 */
export function resolveEntity(db: DatabaseSync, name: string): NoteRef | null {
  const normalized = name.toLowerCase();
  // Try id match first (tier 0)
  let row = db.prepare('SELECT node_id FROM names WHERE name = ? AND tier = 0').get(normalized) as { node_id: string } | undefined;
  if (row) {
    const note = db.prepare('SELECT id, title, path FROM nodes WHERE id = ?').get(row.node_id) as NoteRef | undefined;
    return note ?? null;
  }
  // Try alias match (tier 1)
  row = db.prepare('SELECT node_id FROM names WHERE name = ? AND tier = 1').get(normalized) as { node_id: string } | undefined;
  if (row) {
    const note = db.prepare('SELECT id, title, path FROM nodes WHERE id = ?').get(row.node_id) as NoteRef | undefined;
    return note ?? null;
  }
  // Try title match (tier 2)
  row = db.prepare('SELECT node_id FROM names WHERE name = ? AND tier = 2').get(normalized) as { node_id: string } | undefined;
  if (row) {
    const note = db.prepare('SELECT id, title, path FROM nodes WHERE id = ?').get(row.node_id) as NoteRef | undefined;
    return note ?? null;
  }
  return null;
}

/**
 * Check if a note with the given title/alias already exists.
 * Returns true if a matching entity note exists.
 */
export function entityExists(db: DatabaseSync, name: string): boolean {
  return resolveEntity(db, name) !== null;
}

/**
 * Build a minimal entity note for a subject the vault has not seen before. The id is the
 * file stem, so `resolveEntity` finds it (tier 0) on the next run. Used when additive
 * corroboration promotes a claim about a new subject, or a reviewer accepts one.
 */
export function deriveEntityNote(subject: string, today: string): { id: string; path: string; content: string } {
  const id = slugify(subject) || 'entity';
  const path = `entities/${id}.md`;
  const content =
    `---\ntype: entity\nid: ${id}\nkind: concept\naliases: []\ntags: []\n` +
    `created: ${today}\nupdated: ${today}\nimportance: 0.5\n---\n# ${subject}\n\n`;
  return { id, path, content };
}
