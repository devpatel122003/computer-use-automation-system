#!/usr/bin/env bash
# Runs every server needed for the full demo (both catalogs + both dashboards +
# the unified chat console) in one terminal, output labeled per-service.
# Ctrl+C kills all of them together.
set -e

trap 'kill 0' EXIT INT TERM

run() {
  local name="$1"; shift
  ( "$@" 2>&1 | sed -u "s/^/[$name] /" ) &
}

run mock-bank          npm run mock-bank
run capability-api     npm run capability-api
run dashboard          npm run dashboard
run capability-api-mer npm run capability-api-meridian
run dashboard-mer      npm run dashboard-meridian
run chat-ui            npm run chat-ui

echo "--- all servers starting ---"
echo "mock-bank dashboard:   http://localhost:4600"
echo "meridian dashboard:    http://localhost:4601"
echo "chat-ui (both targets): http://localhost:4800"
echo "Ctrl+C stops all of them."

wait
