#!/usr/bin/env bash
# One minimisation arm: fresh upstream + fresh standalone server, drive TOTAL distinct slugs,
# report successful renders before OOM.
#
#   NAME=x SECTIONS=5 NEST=0 CACHE_DEPTH=5 ITEMS=10 ./run-arm.sh
#
# Env: NAME (required), SECTIONS, NEST, CACHE_DEPTH, ITEMS, HEAP (MB, default 1024),
#      TOTAL (default 6000), CONC (default 8)
set -uo pipefail
D=/tmp/rg-3761/repro
NAME=${NAME:?set NAME}
HEAP=${HEAP:-1024}
TOTAL=${TOTAL:-6000}
CONC=${CONC:-8}
N=/Users/kevinkorach/.nvm/versions/node/v22.22.0/bin/node

kill_port() {
  for _ in $(seq 1 15); do
    P=$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null)
    [ -z "$P" ] && return 0
    echo "$P" | xargs -r kill -9 2>/dev/null; sleep 1
  done
}
kill_port 3000; kill_port 3101

ITEMS=${ITEMS:-60} $N "$D/upstream.mjs" > "$D/up-$NAME.log" 2>&1 &
sleep 1

PORT=3000 NODE_ENV=production \
  SECTIONS=${SECTIONS:-30} CACHE_DEPTH=${CACHE_DEPTH:-5} USE_HEADERS=${USE_HEADERS:-1} MODE=${MODE:-fn} \
  $N --max-old-space-size="$HEAP" "$D/.next/standalone/server.js" > "$D/srv-$NAME.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf http://localhost:3000/p/warm -o /dev/null 2>/dev/null && break
  sleep 1
done
if grep -q EADDRINUSE "$D/srv-$NAME.log" 2>/dev/null; then echo "!! $NAME stale server"; exit 1; fi

BASE=http://localhost:3000 TOTAL=$TOTAL CONC=$CONC $N "$D/load.mjs" > "$D/load-$NAME.log" 2>&1
RESULT=$(tail -1 "$D/load-$NAME.log")
echo "ARM $NAME  sections=${SECTIONS:-30} depth=${CACHE_DEPTH:-5} headers=${USE_HEADERS:-1} mode=${MODE:-fn} items=${ITEMS:-60} heap=${HEAP}M -> $RESULT"

kill_port 3000; kill_port 3101
