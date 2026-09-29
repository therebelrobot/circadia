// Event segmentation: split long transcripts at topic shifts.
// Per docs/ROADMAP.md Phase 3, use embedding-distance jumps as prediction-error proxy.
// Fall back to heading/turn boundaries when no embeddings available.

import type { SourceKind } from '../types.ts';

export interface Segment {
  text: string;
  boundary: 'heading' | 'turn' | 'embedding-jump' | 'none';
  by?: SourceKind;
  source?: SourceKind;
  title?: string;
  date?: string; // ISO date (YYYY-MM-DD)
}

export function segmentText(
  text: string,
  opts: {
    by?: SourceKind;
    source?: SourceKind;
    embeddingThreshold?: number; // cosine distance threshold for jumps
  } = {},
): Segment[] {
  const by: SourceKind | undefined = opts.by ?? undefined;
  const source: SourceKind | undefined = opts.source ?? undefined;
  // embeddingThreshold reserved for future embedding-based segmentation
  const _ = opts.embeddingThreshold;

  // First, try to extract a title from the first line
  const firstLine = text.split('\n')[0];
  const title = firstLine.startsWith('# ') ? firstLine.slice(2).trim() : firstLine.trim();

  // Detect headings (markdown-style)
  const headingLines: number[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^#+\s+/.test(lines[i])) {
      headingLines.push(i);
    }
  }

  // If we have headings, split at them
  if (headingLines.length > 0) {
    const segments: Segment[] = [];
    for (let i = 0; i < headingLines.length; i++) {
      const start = headingLines[i];
      const end = i < headingLines.length - 1 ? headingLines[i + 1] : lines.length;
      const section = lines.slice(start, end).join('\n');
      const heading = section.match(/^#+\s+(.+)$/m);
      segments.push({
        text: section,
        boundary: 'heading',
        by,
        source,
        title: heading ? heading[1].trim() : title,
      });
    }
    return segments;
  }

  // Check for turn-based structure (speaker labels)
  const turnPattern = /^(?:[A-Z][a-z]+:|[\w\s]+:)/;
  const turnIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (turnPattern.test(lines[i])) {
      turnIndices.push(i);
    }
  }

  if (turnIndices.length > 10) { // If we have many turns, split by topic blocks
    const segments: Segment[] = [];
    const blockSize = Math.max(5, Math.floor(turnIndices.length / 5));
    for (let i = 0; i < turnIndices.length; i += blockSize) {
      const start = turnIndices[i];
      const end = i + blockSize < turnIndices.length ? turnIndices[i + blockSize] : lines.length;
      const section = lines.slice(start, end).join('\n');
      segments.push({
        text: section,
        boundary: 'turn',
        by,
        source,
        title,
      });
    }
    if (segments.length === 0) {
      return [{ text, boundary: 'none', by, source, title }];
    }
    return segments;
  }

  // No structural cues - return as single segment
  return [{ text, boundary: 'none', by, source, title }];
}
