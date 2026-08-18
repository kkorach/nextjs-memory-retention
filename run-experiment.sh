#!/usr/bin/env bash
# Phase 1: measure every candidate fix against interleaved stock baselines.
#
# Arms are patched into the ALREADY BUILT standalone output, so all of them share one build and one
# app binary — the vendored React Flight server is the only thing that differs.
#
# Primary metric is post-GC heapUsed at a fixed render count. Retained-Error count is NOT comparable
# across arms: arm D creates no Error (probe counts zero) and arm A shares one instance.
#
#   ./run-experiment.sh            # 3 interleaved repeats of stock,A,B,C,D
set -uo pipefail
cd "$(dirname "$0")"
REPS=${REPS:-3}
DEPTH=${DEPTH:-5}
RENDERS=${RENDERS:-300}
SR=.next/standalone/node_modules
B=$SR/next/dist/compiled/next-server/app-page-turbo.runtime.prod.js

marker() { case "$1" in
  stock) echo 'cacheController.abort(Error("This render completed';;
  A) echo '__rscAbortErr';;
  B) echo 'Error.stackTraceLimit=0';;
  C) echo 'void __e.stack';;
  D) echo '({message:"This render completed';;
esac; }

[ -f "$B" ] || { echo "!! no standalone build - run: npm run build"; exit 1; }

echo "=== depth=$DEPTH  renders=$RENDERS  reps=$REPS  node=$(node -v) ==="
for rep in $(seq 1 "$REPS"); do
  for arm in stock A B C D; do
    ROOT=$SR node apply-arm.mjs "$arm" >/dev/null || { echo "!! patch failed: $arm"; exit 1; }
    # Never trust a patch that was not verified in the artifact under test.
    if ! grep -qF "$(marker "$arm")" "$B"; then
      echo "!! arm $arm marker absent from built bundle - aborting"; exit 1
    fi
    NAME=x-$arm-$rep CACHE_DEPTH=$DEPTH RENDERS=$RENDERS ./run-ret.sh 2>/dev/null | grep -E '^RET' \
      | sed "s/^RET x-$arm-$rep/rep$rep  arm=$(printf '%-5s' "$arm")/"
  done
done
ROOT=$SR node apply-arm.mjs stock >/dev/null
echo "EXPERIMENT_DONE (standalone restored to stock)"
