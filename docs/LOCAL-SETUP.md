# Local setup: Circadia as your own agent memory

How to run Circadia on your own machine as the memory behind your agents: a vault you can
read, an index, an MCP server wired into your harness, and a timer that turns the day's
episodes into facts overnight.

This is the operator's path. For what each piece *is*, see the [README](../README.md); for
the vault format, [`SCHEMA.md`](SCHEMA.md).

None of this is required to *try* Circadia — `npx circadia init` plus one `recall` is enough
for that. This page is for making it your durable memory.

## What you end up with

```
~/.circadia/vault/          markdown notes, a git repo, the only copy of your memory
  .circadia/index.sqlite    derived; delete it and it rebuilds
circadia mcp                stdio server your agent spawns (recall / remember / ...)
launchd | cron | serve      runs `consolidate` nightly: episodes -> facts
AGENTS.md                   tells the agent to use Circadia, not the harness's memory
```

## 1. Prerequisites

- **Node ≥ 26** (`node --version`). SQLite and type stripping are built in; there are no
  runtime dependencies to install. `.nvmrc` in the checkout pins the development version.
- **git**, for vault history and the one commit `consolidate` makes per run.

## 2. Create the vault

```bash
circadia init ~/.circadia/vault        # any path; this one is the conventional default
```

`init` writes folders, `circadia.config.json`, `_meta/` templates, and a `.gitignore`. The
`_meta/` files are scaffolding and are deliberately **not** indexed.

## 3. Make it a repo, then index it

```bash
cd ~/.circadia/vault
git init && git add -A && git commit -m "init: vault scaffolding"
circadia index --vault ~/.circadia/vault
circadia lint  --vault ~/.circadia/vault      # expect: 0 error(s), 0 warning(s)
```

Why git is not optional here: `consolidate` commits once per run, `circadia history` walks
commits, and git-backed `--as-of` re-reads prose as it stood at a past date. An empty vault
indexes to `0 notes`, which is correct — it has no memories yet.

## 4. Give consolidation a model

Extraction is **off by default**, so out of the box nothing is ever promoted from episodes to
facts. Point it at a model:

```json
{
  "extraction": {
    "provider": "http",
    "endpoint": "https://openrouter.ai/api/v1/chat/completions",
    "model": "mistralai/mistral-small-3.2-24b-instruct",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  }
}
```

- Use **non-OpenAI, non-xAI** models (owner requirement, `AGENTS.md` §3). A small instruct
  model is the right size: this is batch entity extraction, not reasoning.
- A local `llama-server` works too; that is the default endpoint and makes no network calls.
- The same `extraction.*` block drives **dreaming** (the REM pass) by default. To run dreaming
  on a different (e.g. cheaper) model, set `dreaming.llm.model` (and any of
  `provider`/`endpoint`/`apiKeyEnv`/`apiKeyFileEnv`); unset fields fall back to `extraction.*`.
  Dreaming stays off unless you set `dreaming.enabled: true`.
- To enforce Zero Data Retention on a hosted endpoint, set `extraction.routing.zdr: true`
  (and `extraction.routing.dataCollection: "deny"`). It is sent as the request's `provider`
  object and applies to consolidation and dreaming alike.
- Full key list: [`CONFIG.md`](CONFIG.md) §extraction.

## 5. Wire the MCP server into your harness

`circadia mcp` is a stdio server. For opencode:

```json
{
  "mcp": {
    "servers": {
      "circadia": {
        "type": "local",
        "command": ["npx", "-y", "circadia", "mcp", "--vault", "/home/you/.circadia/vault"]
      }
    }
  }
}
```

Point other clients at the same command line; the shape is the same everywhere. The server
resolves every path itself, so a caller string never becomes a file path, and agents can only
ever write `episodes/` — see [`src/mcp/README.md`](../src/mcp/README.md) for the tool contract.

## 6. Tell the agent to use it

A configured server that the agent never calls does nothing. Harnesses answer from their own
memory unless instructed otherwise, so add [`AGENT-GUIDANCE.md`](AGENT-GUIDANCE.md)'s block to
your `AGENTS.md`. That block is what makes the agent call `recall` before answering and
`remember` after working.

## 7. Run consolidation nightly

Episodes accumulate all day; facts only exist after a `consolidate` run. Without a timer your
`timeline` and fact-edge queries stay empty.

Three options: a **launchd** agent (macOS), a **cron** entry (Linux/macOS), or
**`circadia serve`**, whose built-in scheduler also serves HTTP MCP from one long-lived
process. Pick one; do not run two writers against the same vault at once.

### Secrets: give the job exactly one key

A headless job starts with almost no environment, so it has to find the API key itself. Give
it **one dedicated file**, not a shared secrets file:

```bash
install -m 600 /dev/null ~/.circadia/openrouter.key
printf '%s' 'sk-or-...' > ~/.circadia/openrouter.key     # paste once; file is 0600
```

and switch the config to the file-based key:

```json
{ "extraction": { "apiKeyFileEnv": "CIRCADIA_EXTRACTION_KEY_FILE" } }
```

Then the job sets `CIRCADIA_EXTRACTION_KEY_FILE` and nothing else carries the key.

> [!WARNING]
> Do not debug these jobs with `sh -x`, `set -x`, or a bare `env`/`printenv`. If the command
> can read your secrets, the trace prints them in clear text — into your terminal, your logs,
> and any transcript. This has happened; it is why `AGENTS.md` §10 has a **Secrets** rule.
> Sourcing a shared secrets file from a job is also fragile: one line that expects an
> interactive shell returns non-zero, and under `set -e` the job dies silently with no output.

