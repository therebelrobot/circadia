// Bearer-token resolution for HTTP model calls (RFC-0003 §7).
//
// Two config keys can name the token:
//   - `apiKeyEnv`      — the name of an env var that holds the token itself;
//   - `apiKeyFileEnv`  — the name of an env var that holds a *path* to a file that holds
//                        the token, for Docker secrets.
//
// `apiKeyFileEnv` is additive: when it is set, resolvable, and non-empty it wins; otherwise
// `apiKeyEnv` is used. When neither yields a token the caller sends no Authorization header
// at all, never an empty `Bearer ` (some servers reject the latter).

import { readFileSync } from 'node:fs';

export function resolveApiKey(
  apiKeyEnv: string | null | undefined,
  apiKeyFileEnv: string | null | undefined,
): string | null {
  if (apiKeyFileEnv) {
    const file = process.env[apiKeyFileEnv];
    if (file) {
      try {
        const token = readFileSync(file, 'utf8').trim();
        if (token) return token;
      } catch {
        // Unreadable secret file: fall through to apiKeyEnv rather than fail the request.
      }
    }
  }
  if (apiKeyEnv) {
    const token = process.env[apiKeyEnv];
    if (token) return token;
  }
  return null;
}
