#!/usr/bin/env node
// Launcher.
//
// From a git checkout it runs the TypeScript CLI directly with Node's built-in type
// stripping (no build step while developing). Node refuses to strip types for files
// under node_modules, so the published package also ships a plain-JS copy in dist/,
// built at pack time (ADR-0012). When dist/ exists and the source tree is inside
// node_modules (npx, npm i -g, a project dependency), the launcher runs that instead.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli', 'main.js');
const source = join(root, 'src', 'cli', 'main.ts');
const installed = root.split(sep).includes('node_modules');

const args =
  installed && existsSync(built)
    ? ['--disable-warning=ExperimentalWarning', built]
    : ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', source];

const r = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
