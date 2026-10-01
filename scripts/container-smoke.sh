#!/usr/bin/env bash
# Container smoke tests for the Circadia stdio image.
#
# Usage: scripts/container-smoke.sh <image-ref>
#
# Runs every check CI and humans need, so both run the same thing. It never touches
# examples/vault/: every vault is a mktemp copy. Prints PASS/FAIL per check and exits
# nonzero on any failure.
#
# Assumes `npm ci` has run in the repo (the MCP check uses the devDependency SDK).
set -euo pipefail

IMAGE="${1:-}"
if [[ -z "$IMAGE" ]]; then
  echo "usage: $0 <image-ref>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$REPO_ROOT/scripts/container-smoke-helpers.mjs"
EXAMPLE_VAULT="$REPO_ROOT/examples/vault"

TMP_DIRS=()
MOCK_PID=""
cleanup() {
  if [[ -n "$MOCK_PID" ]]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  for d in "${TMP_DIRS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done
}
trap cleanup EXIT

FAILURES=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }
notrun() { echo "NOT RUN: $1"; }

# A fresh temp copy of examples/vault, with derived state removed and made writable by
# the container's uid 1000 (the host copy is owned by the invoking user).
new_vault() {
  local d
  d="$(mktemp -d)"
  TMP_DIRS+=("$d")
  cp -R "$EXAMPLE_VAULT/." "$d/"
  rm -f "$d/.circadia/index.sqlite" "$d/.circadia/index.sqlite-wal" "$d/.circadia/index.sqlite-shm"
  chmod -R a+rwX "$d"
  echo "$d"
}

echo "== 1. non-root =="
uid="$(docker run --rm --entrypoint id "$IMAGE" -u)"
if [[ -n "$uid" && "$uid" != "0" ]]; then
  pass "runs as nonzero uid ($uid)"
else
  fail "runs as uid '$uid' (expected nonzero)"
fi

echo "== 2. read-only root =="
v="$(new_vault)"
if docker run --rm --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" -v "$v:/vault" \
     --entrypoint sh "$IMAGE" -c '
       if touch /usr/forbidden 2>/dev/null; then echo "wrote /usr"; exit 1; fi
       if touch /forbidden 2>/dev/null; then echo "wrote /"; exit 1; fi
       touch /vault/ok || { echo "could not write /vault"; exit 1; }
       exit 0
     '; then
  pass "root fs read-only; /vault writable"
else
  fail "read-only root check"
fi

echo "== 3. no package manager =="
if docker run --rm --entrypoint sh "$IMAGE" -c '
     for c in npm npx corepack; do
       if command -v "$c" >/dev/null 2>&1; then echo "found $c"; exit 1; fi
     done
     exit 0
   '; then
  pass "npm, npx, corepack absent from PATH"
else
  fail "a package manager is present"
fi

echo "== 4. MCP over stdio =="
v="$(new_vault)"
# `remember` writes episodes but does not reindex, so build the index the server reads.
docker run --rm -v "$v:/vault" "$IMAGE" index --vault /vault >/dev/null
if node "$HELPER" mcp "$IMAGE" "$v"; then
  pass "initialize / tools/list / recall / remember (by:agent) / remember by:user refused"
else
  fail "MCP stdio check"
fi

echo "== 5. git as a different uid =="
v="$(new_vault)"
git -C "$v" init -q
git -C "$v" -c user.name=Smoke -c user.email=smoke@example.invalid add -A
git -C "$v" -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm "initial"
# Index as the container user so the index file is writable by it.
docker run --rm -v "$v:/vault" "$IMAGE" index --vault /vault >/dev/null
if docker run --rm --user 1000:1000 -v "$v:/vault" "$IMAGE" \
     consolidate --vault /vault --no-commit --dry-run >/dev/null 2>&1; then
  pass "consolidate --dry-run as uid 1000 (no dubious ownership)"
else
  fail "consolidate --dry-run as uid 1000"
fi
if docker run --rm --user 1000:1000 -v "$v:/vault" "$IMAGE" \
     history orchard-sensors >/dev/null 2>&1; then
  pass "history as uid 1000 (no dubious ownership)"
else
  fail "history as uid 1000"
fi

# Real consolidate against a mock model endpoint on the host.
portfile="$(mktemp)"
TMP_DIRS+=("$portfile")
node "$HELPER" mock-model "$portfile" &
MOCK_PID=$!
for _ in $(seq 1 50); do [[ -s "$portfile" ]] && break; sleep 0.1; done
if [[ ! -s "$portfile" ]]; then
  notrun "real consolidate with mock model (mock server did not start)"
else
  port="$(cat "$portfile")"
  node "$HELPER" set-endpoint "$v" "http://host.docker.internal:$port/v1/chat/completions"
  before="$(git -C "$v" rev-list --count HEAD)"
  if docker run --rm --user 1000:1000 --add-host=host.docker.internal:host-gateway \
       -v "$v:/vault" "$IMAGE" consolidate --vault /vault >/dev/null 2>&1; then
    after="$(git -C "$v" rev-list --count HEAD)"
    if [[ "$after" -eq $((before + 1)) ]]; then
      pass "real consolidate created exactly one commit"
    else
      fail "real consolidate created $((after - before)) commits (expected 1)"
    fi
  else
    fail "real consolidate with mock model"
  fi
fi

echo "== 6. zero runtime deps =="
if docker run --rm --entrypoint sh "$IMAGE" -c \
     'test -z "$(ls -A /usr/local/lib/node_modules/circadia/node_modules 2>/dev/null)"'; then
  pass "global circadia install has no node_modules"
else
  fail "global circadia install has runtime dependencies"
fi

echo "== 7. size =="
size="$(docker image inspect "$IMAGE" --format '{{.Size}}')"
echo "INFO: image size ${size} bytes ($(( size / 1024 / 1024 )) MiB)"

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "$FAILURES CHECK(S) FAILED"
  exit 1
fi
