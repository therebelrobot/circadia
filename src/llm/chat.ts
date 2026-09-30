// Shared chat-completions client (C10).
//
// One place that speaks the OpenAI-compatible chat wire format that llama.cpp's
// `llama-server` implements at `/v1/chat/completions`:
//
//   request  { model, messages: [{ role, content }], temperature, max_tokens, response_format? }
//   response { choices: [{ message: { role, content } }] }
//
// The old call sites sent `{ prompt }` (the legacy *completions* shape), which a
// chat-completions server rejects. Everything that talks to the extraction LLM goes
// through `chatComplete` so the wire format, auth, timeout, and error handling are
// defined once.
//
// Zero runtime dependencies: global `fetch`, `AbortSignal.timeout`, and Node built-ins.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** full URL, e.g. http://127.0.0.1:8080/v1/chat/completions */
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  /**
   * Name of the env var holding a bearer token. When unset, or when the env var is
   * empty, no `Authorization` header is sent — never an empty `Bearer `.
   */
  apiKeyEnv?: string | null;
  temperature?: number;
  maxTokens?: number;
  /** ask the server for a JSON object body (`response_format: { type: "json_object" }`) */
  jsonObject?: boolean;
  /** request timeout in ms; defaults to DEFAULT_CHAT_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 30s: long enough for a local model to answer, short enough to fail a dead server. */
export const DEFAULT_CHAT_TIMEOUT_MS = 30_000;

export type ChatErrorCode =
  | 'llm.http-error'
  | 'llm.timeout'
  | 'llm.invalid-json'
  | 'llm.malformed-response';

/**
 * Typed error for every failure mode of a chat call, so callers can branch on `code`
 * instead of string-matching a message. `status` is the HTTP status when there was one.
 */
export class ChatError extends Error {
  readonly code: ChatErrorCode;
  readonly status: number | null;

  constructor(code: ChatErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'ChatError';
    this.code = code;
    this.status = status;
  }
}

/**
 * POST a chat completion and return the assistant message content.
 *
 * Throws `ChatError` on: non-2xx status (`llm.http-error`), timeout (`llm.timeout`),
 * a non-JSON body (`llm.invalid-json`), or a JSON body missing
 * `choices[0].message.content` (`llm.malformed-response`). It never indexes into the
 * response blindly.
 */
export async function chatComplete(opts: ChatOptions): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Only send a bearer when the key env var is set AND non-empty. An empty
  // `Authorization: Bearer ` header is rejected by some servers and leaks intent.
  const key = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined;
  if (key) headers['Authorization'] = `Bearer ${key}`;

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.1,
    max_tokens: opts.maxTokens ?? 512,
  };
  if (opts.jsonObject) body.response_format = { type: 'json_object' };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await fetch(opts.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ChatError('llm.timeout', `chat request timed out after ${timeoutMs}ms`);
    }
    throw new ChatError('llm.http-error', `chat request failed: ${(e as Error).message}`);
  }

  if (!res.ok) {
    throw new ChatError('llm.http-error', `chat endpoint returned ${res.status}: ${res.statusText}`, res.status);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ChatError('llm.invalid-json', 'chat endpoint returned a non-JSON body');
  }

  const content = extractContent(data);
  if (content === null) {
    throw new ChatError('llm.malformed-response', 'chat response missing choices[0].message.content');
  }
  return content;
}

/**
 * Wrap `text` in a data fence, neutralizing any attempt by the text to close the fence
 * early. Mirrors `renderForContext`'s `<untrusted-data>` handling (AGENTS.md §4): every
 * `<tag` / `</tag` occurrence inside the text has its `<` replaced with the escaped
 * form, so the only real delimiters are the ones this function adds. Without this, a
 * pasted note containing `</episode-data>` would put attacker text outside the fence.
 */
export function fenceData(text: string, tag: string): string {
  const pattern = new RegExp(`<\\/?\\s*${escapeRegExp(tag)}`, 'gi');
  const escaped = text.replace(pattern, (m) => m.replace('<', LT));
  return `<${tag}>\n${escaped}\n</${tag}>`;
}

/**
 * The escaped form of `<`. Built by concatenation so this source file never contains the
 * HTML entity literally (some editors decode it back to `<`).
 */
const LT = '&' + 'lt;';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pull `choices[0].message.content` out of an unknown JSON value, or null if absent. */
function extractContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : null;
}
