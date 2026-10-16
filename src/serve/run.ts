// `circadia serve` orchestration (RFC-0003 §2, §5, §7, §9).
//
// One Node process runs: the HTTP MCP transport (§3), the built-in scheduler (§5), and —
// when `serve.watch` is true — the reindexer. Every mutating operation goes through one
// `WriteGate` (§4). `serve` never offers stdio, so it has exactly one transport and exactly
// one auth path (SECURITY.md T2).
//
// Session state (the scheduler's last run) lives in `.circadia/serve-state.json`:
// non-derivable but disposable. The health heartbeat is a file under the OS temp dir
// (tmpfs in the container), never the vault, so `serve --check` needs no network call and
// there is no unauthenticated health route.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../config.ts';
import { openIndex } from '../index/db.ts';
import { createGraphCache, type GraphCache } from '../retrieval/graph-cache.ts';
import {
  type ActiveBinding,
  type WorkspaceServerOptions,
} from '../mcp/server.ts';
import {
  loadWorkspace,
  resolveBinding,
  resolveLineage,
  writeTargetsFor,
} from '../workspace/registry.ts';
import { watchVault } from '../cli/watch.ts';
import { WriteGate } from './gate.ts';
import { createServeHttp, MCP_PATH, type ServeHttp } from './http.ts';
import { handleRpcMessage, type Dispatch, type WorkspaceDispatch } from './protocol.ts';
import { isDue, readServeState, resolveTimezone, serveStatePath, writeServeState, type ServeLastRun, type ServeRunState } from './scheduler.ts';
import type { ServeTokens } from './tokens.ts';

export type ServeLogger = (event: Record<string, unknown>) => void;

export function createLogger(out: NodeJS.WritableStream = process.stdout): ServeLogger {
  return (event) => {
    out.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  };
}

export function heartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CIRCADIA_HEARTBEAT_FILE ?? join(tmpdir(), 'circadia-serve-heartbeat.json');
}

export interface VaultTarget {
  kind: 'vault';
  vault: string;
  cfg: Config;
}
export interface WorkspaceTarget {
  kind: 'workspace';
  dir: string;
  project: string | null;
  agent: string | null;
  selectPerRequest: boolean;
  cfg: Config;
}
export type ServeTarget = VaultTarget | WorkspaceTarget;

export interface StartServeOptions {
  target: ServeTarget;
  tokens: ServeTokens;
  log?: ServeLogger;
  bind?: string;
  port?: number;
  now?: () => number;
  heartbeatFile?: string;
  /** scheduler poll interval in ms (default 30 s) */
  schedulerIntervalMs?: number;
  /** disable the scheduler and watcher (tests) */
  disableSchedule?: boolean;
}