### macOS: launchd

A wrapper resolves Node and the key, then runs one command. Save as
`~/.circadia/bin/consolidate.sh`, `chmod +x`:

```sh
#!/bin/sh
# Nightly Circadia consolidation. launchd gives this almost no environment, so resolve
# Node and the key here and nothing else.
set -e

CIRCADIA_REPO="<path-to-your-circadia-checkout>"
CIRCADIA_VAULT="$HOME/.circadia/vault"

# Node: the newest installed version matching the checkout's .nvmrc major.
ver="$(cat "$CIRCADIA_REPO/.nvmrc")"
node_bin="$(ls -d "$HOME"/.nvm/versions/node/v"$ver".*/bin 2>/dev/null | sort -t. -k2,2n -k3,3n | tail -1 || true)"
if [ -z "$node_bin" ]; then
  echo "consolidate: no Node $ver under ~/.nvm/versions/node" >&2
  exit 1
fi
PATH="$node_bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

# One key file, never a shared secrets file (see the warning above).
CIRCADIA_EXTRACTION_KEY_FILE="$HOME/.circadia/openrouter.key"
export CIRCADIA_EXTRACTION_KEY_FILE

echo "consolidate: $(date '+%Y-%m-%d %H:%M:%S') node=$("$node_bin/node" --version)"
exec "$node_bin/node" "$CIRCADIA_REPO/bin/circadia.mjs" consolidate --vault "$CIRCADIA_VAULT"
```

Save the agent as `~/Library/LaunchAgents/com.circadia.consolidate.plist`. A plist cannot
expand `~`, so use absolute paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.circadia.consolidate</string>
  <key>ProgramArguments</key>
  <array><string>/Users/&lt;you&gt;/.circadia/bin/consolidate.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/Users/&lt;you&gt;/.circadia/logs/consolidate.out.log</string>
  <key>StandardErrorPath</key><string>/Users/&lt;you&gt;/.circadia/logs/consolidate.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/&lt;you&gt;</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
```

Check it, load it, and force one run (a vault with no episodes makes no model calls, so this
is free):

```bash
mkdir -p ~/.circadia/logs
plutil -lint ~/Library/LaunchAgents/com.circadia.consolidate.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.circadia.consolidate.plist
launchctl print   gui/$(id -u)/com.circadia.consolidate | grep -E 'state|runs|last exit'
launchctl kickstart -k gui/$(id -u)/com.circadia.consolidate
cat ~/.circadia/logs/consolidate.err.log
```

`last exit code = 0` and a `consolidated: ...` line in the log mean it works. If a 03:00 slot
is missed because the machine is asleep, launchd runs it once on wake. To stop it:
`launchctl bootout gui/$(id -u)/com.circadia.consolidate`.

### Linux: cron

```cron
0 3 * * * /home/you/.circadia/bin/consolidate.sh >> /home/you/.circadia/logs/consolidate.out.log 2>&1
```

cron's environment is as thin as launchd's, so keep the wrapper. On macOS, `cron` also needs
Full Disk Access, which is why launchd is the better choice there.

### Anywhere: `circadia serve`

`circadia serve` runs an HTTP MCP service with a built-in `consolidate` scheduler, so the
timer and the server share one process and one write lock — the right shape on a Pi or a
shared host. It requires a write token, and the schedule is opt-in:

```json
{ "serve": { "schedule": { "consolidate": "03:00", "timezone": "America/New_York" } } }
```

See [`CONFIG.md`](CONFIG.md) §serve and [`SECURITY.md`](SECURITY.md) T2.

## 8. Verify the whole loop

```bash
circadia lint  --vault ~/.circadia/vault          # 0 errors
circadia index --vault ~/.circadia/vault          # builds/updates the index
circadia consolidate --vault ~/.circadia/vault --dry-run   # prints the diff; writes nothing
```

Then confirm the agent side: have the agent `remember` a sentence, re-index, and `recall` it.

```bash
circadia index  --vault ~/.circadia/vault
circadia recall --vault ~/.circadia/vault "what did we decide about the thing"
```

If `recall` finds the episode, the loop is closed: written, indexed, retrieved. Facts appear
only after a real (non-`--dry-run`) `consolidate`, and only for candidates that pass the
schema-fit gate.

## 9. What is off by default

| key | default | effect if left alone |
|---|---|---|
| `extraction.provider` | `none` | nothing is ever promoted from episodes to facts |
| `embeddings.provider` | `none` | no vector seeds; keyword + graph only |
| `dreaming.enabled` | `false` | no REM pass; dream edges stay at weight 0 |
| `predicates.defs` | `{}` | every candidate queues for `circadia review` instead of promoting |

That list is the short version of "why isn't my vault learning anything yet".

## 10. Secrets hygiene

The rules, condensed from `AGENTS.md` §10:

- Never `cat`, `grep -r`, `sh -x`, `set -x`, `env`, or `printenv` a secrets file or anything
  that can read one. A trace prints keys in clear text.
- Inventory a secrets file by **names only**; never values.
- One dedicated `0600` key file per job, via `apiKeyFileEnv`. Never source a shared secrets
  file from a timer.
- Regex masking of a stream that already contains secrets is not masking.
- If a secret is disclosed: stop, report exactly what leaked, and rotate it. Never call the
  credential to see whether it is live.
