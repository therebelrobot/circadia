// Episode file writing: naming and persistence.
// Per docs/ROADMAP.md Phase 3: `episodes/YYYY/MM/YYYY-MM-DD-<slug>.md`, collision-safe suffix.
// Per docs/SECURITY.md T3: paths always derived with slugify(), never from caller strings.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from '../vault/util.ts';
import type { Config } from '../config.ts';
import type { SourceKind } from '../types.ts';
import type { Segment } from './segment.ts';

export interface EpisodeResult {
  episodes: {
    path: string; // vault-relative
    title: string;
    boundary: Segment['boundary'];
  }[];
}

export async function writeEpisodes(
  vaultRoot: string,
  _cfg: Config,
  segments: Segment[],
  opts: {
    session?: string;
    by?: SourceKind;
    source?: SourceKind;
  },
): Promise<EpisodeResult> {
  const { by = 'user', source = 'chat', session } = opts;
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  const episodesDir = join(vaultRoot, 'episodes', year, month);

  // Ensure directory exists
  if (!existsSync(episodesDir)) {
    mkdirSync(episodesDir, { recursive: true });
  }

  const result: EpisodeResult = { episodes: [] };

  for (const seg of segments) {
    const baseSlug = slugify(seg.title || 'episode');
    const baseName = `${dateStr}-${baseSlug}`;

    // Collision-safe suffix: append counter if needed
    let fileName = `${baseName}.md`;
    let counter = 0;
    while (existsSync(join(episodesDir, fileName))) {
      counter++;
      fileName = `${dateStr}-${baseSlug}-${counter}.md`;
    }

    const relativePath = `episodes/${year}/${month}/${fileName}`;
    const fullPath = join(episodesDir, fileName);

    // Build episode content with frontmatter
    const frontmatter = [
      '---',
      `title: ${seg.title || 'Untitled'}`,
      `type: episode`,
      `boundary: ${seg.boundary}`,
      `by: ${by}`,
      `source: ${source}`,
    ];

    if (session) {
      frontmatter.push(`session: ${session}`);
    }
    frontmatter.push('---');
    frontmatter.push('');
    frontmatter.push(seg.text);

    const content = frontmatter.join('\n');
    writeFileSync(fullPath, content, 'utf8');

    result.episodes.push({
      path: relativePath,
      title: seg.title || 'Untitled',
      boundary: seg.boundary,
    });
  }

  return result;
}
