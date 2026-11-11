#!/usr/bin/env bash
# gc-tib.8: run tests/integration/fix-run-lock.pg.test.ts against a throwaway
# local Postgres (initdb in a temp dir, own port and socket), then delete it.
# Never reads .env and never touches another database.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${GC_PG_TEST_PORT:-54329}"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/gc-lock-pg.XXXXXX")"
DB="gc_lock_test"
URL="postgresql://postgres@127.0.0.1:${PORT}/${DB}"

cleanup() {
  pg_ctl -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true
  case "$DIR" in
    "${TMPDIR:-/tmp}"/gc-lock-pg.*) rm -rf "$DIR" ;;
  esac
  case "${SOCK:-}" in
    /tmp/gc-lock-sock.*) rm -rf "$SOCK" ;;
  esac
}
trap cleanup EXIT

initdb -D "$DIR/data" -A trust -U postgres >/dev/null
# Socket in a short fixed-length dir (macOS limits socket paths to ~104 chars).
SOCK="$(mktemp -d /tmp/gc-lock-sock.XXXXXX)"
pg_ctl -D "$DIR/data" -o "-p ${PORT} -k '${SOCK}' -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
createdb -h 127.0.0.1 -p "$PORT" -U postgres "$DB"

DATABASE_URL="$URL" npx prisma migrate deploy >/dev/null
GC_PG_TEST_URL="$URL" npx vitest run tests/integration/fix-run-lock.pg.test.ts