export interface ServeHandle {
  port: number;
  host: string;
  /** advance the scheduler once; used by tests with an injected clock */
  tick(at?: number): Promise<void>;
  stop(): Promise<void>;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Probe each configured model endpoint once; warn, never fail (§7). */
async function probeEndpoints(cfg: Config, log: ServeLogger): Promise<void> {
  const endpoints: { name: string; url: string }[] = [];
  if (cfg.extraction.provider === 'http' && cfg.extraction.endpoint) endpoints.push({ name: 'extraction', url: cfg.extraction.endpoint });
  if (cfg.embeddings.provider === 'http' && cfg.embeddings.endpoint) endpoints.push({ name: 'embeddings', url: cfg.embeddings.endpoint });
  await Promise.all(
    endpoints.map(async ({ name, url }) => {
      try {
        // Any HTTP response proves reachability; only a network error counts as unreachable.
        await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
      } catch (e) {
        log({ event: 'endpoint.unreachable', endpoint: name, url, error: (e as Error).message });
      }
    }),
  );
}

function writeHeartbeat(file: string, vault: string, lastRun: ServeLastRun | null): void {
  try {
    writeFileSync(file, JSON.stringify({ service: 'circadia-serve', vault, at: new Date().toISOString(), pid: process.pid, lastRun }) + '\n');
  } catch {
    // A missing heartbeat only makes `--check` report unhealthy; it must never crash serve.
  }
}

async function runScheduledConsolidate(
  vault: string,
  cfg: Config,
  gate: WriteGate,
  log: ServeLogger,
): Promise<ServeLastRun> {
  const startedAt = new Date().toISOString();
  try {
    const { consolidate } = await import('../consolidation/consolidate.ts');
    const result = await gate.run(vault, 'consolidate', Number.POSITIVE_INFINITY, () =>
      consolidate(vault, cfg, { dryRun: false, commit: true, dream: cfg.dreaming.enabled }),
    );
    const counts = { promoted: result.promoted, queued: result.queued, superseded: result.superseded };
    log({ event: 'schedule.run', outcome: 'ok', ...counts });
    return { startedAt, endedAt: new Date().toISOString(), outcome: 'ok', counts };
  } catch (e) {
    const error = (e as Error).message;
    // A failed run is logged and is not retried until the next slot (§5).
    log({ event: 'schedule.run', outcome: 'failed', error });
    return { startedAt, endedAt: new Date().toISOString(), outcome: 'failed', counts: { promoted: 0, queued: 0, superseded: 0 }, error };
  }
}

export async function startServe(opts: StartServeOptions): Promise<ServeHandle> {
  const log = opts.log ?? createLogger();
  const now = opts.now ?? (() => Date.now());
  const gate = new WriteGate();
  const closeables: Array<() => void | Promise<void>> = [];
  const timers: NodeJS.Timeout[] = [];

  let dispatch: Dispatch;
  let scheduleVault: string | null;
  let cfg: Config;

  if (opts.target.kind === 'vault') {
    const { vault } = opts.target;
    cfg = opts.target.cfg;
    const { db } = openIndex(join(vault, cfg.index.path));
    closeables.push(() => db.close());
    dispatch = { kind: 'vault', vaultRoot: vault, cfg, graphCache: createGraphCache(db), gate };
    scheduleVault = vault;
  } else {
    const { dir } = opts.target;
    cfg = opts.target.cfg;
    const { registry } = loadWorkspace(dir);
    let pinned: ActiveBinding | null = null;
    if (!opts.target.selectPerRequest) {
      const { binding, problems } = resolveBinding(registry, opts.target.project, opts.target.agent);
      const errs = problems.filter((p) => p.severity === 'error');
      if (errs.length) throw new Error(errs.map((p) => p.message).join('; '));
      const lineage = resolveLineage(registry, dir, binding);
      if (lineage.length === 0) throw new Error(`binding (${opts.target.project ?? '*'}, ${opts.target.agent ?? '*'}) has no vaults`);
      pinned = { binding, lineage, writeTargets: writeTargetsFor(registry, binding.agent) };
    }
    const openDbs: { close: () => void }[] = [];
    closeables.push(() => {
      for (const d of openDbs) d.close();
    });
    const graphCaches: Record<string, GraphCache> = {};
    const first = pinned?.lineage[0] ?? null;
    const boundCfg = first ? loadConfig(first.path, registry.defaults) : cfg;
    const wsOpts: WorkspaceServerOptions = {
      workspaceDir: dir,
      project: opts.target.project,
      agent: opts.target.agent,
      selectPerRequest: opts.target.selectPerRequest,
    };
    const ws: WorkspaceDispatch = {
      kind: 'workspace',
      workspaceDir: dir,
      registry,
      opts: wsOpts,
      pinned,
      graphCaches,
      openDbs,
      boundCfg,
      gate,
    };
    dispatch = ws;
    cfg = boundCfg;
    // The scheduler runs on the bound vault. Request-selected serves have no single vault
    // to schedule against; log and skip rather than guess.
    scheduleVault = pinned ? join(dir, pinned.lineage[0].id) : null;
    if (!pinned) log({ event: 'schedule.disabled', reason: 'request-selected workspace has no bound vault' });
  }

  const bind = opts.bind ?? process.env.CIRCADIA_BIND ?? cfg.serve.bind;
  const port = opts.port ?? (process.env.CIRCADIA_PORT ? Number(process.env.CIRCADIA_PORT) : cfg.serve.port);

  if (!isLoopback(bind)) {
    log({ event: 'bind.non-loopback', bind });
  } else if (existsSync('/.dockerenv')) {
    // Inside a container loopback is unreachable through a published port (§3).
    log({ event: 'bind.loopback-in-container', bind });
  }

  const http: ServeHttp = createServeHttp({
    bind,
    port,
    tokens: opts.tokens,
    allowedOrigins: cfg.serve.allowedOrigins,
    maxBodyBytes: cfg.serve.maxBodyBytes,
    maxInFlight: cfg.serve.maxInFlight,
    handleMessage: (req, scope) => handleRpcMessage(req, dispatch, scope),
    log,
  });
  const listening = await http.listen();
  closeables.push(() => http.close());

  const hbFile = opts.heartbeatFile ?? heartbeatPath();
  let state: ServeRunState = scheduleVault ? readServeState(scheduleVault) : { lastRun: null };

  const tick = async (at?: number): Promise<void> => {
    const schedule = cfg.serve.schedule.consolidate;
    if (opts.disableSchedule || schedule === null || scheduleVault === null) return;
    const t = at ?? now();
    const tz = resolveTimezone(cfg);
    const lastRunAt = state.lastRun ? Date.parse(state.lastRun.startedAt) : null;
    if (!isDue(t, schedule, tz, lastRunAt)) return;
    const last = await runScheduledConsolidate(scheduleVault, cfg, gate, log);
    state = { lastRun: last };
    writeServeState(scheduleVault, state);
    writeHeartbeat(hbFile, scheduleVault, last);
  };

  // Heartbeat now and every 30 s (§9).
  if (scheduleVault) writeHeartbeat(hbFile, scheduleVault, state.lastRun);
  timers.push(
    setInterval(() => {
      if (scheduleVault) writeHeartbeat(hbFile, scheduleVault, state.lastRun);
    }, 30_000),
  );

  // Scheduler poll (§5).
  if (!opts.disableSchedule && cfg.serve.schedule.consolidate !== null && scheduleVault !== null) {
    // Catch-up runs immediately at startup if a slot was missed.
    void tick();
    const interval = opts.schedulerIntervalMs ?? 30_000;
    timers.push(setInterval(() => void tick(), interval));
  }

  const logStartup = (): void => {
    log({
      event: 'serve.start',
      vault: scheduleVault ?? '(none)',
      bind,
      port: listening.port,
      schedule: cfg.serve.schedule.consolidate,
      timezone: resolveTimezone(cfg),
      watch: cfg.serve.watch,
      mode: dispatch.kind,
      // Secrets are never logged.
    });
  };
  logStartup();

  // Optional reindexer (§2). Default false: `remember` already reindexes.
  let watchHandle: { abort(): void } | null = null;
  if (cfg.serve.watch && scheduleVault) {
    watchHandle = watchVault(scheduleVault, cfg, {});
    log({ event: 'serve.watch', vault: scheduleVault });
  } else if (cfg.serve.watch && !scheduleVault) {
    log({ event: 'serve.watch.skipped', reason: 'no bound vault' });
  }

  void probeEndpoints(cfg, log);

  return {
    port: listening.port,
    host: bind,
    tick,
    async stop(): Promise<void> {
      for (const t of timers) clearInterval(t);
      if (watchHandle) watchHandle.abort();
      for (const c of closeables) await c();
    },
  };
}

export interface ServeCheckResult {
  healthy: boolean;
  reason?: string;
  heartbeat: unknown;
  lastRun: ServeLastRun | null;
}

/** `circadia serve --check`: read the heartbeat file and the last run's outcome (§9). */
export function checkServe(
  opts: { heartbeatFile?: string; now?: () => number; maxAgeMs?: number } = {},
): ServeCheckResult {
  const file = opts.heartbeatFile ?? heartbeatPath();
  const at = (opts.now ?? Date.now)();
  if (!existsSync(file)) return { healthy: false, reason: 'no heartbeat file', heartbeat: null, lastRun: null };
  try {
    const hb = JSON.parse(readFileSync(file, 'utf8')) as { at?: string; lastRun?: ServeLastRun | null };
    const atMs = hb.at ? Date.parse(hb.at) : NaN;
    const age = at - atMs;
    const healthy = Number.isFinite(age) && age <= (opts.maxAgeMs ?? 90_000);
    return {
      healthy,
      reason: healthy ? undefined : `heartbeat is ${Number.isFinite(age) ? Math.round(age / 1000) + 's old' : 'unreadable'}`,
      heartbeat: hb,
      lastRun: hb.lastRun ?? null,
    };
  } catch {
    return { healthy: false, reason: 'heartbeat unreadable', heartbeat: null, lastRun: null };
  }
}

/** Exported for tests: the path `serve` records the last run in. */
export const SERVE_STATE_PATH = serveStatePath;
export { MCP_PATH };
