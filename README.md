# `use cache`: nested cache scopes retain memory per render until OOM

Minimal reproduction for a server-side memory leak under `cacheComponents`.

A page that opens **nested `use cache` scopes** while also performing a **dynamic read**
(`headers()`) retains memory on every render with a fresh cache key. The heap climbs until the
process OOMs. Flattening the cached chain to a single level, or removing the dynamic read, both
stop it completely.

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

# terminal 2 — 1 GB heap makes the OOM arrive in minutes instead of hours
node --max-old-space-size=1024 .next/standalone/server.js

# terminal 3 — 6000 requests, each with a DISTINCT slug (so each fills a new cache entry)
node load.mjs
```

Expected: the server dies partway through.
Actual output looks like `=> SERVER DIED after 2109 successful renders`.

## The three arms

All identical except for one environment variable on the **server** process.

| arm | env | result |
|---|---|---|
| baseline | *(none)* | **OOM** — died after 2109 renders |
| flattened | `CACHE_DEPTH=1` | survived all 6000 |
| no dynamic read | `USE_HEADERS=0` | survived all 6000 |

Both survivors do the same amount of work as the baseline: the local upstream logs ~30 fetches per
render in every arm (`served=178350` after 6000 renders), so nothing is being short-circuited.

`run-arm.sh` runs one arm end to end if you'd rather not drive it by hand:

```bash
NAME=baseline ./run-arm.sh
NAME=flat CACHE_DEPTH=1 ./run-arm.sh
NAME=nohdr USE_HEADERS=0 ./run-arm.sh
```

### Renders-to-OOM is noisy; OOM-vs-survive is not

The same baseline config has died anywhere between 199 and 2109 renders across runs. Treat the
number as an order of magnitude only. The contrast that is stable across every run is binary: the
baseline always dies, and both single-variable changes always survive 6000.

## What each knob does

All are read at runtime by the server process, so one build covers every arm.

| var | default | meaning |
|---|---|---|
| `CACHE_DEPTH` | `5` | how many `use cache` scopes one read nests (`app/data.ts`) |
| `USE_HEADERS` | `1` | whether each section calls `headers()` before its cached read |
| `SECTIONS` | `30` | independent `<Suspense>` sections per page |
| `ITEMS` | `60` | items per upstream response (`upstream.mjs`) |

`SECTIONS` and `ITEMS` set how fast the heap fills, not whether it fills. At `SECTIONS=10` or
`ITEMS=5` the leak is still present but 6000 renders is no longer enough budget to reach 1 GB, so
those arms survive without contradicting anything.

## Cost of each nesting level

Measured separately by holding a `WeakRef` to a sample of the `AbortController.abort()` reason
Errors, forcing GC, and counting survivors — 300 renders per arm, `SECTIONS` fixed at 30:

| `CACHE_DEPTH` | abort Errors created / render | still reachable after GC / render |
|---|---|---|
| 1 | 31 | 2.0 |
| 2 | 61 | 6.4 |
| 3 | 91 | 14.9 |
| 4 | 121 | 10.4 |
| 5 | 152 | 20.7 |

Each level adds Errors *and* raises the share that survives, so the cost compounds rather than
being a fixed penalty for nesting at all. (Depth 4 is a single noisy sample; the trend across 1→5
is the point.)

Retention is permanent, not connection-scoped: with 0 established connections at rest, and again
after 75 s idle, the retained count was byte-identical.

## Notes

- `output: 'standalone'` and `cacheComponents: true` are both required (see `next.config.ts`).
- The outbound `fetch()` matters. The retained graph is rooted at a live keep-alive TCP socket
  (`Global handles → TCP → AsyncContextFrame → …`); with no outbound fetch there is no socket to
  anchor it. `upstream.mjs` is local so the reproduction needs no external service.
- Distinct slugs matter. Re-requesting the same 8 slugs (`REPEAT=1 node load.mjs`) is flat over
  6000 renders — this is per-distinct-cache-fill, not per-request.
- Raising `cacheMaxMemorySize` makes it *worse*, not better.
- The only mitigation found that keeps the baseline config alive for all 6000 renders is running
  node with `--stack-trace-limit=2`. The cliff is sharp between 2 and 3.
