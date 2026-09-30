// Minimal, byte-preserving edit of an episode's `consolidated:` frontmatter field.
//
// Why this exists: consolidation must mark an episode as processed without touching
// anything else in the file. Reserializing the whole frontmatter (the previous approach)
// dropped quotes, comments, and block lists, and could drop the `---` fences entirely,
// corrupting the note. Episodes are append-only; the only permitted mutation is setting
// `consolidated:`. This function changes exactly one line and leaves every other byte
// unchanged. It is pure: string in, string out, no I/O, no frontmatter serializer.

/**
 * True when `raw` begins with a fenced frontmatter block (`---` … `---`/`...`).
 * Callers use this to warn instead of silently no-op'ing on a malformed episode.
 */
export function hasFencedFrontmatter(raw: string): boolean {
  const src = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = src.split('\n');
  if (lines[0]?.replace(/\r$/, '') !== '---') return false;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/\r$/, '');
    if (t === '---' || t === '...') return true;
  }
  return false;
}

/**
 * Set the `consolidated:` date in an episode's fenced frontmatter, changing exactly one
 * line and preserving every other byte (quotes, comments, block lists, line endings).
 *
 * - If a `consolidated:` line already exists inside the fence, its value is replaced.
 * - Otherwise a single `consolidated: <date>` line is inserted before the closing fence.
 * - If there is no fenced frontmatter block, the input is returned unchanged.
 *
 * Idempotent: applying it twice with the same date yields byte-identical output.
 */
export function setConsolidatedDate(raw: string, date: string): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const src = bom ? raw.slice(1) : raw;
  const lines = src.split('\n');

  if (lines[0]?.replace(/\r$/, '') !== '---') return raw;

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].replace(/\r$/, '');
    if (t === '---' || t === '...') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return raw;

  let existing = -1;
  for (let i = 1; i < closeIdx; i++) {
    if (/^consolidated\s*:/.test(lines[i])) {
      existing = i;
      break;
    }
  }

  // Match the closing fence's line ending so we don't introduce mixed EOLs.
  const eol = lines[closeIdx].endsWith('\r') ? '\r' : '';
  const newLine = `consolidated: ${date}${eol}`;

  if (existing !== -1) {
    lines[existing] = newLine;
  } else {
    lines.splice(closeIdx, 0, newLine);
  }

  return bom + lines.join('\n');
}
