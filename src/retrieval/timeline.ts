// `palimpsest timeline <entity>`: every fact about an entity (and its
// inverses), ordered by world time, including superseded facts. Facts are
// never deleted, so the timeline is the entity's full bi-temporal history.

import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import type { FactStatus, Trust } from '../types.ts';
import { resolveName } from './relate.ts';

export interface TimelineEntry {
  /** the entity this timeline is about */
  entity: string;
  /** the fact's subject note (the entity, or the other end of an inverse) */
  subject: string;
  /** note path of the subject */
  notePath: string | null;
  /** note title of the subject */
  noteTitle: string | null;
  /** predicate as written; when the entity is the object, the inverse name */
  predicate: string;
  /** true when the entity is the object and the predicate shown is the inverse */
  inverse: boolean;
  /** object: note title when the object is a note, else the literal */
  object: string;
  /** object note id, when the object is a note */
  objectId: string | null;
  valid_from: number | null;
  valid_to: number | null;
  recorded_at: number | null;
  expired_at: number | null;
  status: FactStatus;
  source_kind: string | null;
  trust: Trust | null;
  /** title of the provenance episode (src::), when present */
  provenance: string | null;
  fact_id: string | null;
}

interface FactRow {
  id: number;
  src: string;
  dst: string | null;
  value: string | null;
  type: string;
  valid_from: number | null;
  valid_to: number | null;
  recorded_at: number | null;
  expired_at: number | null;
  source_kind: string | null;
  trust: string | null;
  provenance: string | null;
  fact_id: string | null;
  declared_in: string | null;
  subject_path: string | null;
  subject_title: string | null;
  object_title: string | null;
  prov_title: string | null;
}

/**
 * Every fact edge where the entity is the subject, plus every fact edge where
 * the entity is the object (shown through the predicate's inverse name from
 * predicates.defs). Ordered by valid_from ASC with NULLs first, then
 * recorded_at, so the timeline reads as the entity's history.
 */
export function timeline(db: DatabaseSync, entityId: string, cfg: Config): TimelineEntry[] {
  const r = resolveName(db, entityId);
  if (!r) throw new Error(`"${entityId}" does not resolve to a note (no matching id, alias, or title)`);
  const id = r.id;

  const rows = db
    .prepare(
      `SELECT e.id, e.src, e.dst, e.value, e.type, e.valid_from, e.valid_to, e.recorded_at, e.expired_at,
              e.source_kind, e.trust, e.provenance, e.fact_id, e.declared_in,
              s.path AS subject_path, s.title AS subject_title,
              o.title AS object_title, p.title AS prov_title
       FROM edges e
       LEFT JOIN nodes s ON s.id = e.src
       LEFT JOIN nodes o ON o.id = e.dst
       LEFT JOIN nodes p ON p.id = e.provenance
       WHERE e.origin = 'fact' AND (e.src = ? OR e.dst = ?)
       ORDER BY e.valid_from, e.recorded_at, e.id`,
    )
    .all(id, id) as unknown as FactRow[];

  const out: TimelineEntry[] = [];
  for (const row of rows) {
    const isObject = row.dst === id;
    const pred = cfg.predicates.defs[row.type];
    const inverse = isObject && pred?.inverse ? pred.inverse : row.type;
    const status: FactStatus = row.expired_at !== null ? 'superseded' : row.valid_to !== null ? 'historical' : 'current';
    out.push({
      entity: id,
      subject: row.src,
      notePath: row.subject_path,
      noteTitle: row.subject_title,
      predicate: inverse,
      inverse: isObject && pred?.inverse !== undefined,
      object: isObject ? row.subject_title ?? row.src : row.dst !== null ? row.object_title ?? row.dst : (row.value ?? ''),
      objectId: isObject ? row.src : row.dst,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      recorded_at: row.recorded_at,
      expired_at: row.expired_at,
      status,
      source_kind: row.source_kind,
      trust: (row.trust as Trust | null) ?? null,
      provenance: row.prov_title,
      fact_id: row.fact_id,
    });
  }
  return out;
}
