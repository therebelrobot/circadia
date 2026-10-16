#!/usr/bin/env bash
# Container smoke tests for the Circadia server image (`circadia-server`, RFC-0003).
#
# Usage: scripts/container-smoke-server.sh <image-ref>
#
# Runs every check CI and humans need for the HTTP service: it is a nonzero uid, the root
# filesystem is read-only, writes outside /vault and /tmp fail, auth is enforced, the MCP
# handshake works over the published loopback port, and HEALTHCHECK turns healthy.
#
# It never touches examples/vault/: every vault is a mktemp copy. Prints PASS/FAIL per check
# and exits nonzero on any failure.
set -euo pipefail

IMAGE="${1:-}"
if [[ -z "$IMAGE" ]]; then
  echo "usage: $0 <image-ref>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE_VAULT="$REPO_ROOT/examples/vault"
HOST_PORT="${SMOKE_PORT:-18711}"
CONTAINER="circadia-smoke-server-$$"

TMP_DIRS=()
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  for d in "${TMP_DIRS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done
}
trap cleanup EXIT

FAILURES=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILURES=$((FAILURES + 1)); }
notrun() { echo "NOT RUN: $1"; }

# A fresh temp copy of examples/vault, with derived state removed and made writable by the
# container's uid.
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

echo "== 2. no package manager =="
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

echo "== 3. HTTP service, auth, and the MCP handshake =="
v="$(new_vault)"
token="$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
tokenfile="$(mktemp)"
TMP_DIRS+=("$tokenfile")
printf '%s' "$token" > "$tokenfile"
chmod 644 "$tokenfile"

# Index up front so recall/read paths have an index; the server also reindexes on remember.
docker run --rm --user 1000:1000 -v "$v:/vault" "$IMAGE" index --vault /vault >/dev/null 2>&1 || true

if docker run -d --name "$CONTAINER" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 \
  -v "$v:/vault" \
  -v "$tokenfile:/run/secrets/write:ro" \
  -e CIRCADIA_BIND=0.0.0.0 \
  -e CIRCADIA_WRITE_TOKEN_FILE=/run/secrets/write \
  -e CIRCADIA_HEARTBEAT_FILE=/tmp/hb.json \
  --health-interval=2s --health-timeout=2s --health-start-period=1s --health-retries=5 \
  -p "127.0.0.1:${HOST_PORT}:8711" \
  "$IMAGE" >/dev/null; then
  # Wait for the listener.
  ready=0
  for _ in $(seq 1 100); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${HOST_PORT}/mcp" \
      -H "authorization: Bearer $token" -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || true)"
    if [[ "$code" == "200" ]]; then ready=1; break; fi
    sleep 0.2
  done

  if [[ "$ready" == "1" ]]; then
    pass "server answers tools/list"
  else
    fail "server did not become ready (last status '$code')"
    docker logs "$CONTAINER" 2>&1 | tail -20 || true
  fi

  # No token is a 401.
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${HOST_PORT}/mcp" \
    -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' || true)"
  if [[ "$code" == "401" ]]; then pass "no token is 401"; else fail "no token returned $code (expected 401)"; fi

  # initialize sets Mcp-Session-Id.
  headers="$(curl -s -D - -o /dev/null -X POST "http://127.0.0.1:${HOST_PORT}/mcp" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' || true)"
  if grep -qi '^mcp-session-id:' <<<"$headers"; then pass "initialize assigns Mcp-Session-Id"; else fail "no Mcp-Session-Id on initialize"; fi

  # Layer 4: HTTP tools work end to end (remember writes an episode).
  body="$(curl -s -X POST "http://127.0.0.1:${HOST_PORT}/mcp" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"remember","arguments":{"text":"Smoke test episode from the server image."}}}' || true)"
  if grep -q 'Wrote' <<<"$body"; then pass "remember over HTTP writes an episode"; else fail "remember over HTTP: $body"; fi

  echo "== 4. HEALTHCHECK =="
  status=""
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && break
    sleep 0.5
  done
  if [[ "$status" == "healthy" ]]; then pass "HEALTHCHECK reports healthy"; else fail "HEALTHCHECK status '$status' (expected healthy)"; fi

  echo "== 5. read-only root; /vault writable; /tmp writable =="
  if docker exec "$CONTAINER" sh -c '
       if touch /usr/forbidden 2>/dev/null; then echo "wrote /usr"; exit 1; fi
       if touch /forbidden 2>/dev/null; then echo "wrote /"; exit 1; fi
       touch /vault/ok || { echo "cannot write /vault"; exit 1; }
       touch /tmp/ok || { echo "cannot write /tmp"; exit 1; }
       exit 0
     '; then
    pass "root fs read-only; /vault and /tmp writable"
  else
    fail "read-only root / writable mounts check"
  fi

  echo "== 6. a CLI write as the container uid (no dubious ownership) =="
  if docker exec "$CONTAINER" circadia index --vault /vault >/dev/null 2>&1; then
    pass "index via docker exec"
  else
    fail "index via docker exec"
  fi
else
  fail "server container did not start"
fi

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "all server smoke checks passed"
  exit 0
fi
echo "$FAILURES server smoke check(s) failed"
exit 1
