#!/usr/bin/env node
// npm-preflight.ts — check that a package is ready for npm trusted publishing
// with provenance, then print the exact commands the HUMAN runs next.
//
// It reads and queries; it never publishes, logs in, or changes trust settings.
// Those steps need the maintainer's 2FA and are theirs to run.
//
// Usage (from the package root):
//   node npm-preflight.ts [--mode direct|stage] [--env <github-environment>] [--workflow <file.yml>] [--offline] [--json]
//
// --mode     direct (default): CI runs `npm publish`. stage: CI runs `npm stage publish`
//            and every release waits for a 2FA approval.
// --env      GitHub environment the publish job uses (auto-detected from the workflow).
// --workflow Workflow filename (auto-detected: the file in .github/workflows that runs npm publish).
// --offline  Skip registry and gh lookups.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Status = 'PASS' | 'WARN' | 'FAIL' | 'INFO';
type Check = { status: Status; id: string; msg: string };

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MODE = (opt('mode') ?? 'direct') as 'direct' | 'stage';
const OFFLINE = argv.includes('--offline');
const JSON_OUT = argv.includes('--json');
if (MODE !== 'direct' && MODE !== 'stage') {
  console.error('--mode must be direct or stage');
  process.exit(2);
}

const checks: Check[] = [];
const add = (status: Status, id: string, msg: string) => checks.push({ status, id, msg });

function run(cmd: string, args: string[]): { ok: boolean; out: string; err: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return { ok: true, out: out.trim(), err: '' };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: (x.stdout ?? '').toString().trim(), err: (x.stderr ?? x.message).toString().trim() };
  }
}

