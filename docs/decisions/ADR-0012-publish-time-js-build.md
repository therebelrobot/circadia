# ADR-0012: A publish-time JS build so `npx` and global installs work

**Status:** accepted (2026-09-30)

## Context

`AGENTS.md` §3.2 says Circadia is TypeScript that Node runs with type stripping, with no
build step. That holds in a git checkout. It does not hold for the published package:
Node refuses to strip types for any file under `node_modules`, by design. `npx circadia`,
`npm install -g circadia`, and installing Circadia as a project dependency all put
`src/cli/main.ts` under `node_modules`, and every command fails before it starts:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently
unsupported for files under node_modules, for ".../node_modules/circadia/src/cli/main.ts"
```

Verified against `circadia@0.3.0` from the registry on Node 22.22.2 (2026-09-30). The
only working install today is a clone.

## Decision

Keep development build-free, and emit plain JS only when packing:

- `tsconfig.build.json` extends `tsconfig.json`, turns emit on, writes `src/` → `dist/`,
  and sets `rewriteRelativeImportExtensions` so `./x.ts` imports (static and literal
  dynamic imports) become `./x.js`. No new dependency: `typescript` is already a dev
  dependency, and `erasableSyntaxOnly` means the output is the source with types erased.
- `npm run build` runs it; `prepack` runs `build`, so `npm pack` and `npm publish` always
  ship a fresh `dist/`. The npm-publish workflow already runs `npm run build --if-present`
  before `npm pack`.
- `bin/circadia.mjs` runs `dist/cli/main.js` only when its own path is inside
  `node_modules` **and** `dist/` exists; otherwise it runs `src/cli/main.ts` with type
  stripping, exactly as before. A stale local `dist/` can never shadow source edits in a
  checkout.
- `dist/` is gitignored. `package.json` gains a `files` allowlist (`bin/`, `dist/`,
  `src/`, `templates/`, and the markdown under `docs/`), so tests, the eval fixture,
  benchmarks and the README's GIFs (`docs/media/`) stop shipping (191 files → 152).
  `init` still finds `docs/SCHEMA.md`.

## Consequences

- `npx circadia …`, `npm i -g circadia`, and `circadia mcp` launched by an MCP client
  from a global install all work. Verified from a packed tarball: `--help`, `init`,
  `lint`, `index`, `recall`, and an MCP `initialize` round-trip.
- `dist/cli/main.js` sits at the same depth as `src/cli/main.ts`, so `REPO = ../..` in the
  CLI still resolves `templates/`.
- Contributors still never build. The one new failure mode is a TS feature that type
  stripping accepts but `tsc` emit rejects; `test/build.test.ts` builds to a temp dir and
  runs `--help` from the output, so CI catches it.
- `AGENTS.md` §3.2 is amended to say "no build step for development; a publish-time emit
  per ADR-0012".
