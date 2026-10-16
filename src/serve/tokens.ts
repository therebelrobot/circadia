// Bearer-token auth for `circadia serve` (RFC-0003 §6).
//
// Two tokens: a **write** token covers every tool; an optional **read** token covers only
// `recall`, `timeline`, `relate` and `get_note`. Tokens load from files named by env vars,
// for Docker secrets: `CIRCADIA_WRITE_TOKEN_FILE` / `CIRCADIA_READ_TOKEN_FILE`. The bare
// `CIRCADIA_WRITE_TOKEN` (development) is also accepted and logs a warning.
//
// Tokens never go in `circadia.config.json`: that file lives in the git-tracked vault, and
// `validateConfig` rejects any `serve.*token*` key. Comparison is `crypto.timingSafeEqual`
// over SHA-256 digests, so it does not leak token length.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface ServeTokens {
  write: string;
  read: string | null;
}

export const MIN_TOKEN_BYTES = 32;

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

interface LoadedToken {
  value: string | null;
  /** the env var the value came from, when it was the bare value (not a file) */
  devVar: string | null;
}

function readToken(fileEnv: string, valueEnv: string, env: NodeJS.ProcessEnv): LoadedToken {
  const file = env[fileEnv];
  if (file) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      throw new TokenError(`serve: could not read ${fileEnv} (${file}): ${(e as Error).message}`);
    }
    return { value: raw.trim(), devVar: null };
  }
  const value = env[valueEnv];
  if (value) return { value: value.trim(), devVar: valueEnv };
  return { value: null, devVar: null };
}

/**
 * Load and validate the tokens. Throws `TokenError` when the service must refuse to start:
 * no write token, a token shorter than 32 bytes, or a read token equal to the write token.
 * Also returns the dev-mode warnings to log (a bare `*_TOKEN` env var is for development).
 */
export function loadTokens(env: NodeJS.ProcessEnv = process.env): { tokens: ServeTokens; warnings: string[] } {
  const warnings: string[] = [];
  const write = readToken('CIRCADIA_WRITE_TOKEN_FILE', 'CIRCADIA_WRITE_TOKEN', env);
  const read = readToken('CIRCADIA_READ_TOKEN_FILE', 'CIRCADIA_READ_TOKEN', env);

  if (write.value === null || write.value === '') {
    throw new TokenError(
      'serve refuses to start without a write token: set CIRCADIA_WRITE_TOKEN_FILE to a file (Docker secrets) or CIRCADIA_WRITE_TOKEN for development',
    );
  }
  if (write.devVar) warnings.push(`${write.devVar} is set in the environment; prefer ${write.devVar}_FILE for a Docker secret`);
  if (Buffer.byteLength(write.value, 'utf8') < MIN_TOKEN_BYTES) {
    throw new TokenError(`serve: the write token must be at least ${MIN_TOKEN_BYTES} bytes, got ${Buffer.byteLength(write.value, 'utf8')}`);
  }

  let readValue: string | null = read.value === '' ? null : read.value;
  if (readValue !== null) {
    if (read.devVar) warnings.push(`${read.devVar} is set in the environment; prefer ${read.devVar}_FILE for a Docker secret`);
    if (Buffer.byteLength(readValue, 'utf8') < MIN_TOKEN_BYTES) {
      throw new TokenError(`serve: the read token must be at least ${MIN_TOKEN_BYTES} bytes, got ${Buffer.byteLength(readValue, 'utf8')}`);
    }
    if (readValue === write.value) throw new TokenError('serve: the read token must differ from the write token');
  } else {
    readValue = null;
  }

  return { tokens: { write: write.value, read: readValue }, warnings };
}

/** Constant-time token comparison over SHA-256 digests (never leaks length). */
export function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export type Scope = 'write' | 'read';

/**
 * Classify a request's bearer token. Returns `'write'`, `'read'`, or null (missing or bad).
 * The write token is tried first, matching the scope hierarchy.
 */
export function authorize(authorization: string | undefined, tokens: ServeTokens): Scope | null {
  const m = /^Bearer\s+(.+)$/i.exec((authorization ?? '').trim());
  if (!m) return null;
  const presented = m[1].trim();
  if (presented === '') return null;
  if (tokenMatches(presented, tokens.write)) return 'write';
  if (tokens.read !== null && tokenMatches(presented, tokens.read)) return 'read';
  return null;
}
