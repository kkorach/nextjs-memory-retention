// Does an Error created inside a setImmediate callback retain that callback's async context —
// and does reading `.stack` release it?
//
// Mechanism under test (from RG-3761 heap snapshots):
//   Error -> CallSiteInfo frames -> Immediate -> _idlePrev/_idleNext -> other Immediates
//         -> kAsyncContextFrame -> AsyncContextFrame -> whatever that context holds
//
// So retaining ONE Error created in a setImmediate callback can pin every immediate queued at that
// moment, and everything their async contexts reach. This script holds Errors, drops the payloads,
// forces GC, and counts how many payloads survived via WeakRef.
//
// Arms (ARM env):
//   unread    - retain Error, never touch .stack        (the leaking shape React ships today)
//   readstack  - retain Error, read .stack once          (candidate real fix: keep the trace)
//   limit0    - create Error with stackTraceLimit=0      (react/react#37289 as written)
//   noerror   - create no Error at all                   (floor)
//   one       - retain ONE Error per batch of immediates  (does it pin UNRELATED immediates?)
//
// `one` is the arm that decides whether this is a Node-level bug. If retaining a single Error keeps
// the OTHER immediates' payloads alive, then one captured stack pins unrelated queued work via
// libuv's _idlePrev/_idleNext chain. If only its own batch-mate dies, an Error merely pins its own
// async context, which is defensible behaviour.
//
// Run: node --expose-gc v8-stack-retention.mjs
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const ARM = process.env.ARM ?? 'unread';
const N = Number(process.env.N ?? 4000);
const BATCH = Number(process.env.BATCH ?? 64);
const PAYLOAD = Number(process.env.PAYLOAD ?? 64 * 1024);

const kept = [];
const refs = [];

function makeError() {
  if (ARM === 'limit0') {
    const l = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try { return new Error('cleanup'); } finally { Error.stackTraceLimit = l; }
  }
  const e = new Error('cleanup');
  if (ARM === 'readstack') void e.stack;
  return e;
}

function scheduleOne(idx) {
  return new Promise((resolve) => {
    // The payload is reachable ONLY from this immediate's async context.
    const payload = Buffer.allocUnsafe(PAYLOAD);
    refs.push(new WeakRef(payload));
    als.run({ payload }, () => {
      setImmediate(() => {
        if (ARM === 'one') {
          // Only the first callback of each batch retains an Error.
          if (idx % BATCH === 0) kept.push(makeError());
        } else if (ARM !== 'noerror') {
          kept.push(makeError());
        }
        resolve();
      });
    });
  });
}

for (let i = 0; i < N; i += BATCH) {
  // A batch keeps many immediates queued simultaneously, which is what makes the
  // _idlePrev/_idleNext chain load-bearing.
  await Promise.all(Array.from({ length: Math.min(BATCH, N - i) }, (_, j) => scheduleOne(i + j)));
}

if (typeof global.gc !== 'function') { console.error('run with --expose-gc'); process.exit(1); }
global.gc(); global.gc();
await new Promise((r) => setTimeout(r, 50));
global.gc(); global.gc();

let alive = 0;
for (const r of refs) if (r.deref() !== undefined) alive++;
const heapMB = (process.memoryUsage().heapUsed / 1048576).toFixed(1);
// Does the retained Error still carry a usable trace? That is the whole argument for `readstack`
// over suppressing capture: same retention win, diagnostics preserved.
const sample = kept[kept.length - 1];
const frames = sample ? (sample.stack.match(/\n\s+at /g) ?? []).length : 0;
console.log(
  `ARM=${ARM.padEnd(9)} payloads=${refs.length} survived=${String(alive).padStart(5)}` +
  ` (${((alive / refs.length) * 100).toFixed(1).padStart(5)}%)  heapUsed=${heapMB}MB` +
  `  errorsKept=${kept.length}  stackFrames=${frames}`
);
