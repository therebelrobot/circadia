// ADR-0012: the published package runs a plain-JS build from dist/, because Node refuses
// to strip types under node_modules. This builds into a fake node_modules install and runs
// the real launcher from there, so a TS construct that type stripping accepts but `tsc`
// emit rejects (or a broken launcher branch) fails CI instead of failing `npx circadia`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

test('publish build runs from inside node_modules (npx / global install)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'circadia-build-'));
  try {
    const pkg = join(tmp, 'node_modules', 'circadia');
    mkdirSync(pkg, { recursive: true });
    const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');
    const build = spawnSync(
      process.execPath,
      [tsc, '-p', join(REPO, 'tsconfig.build.json'), '--outDir', join(pkg, 'dist')],
      { encoding: 'utf8' },
    );
    assert.equal(build.status, 0, `tsc emit failed:\n${build.stdout}${build.stderr}`);
    assert.ok(existsSync(join(pkg, 'dist', 'cli', 'main.js')));

    cpSync(join(REPO, 'bin'), join(pkg, 'bin'), { recursive: true });
    // Mirror package.json "files": init copies templates/ and docs/SCHEMA.md into a vault.
    cpSync(join(REPO, 'templates'), join(pkg, 'templates'), { recursive: true });
    cpSync(join(REPO, 'docs'), join(pkg, 'docs'), { recursive: true });
    // Deliberately no src/: if the launcher fell back to type stripping, this would fail.

    const launcher = join(pkg, 'bin', 'circadia.mjs');
    const help = spawnSync(process.execPath, [launcher, '--help'], { encoding: 'utf8' });
    // `--help` currently exits 1 in a checkout too, so assert on output, not status.
    assert.doesNotMatch(help.stderr, /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
    assert.match(help.stdout, /usage: circadia <command>/);

    const vault = join(tmp, 'vault');
    const init = spawnSync(process.execPath, [launcher, 'init', vault], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(vault, '_meta', 'templates', 'entity.md')), 'init copies templates');
    assert.doesNotMatch(init.stderr, /ExperimentalWarning/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