const ver = (s: string) => s.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
const gte = (a: string, b: string) => {
  const [x, y] = [ver(a), ver(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return true;
};

// Reduce any GitHub URL form to "owner/repo".
function ghSlug(url: string | undefined): string | null {
  if (!url) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?(?:#.*)?$/.exec(url.trim()) ?? /^github:([^/]+)\/(.+)$/.exec(url.trim()) ?? /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---- tool versions --------------------------------------------------------
const nodeV = process.versions.node;
add(gte(nodeV, '22.14.0') ? 'PASS' : 'WARN', 'node', `local Node ${nodeV} (trusted publishing needs >= 22.14.0 in CI; the template uses latest)`);
const npmV = run('npm', ['--version']).out;
if (!npmV) add('FAIL', 'npm', 'npm not found on PATH');
else if (gte(npmV, '11.15.0')) add('PASS', 'npm', `local npm ${npmV} (>= 11.15.0 needed for \`npm trust\` and \`npm stage approve\`)`);
else add('WARN', 'npm', `local npm ${npmV} is older than 11.15.0: \`npm trust\` may be missing, and older versions have been reported to accept trust commands without the --allow-* flag and create an entry with no publish permission. Upgrade: npm install -g npm@latest`);

// ---- package.json ---------------------------------------------------------
if (!existsSync('package.json')) {
  console.error('FAIL  [package.json] no package.json in the current directory; run from the package root');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const name: string = pkg.name ?? '';
const scoped = name.startsWith('@');

if (!name) add('FAIL', 'name', 'package.json has no name');
else if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) add('FAIL', 'name', `"${name}" is not a valid npm package name`);
else add('PASS', 'name', name);

if (!pkg.version) add('FAIL', 'version', 'package.json has no version');
if (pkg.private === true) add('FAIL', 'private', '"private": true blocks publishing; remove it if this package should ship');

if (scoped) {
  const access = pkg.publishConfig?.access;
  if (access === 'public') add('PASS', 'access', 'publishConfig.access is "public" (scoped packages default to restricted)');
  else add('FAIL', 'access', `scoped package without publishConfig.access "public": the first publish would try to create a private (paid) package. Add "publishConfig": { "access": "public" }`);
}

if (pkg.publishConfig?.provenance === false) add('WARN', 'provenance', 'publishConfig.provenance is false; trusted publishing would skip the attestation');
if (pkg.publishConfig?.registry && !/registry\.npmjs\.org/.test(pkg.publishConfig.registry)) {
  add('FAIL', 'registry', `publishConfig.registry is ${pkg.publishConfig.registry}; trusted publishing is for registry.npmjs.org`);
}

for (const hook of ['preinstall', 'install', 'postinstall']) {
  if (pkg.scripts?.[hook]) add('WARN', 'install-scripts', `"${hook}" runs on every consumer's machine; many security-minded users install with --ignore-scripts, so ship without it if you can`);
}

if (!pkg.files && !existsSync('.npmignore')) add('WARN', 'files', 'no "files" allowlist and no .npmignore: everything not gitignored ships. Prefer a "files" array');
if (!pkg.license) add('WARN', 'license', 'no license field');

// ---- repository.url vs git remote ------------------------------------------
const repoField = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
const repoSlug = ghSlug(repoField);
const remote = run('git', ['remote', 'get-url', 'origin']);
const remoteSlug = remote.ok ? ghSlug(remote.out) : null;
const canonical = remoteSlug ? `git+https://github.com/${remoteSlug}.git` : null;

if (!remoteSlug) add('WARN', 'git-remote', 'no GitHub origin remote found; cannot cross-check repository.url');
if (!repoField) {
  add('FAIL', 'repository', `package.json has no repository.url. npm matches it against the publishing repo. Set: "repository": { "type": "git", "url": "${canonical ?? 'git+https://github.com/<owner>/<repo>.git'}" }`);
} else if (remoteSlug && repoSlug?.toLowerCase() !== remoteSlug.toLowerCase()) {
  add('FAIL', 'repository', `repository.url points at ${repoSlug ?? repoField} but origin is ${remoteSlug}. Publishing from GitHub requires them to match (common after a fork or rename)`);
} else if (remoteSlug && repoSlug !== remoteSlug) {
  add('WARN', 'repository', `repository.url matches origin only case-insensitively (${repoSlug} vs ${remoteSlug}); npm's fields are case-sensitive, so copy the exact casing`);
} else if (repoSlug) {
  add('PASS', 'repository', `repository.url -> ${repoSlug}`);
}

// ---- workflow ---------------------------------------------------------------
let workflow = opt('workflow');
let envName = opt('env');
const wfDir = '.github/workflows';
if (existsSync(wfDir)) {
  const publishers = readdirSync(wfDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .filter((f) => /^\s*[^#\n]*\bnpm\s+(stage\s+)?publish\b/m.test(readFileSync(join(wfDir, f), 'utf8')));
  if (!workflow) {
    if (publishers.length === 1) workflow = publishers[0];
    else if (publishers.length > 1) add('WARN', 'workflow', `several workflows run npm publish (${publishers.join(', ')}); pass --workflow to choose. The trusted publisher names exactly one`);
  }
  if (workflow) {
    const wfPath = join(wfDir, workflow);
    if (!existsSync(wfPath)) add('FAIL', 'workflow', `${wfPath} does not exist`);
    else {
      const wf = readFileSync(wfPath, 'utf8');
      add('PASS', 'workflow', `publishing workflow: ${workflow}`);
      if (!/id-token:\s*write/.test(wf)) add('FAIL', 'id-token', `${workflow} never grants id-token: write`);
      if (/secrets\.NPM_TOKEN|NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets/.test(wf)) add('WARN', 'npm-token', `${workflow} still passes an npm token secret; remove it once OIDC works`);
      const stageInWf = /^\s*[^#\n]*\bnpm\s+stage\s+publish\b/m.test(wf);
      if (MODE === 'stage' && !stageInWf) add('FAIL', 'mode', `--mode stage but ${workflow} runs plain npm publish`);
      if (MODE === 'direct' && stageInWf) add('WARN', 'mode', `${workflow} runs npm stage publish; use --mode stage so the trust command allows it`);
      if (/workflow_call/.test(wf)) add('WARN', 'reusable', 'workflow_call: npm checks the CALLER workflow filename; name the caller in the trusted publisher');
      const envMatch = /^\s+environment:\s*(?:name:\s*)?['"]?([\w-]+)/m.exec(wf);
      if (!envName && envMatch) envName = envMatch[1];
    }
  }
} else {
  add('FAIL', 'workflow', 'no .github/workflows directory; add templates/npm-publish.yml first');
}
if (!workflow) add('FAIL', 'workflow', 'no workflow runs npm publish yet; add templates/npm-publish.yml');

// ---- pack contents ----------------------------------------------------------
const pack = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
if (pack.ok) {
  try {
    const info = JSON.parse(pack.out)[0];
    const files: string[] = info.files.map((f: { path: string }) => f.path);
    const bad = files.filter((f) => /(^|\/)(\.env(\..*)?|\.npmrc|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|\.git\/|node_modules\/|coverage\/|.*\.log)$/.test(f) || /(^|\/)\.env/.test(f));
    if (bad.length) add('FAIL', 'pack', `tarball would include sensitive/junk files: ${bad.join(', ')}`);
    else add('PASS', 'pack', `tarball: ${files.length} files, ${(info.unpackedSize / 1024).toFixed(1)} KiB unpacked`);
  } catch {
    add('WARN', 'pack', 'could not parse npm pack --dry-run output');
  }
} else {
  add('WARN', 'pack', `npm pack --dry-run failed: ${pack.err.split('\n')[0]}`);
}

// ---- registry + repo visibility --------------------------------------------
let exists: boolean | null = null;
if (!OFFLINE && name) {
  const view = run('npm', ['view', name, 'versions', '--json']);
  if (view.ok) {
    exists = true;
    let n = 0;
    try {
      const v = JSON.parse(view.out);
      n = Array.isArray(v) ? v.length : 1;
    } catch {}
    add('INFO', 'registry', `${name} exists on npm (${n} versions): no bootstrap needed`);
    if (pkg.version && view.out.includes(`"${pkg.version}"`)) {
      add('FAIL', 'version', `${name}@${pkg.version} is already published; bump the version before tagging`);
    }
  } else if (/E404|404 Not Found|is not in this registry/i.test(view.err + view.out)) {
    exists = false;
    add('WARN', 'registry', `${name} is not on npm yet. Trusted publishing cannot create a package: one manual bootstrap publish is required first (see next steps)`);
  } else {
    add('WARN', 'registry', `could not query the registry: ${view.err.split('\n')[0]}`);
  }

  if (remoteSlug) {
    const gh = run('gh', ['repo', 'view', remoteSlug, '--json', 'visibility', '-q', '.visibility']);
    if (gh.ok) {
      if (gh.out === 'PUBLIC') add('PASS', 'visibility', 'repository is public (required for provenance)');
      else add('WARN', 'visibility', `repository is ${gh.out.toLowerCase()}: npm publishes without provenance from non-public repos`);
    } else {
      add('INFO', 'visibility', 'gh CLI unavailable or not logged in; confirm the repo is public, or provenance will be skipped silently');
    }
  }
}

finish();

// ---- report -----------------------------------------------------------------
function finish(): never {
  const steps: string[] = [];
  const slug = remoteSlug ?? '<owner>/<repo>';
  const wf = workflow ?? 'npm-publish.yml';
  const allow = MODE === 'stage' ? '--allow-stage-publish' : '--allow-publish';
  const envFlag = envName ? ` --env ${envName}` : '';

  if (exists === false) {
    steps.push(
      'BOOTSTRAP (human, once): trusted publishing cannot create a package, so publish a placeholder from your own machine.',
      '  Pick one:',
      '  (a) Placeholder (recommended): an empty 0.0.0 that exists only to claim the name.',
      '      mkdir /tmp/bootstrap && cd /tmp/bootstrap',
      `      npm init -y && npm pkg set name="${name}" version=0.0.0 description="placeholder; first real release is published from CI with provenance"${scoped ? ' publishConfig.access=public' : ''}`,
      '      npm login            # interactive, 2FA',
      `      npm publish --ignore-scripts${scoped ? ' --access public' : ''}`,
      `      # after the first CI release: npm deprecate ${name}@0.0.0 "placeholder"`,
      '  (b) Real first version from your machine: ships working code now, but that one version has no provenance.',
      '',
    );
  }
  steps.push(
    `TRUST (human, needs 2FA and npm >= 11.15.0), or do the same on npmjs.com > ${name || '<package>'} > Settings > Trusted publishing:`,
    `  npm trust github ${name || '<package>'} --repo ${slug} --file ${wf}${envFlag} ${allow}`,
    `  npm trust list ${name || '<package>'}   # confirm the entry shows the allowed action`,
    '',
    'LOCK DOWN (human): npmjs.com > package > Settings > Publishing access >',
    '  "Require two-factor authentication and disallow tokens". OIDC keeps working; stray tokens stop.',
    '  Then revoke any old automation tokens and delete the NPM_TOKEN repo secret.',
    '',
    'RELEASE:',
    '  npm version patch -m "chore: release v%s" && git push && git push --tags',
  );
  if (MODE === 'stage') steps.push('  then approve: npm stage list && npm stage approve <stage-id>   (2FA prompt)');
  steps.push('', 'VERIFY (anyone):', `  npm view ${name || '<package>'} dist.attestations --json   # provenance present`, '  npm audit signatures                    # in a project that depends on it');

  if (JSON_OUT) {
    console.log(JSON.stringify({ package: name, mode: MODE, workflow: workflow ?? null, environment: envName ?? null, exists, checks, nextSteps: steps }, null, 2));
  } else {
    for (const c of checks) console.log(`${c.status.padEnd(4)}  [${c.id}] ${c.msg}`);
    const fails = checks.filter((c) => c.status === 'FAIL').length;
    console.log(`\n${fails ? `${fails} blocking issue(s). Fix those first.` : 'No blocking issues.'}\n`);
    console.log('NEXT STEPS');
    for (const s of steps) console.log(s);
  }
  process.exit(checks.some((c) => c.status === 'FAIL') ? 1 : 0);
}
