#!/usr/bin/env node
// Launcher: runs the TypeScript CLI directly with Node's built-in type stripping.
// Node >= 22.18 strips types by default; the flag keeps older 22.x working.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');
const r = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', main, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
