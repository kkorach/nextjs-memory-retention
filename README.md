# `use cache`: nested cache scopes retain memory per render

Minimal reproduction for a server-side memory leak under `cacheComponents`.

A page that opens **nested `use cache` scopes** retains memory on every render with a fresh cache
key. Heap held after a forced full GC grows with nesting depth, and under sustained load with
distinct cache keys the process eventually OOMs. Flattening the cached chain to a single level cuts
the retention by ~85%.

Related: vercel/next.js#97363. PR #97391 was tested against this and did **not** change the outcome.

## Versions

- `next` 16.3.1-canary.18 (also reproduces on 16.3.0 and 16.3.1 stable)
- `react` / `react-dom` 19.2.8
- Node 22.22.0 (also reproduces on Node 24)
- `output: 'standalone'`, `NODE_ENV=production`

## Reproduce

```bash
npm install
npm run build

# terminal 1 — a trivial local upstream, so the cached function performs a real fetch()
node upstream.mjs

# terminal 2
node --expose-gc --max-old-space-size=1024 .next/standalone/server.js

# terminal 3 — requests with DISTINCT slugs, so each fills a new cache entry
node load.mjs
```

## Measuring it

**Use the retention measurement, not time-to-OOM.** Renders-to-OOM is far too noisy to draw
conclusions from: the identical baseline config has died at 199, 227, 710 and 2109 renders, and has
also survived 6000 twice. Every claim below rests on retention instead.

`run-ret.sh` drives N renders, forces a full GC, then reports two numbers: how many
`AbortController.abort()` reason Errors are still reachable (via `WeakRef`, so the probe cannot
create the effect it measures), and `heapUsed` after that GC.

```bash
NAME=d5 CACHE_DEPTH=5 ./run-ret.sh
NAME=d1 CACHE_DEPTH=1 ./run-ret.sh
```

## Result: cost compounds with nesting depth

300 renders per arm, three repeats, medians. `SECTIONS` fixed at 30, so the only variable is how
many `use cache` scopes one read nests.

| `CACHE_DEPTH` | scopes opened / render | retained Errors / render | heap after full GC | excess over depth 1 |
|---|---|---|---|---|
| 1 | 31 | 2.1 | 162 MB | — |
| 2 | 61 | 7.9 | 213 MB | +51 MB |
| 3 | 91 | 9.1 | 241 MB | +79 MB |
| 5 | 152 | 13.1 | 310 MB | +148 MB |

Monotonic in both metrics. The single largest step is 1 → 2 (retention ~3.8x); each further level
adds less. Depth 1 is cleanly separated from every other depth across all runs (range 1.9–2.4 vs
5.8–20.1); adjacent depths above 1 overlap between runs, so treat their ordering as a trend rather
than a precise curve.

Some of that heap is legitimately cached data, which is why the "excess over depth 1" column is the
honest figure.

## Component-level and function-level nesting cost the same

`use cache` can be applied to a function or to a component. Nesting via JSX (`MODE=comp`, a cached
component returning a cached component as a child) costs exactly what nesting via calls does
(`MODE=fn`, a cached function awaiting a cached function):

| mode | depth | scopes opened / render | retained / render |
|---|---|---|---|
| fn | 5 | 151.5 | 13.4 |
| comp | 5 | 151.5 | 12.3 |
| fn | 1 | 31.1 | 3.0 |
| comp | 1 | 31.1 | 3.3 |

Identical scope counts. A cached parent renders its subtree inside its own cache scope, so
component composition nests just as much as calling does.

## Knobs

All read at runtime by the server process, so one build covers every arm.

| var | default | meaning |
|---|---|---|
| `CACHE_DEPTH` | `5` | how many `use cache` scopes one read nests (`app/data.ts`, `app/comp.tsx`) |
| `MODE` | `fn` | `fn` = nest by call, `comp` = nest by JSX child |
| `SECTIONS` | `30` | independent `<Suspense>` sections per page |
| `USE_HEADERS` | `1` | whether each section calls `headers()` before its cached read |
| `ITEMS` | `60` | items per upstream response (`upstream.mjs`) |

`SECTIONS` and `ITEMS` scale how fast the heap fills, not whether it fills.

`USE_HEADERS=0` is **not** a fix — it retains as much as the baseline (15.7 and 22.7 per render
across two runs, versus 11.8–21.2 for the baseline). An earlier version of this README claimed
dropping the dynamic read stopped the leak; that was based on the unreliable time-to-OOM metric and
is retracted.

## Notes

- `output: 'standalone'` and `cacheComponents: true` are both required (see `next.config.ts`).
- The outbound `fetch()` matters. The retained graph is rooted at a live keep-alive TCP socket
  (`Global handles → TCP → AsyncContextFrame → …`); with no outbound fetch there is no socket to
  anchor it. `upstream.mjs` is local so the reproduction needs no external service.
- Distinct slugs matter. Re-requesting the same 8 slugs (`REPEAT=1 node load.mjs`) is flat — this is
  per-distinct-cache-fill, not per-request.
- Retention is permanent, not connection-scoped: with 0 established connections at rest, and again
  after 75 s idle, the retained count was byte-identical.
- Raising `cacheMaxMemorySize` makes it *worse*, not better.
- Running node with `--stack-trace-limit=2` largely suppresses it. The cliff is sharp between 2
  and 3.

## Isolating the mechanism without React or Next

`v8-stack-retention.mjs` reproduces the underlying retention in ~40 lines with no framework involved.
4000 payloads, each reachable only from one `setImmediate` callback's `AsyncLocalStorage` context;
retain the abort-reason `Error`, force GC, count survivors via `WeakRef`.

```bash
for arm in noerror unread readstack limit0 one; do
  ARM=$arm node --expose-gc v8-stack-retention.mjs
done
```

| arm | payloads retained | stack frames kept |
|---|---|---|
| `noerror` — create no Error | 0 / 4000 (0%) | – |
| `unread` — retain Error, never read `.stack` | **4000 / 4000 (100%)** | 4 |
| `readstack` — retain Error, read `.stack` once | 0 / 4000 (0%) | 4 |
| `limit0` — create with `stackTraceLimit = 0` | 0 / 4000 (0%) | 0 |
| `one` — retain **one** Error per batch of 64 | **4000 / 4000 (100%)** | 4 |

Identical on Node 20.11, 22.22 and 24.18.

Two things this shows. Reading `.stack` releases the retention, because V8 keeps structured
`CallSiteInfo` frames only until first access and then formats them to a string. And the `one` arm
shows it is **cross-immediate**: 63 retained Errors kept 4000 payloads alive, so a single captured
stack pins roughly 64 *unrelated* queued immediates through libuv's `_idlePrev`/`_idleNext` chain.

## Comparing candidate fixes

`apply-arm.mjs` patches one candidate into the already-built standalone output, so every arm shares a
single build and only the vendored React Flight server differs. `run-experiment.sh` runs them
interleaved and verifies each patch is present in the artifact before trusting a run.

```bash
npm run build
./run-experiment.sh          # 3 interleaved repeats of stock, A, B, C, D
```

| arm | change at the abort site |
|---|---|
| A | retain one process-wide `Error` instead of one per render |
| B | create it with `Error.stackTraceLimit = 0` |
| C | create it, then `void err.stack` to format and release the frames |
| D | use a non-`Error` reason, `{message}` |

Measured at depth 5, 300 renders, medians of 3 interleaved repeats: stock **320 MB** post-GC;
A 158, B 159, C 161, D 160. The depth-1 floor for the same build was 170 MB, so every arm removes the
nesting penalty outright. Throughput was flat across all arms (24–26s per 300 renders).
