# ADR-0016: Retry transport failures with backoff, and let the dream pass retry `llm.timeout`

## Context

`chatComplete` (`src/llm/chat.ts`, C10) is the one client for every model call. Issue #12 gave
it a single fast retry for transport-shaped failures — a network error, a 429/5xx, or a 2xx body
that is not the JSON we expect — and deliberately did **not** retry `llm.timeout`: a call that
already waited out its budget has spent it, so a retry only doubles the worst-case latency (and
doubles the model calls a caller like the dream pass records per sample).

That reasoning holds when a timeout means "the model was slow". It does not hold when the *host*
suspends the process. The nightly job is fired by launchd inside a short macOS maintenance
DarkWake on a sleeping machine; macOS returns it to sleep mid-run, the network drops, and
in-flight requests surface as `llm.http-error` (`fetch failed`) or `llm.timeout` (an aborted body
read) even though the model was never slow. Observed every few nights on a real vault; a manual
run with the machine awake completes 20/20 samples with zero errors. Issue #25.

## Decision

1. **More attempts, spaced.** `DEFAULT_CHAT_ATTEMPTS` is 3 (was 2), and the delay between
   attempts grows exponentially (`retryDelayMs · 2^(n−1)`, capped at
   `MAX_CHAT_RETRY_DELAY_MS = 10s`). A short blip is ridden out; a genuinely dead endpoint still
   fails in bounded time.
2. **`llm.timeout` is retryable only when a caller opts in.** A new `ChatOptions.retryTimeout`
   (default `false`) makes `isTransient` treat `llm.timeout` like the other transport failures.
   Default off, so consolidation — which isolates a failed episode and retries the whole episode
   next run — keeps the old behavior.
3. **The dream pass opts in.** `propose()` in `src/dreams/rem.ts` sets `retryTimeout: true`: a
   dream sample is one cheap association judgement, and the pass is neither isolated nor retried
   at a higher level, so losing the sample is worse than repeating the call.

## Consequences

- A nightly pass on a machine that sleeps mid-run recovers most samples instead of pruning them
  with an error class.
- A caller that sets `retryTimeout` on a *genuinely* slow model pays up to `attempts × timeout`
  before failing. Only the dream pass does, and its budget is `dreaming.llm.timeoutMs`.
- No new config key: the knobs stay internal to `chatComplete`, as before.
- This narrows, but does not close, the DarkWake gap — if the machine sleeps through the retry
  window a sample is still lost. Running the job while the machine is awake remains the durable
  fix, and the documented wrapper also waits (bounded) for the model host to be reachable before
  starting.

## Status

Accepted. Implemented with issue #25.
