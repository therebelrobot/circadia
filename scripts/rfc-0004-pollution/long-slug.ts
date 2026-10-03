import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { execFileSync } from 'node:child_process';
const R=fileURLToPath(new URL('../..', import.meta.url));
const { loadConfig } = await import(join(R,'src/config.ts')); const { segmentText } = await import(join(R,'src/episodes/segment.ts')); const { writeEpisodes } = await import(join(R,'src/episodes/episode.ts'));
const v = mkdtempSync(join(tmpdir(),'circadia-long-')); execFileSync(process.execPath,[join(R,'bin/circadia.mjs'),'init',v],{stdio:'ignore'});
const text = 'The billing api payment retry policy ' + 'and the idempotency key handling '.repeat(8) + 'needs review.';
try { const r = await writeEpisodes(v, loadConfig(v), segmentText(text,{by:'agent'}), {by:'agent'}); console.log('ok', r.episodes[0].path.length); }
catch (e) { console.log('FAILED:', (e as NodeJS.ErrnoException).code, text.length, 'chars'); }
