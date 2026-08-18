// Apply one experimental arm to the vendored React Flight server inside Next's prebuilt runtime
// bundles, so the leak fix can be measured without building React or Next from source.
//
// Patch site (react-server/src/ReactFlightServer.js, flushCompletedChunks, success path):
//   request.cacheController.abort(Error("This render completed successfully. ..."))
//
// The Error is retained for the request's lifetime as signal.reason. Its captured stack frames
// reference the setImmediate handle that React's performWork runs inside, which pins libuv's whole
// immediate list and everything the queued contexts reach. Each nested `use cache` scope is its own
// Flight render, hence one Error per scope per render.
//
//   node apply-arm.mjs stock|A|B|C|D
//
// Pristine copies are kept in node_modules/.rg3761-pristine so every arm starts from the same bytes.
import fs from 'node:fs';
import path from 'node:path';

// ROOT lets us patch the built output directly (.next/standalone/node_modules), which is what the
// server actually loads. The app code is identical across arms, so one build serves them all.
const ROOT = process.env.ROOT ?? 'node_modules';
const DIR = `${ROOT}/next/dist/compiled/next-server`;
const PRISTINE = `${ROOT}/.rg3761-pristine`;
const TARGETS = [
  'app-page-turbo.runtime.prod.js',
  'app-page.runtime.prod.js',
  'app-page-turbo-experimental.runtime.prod.js',
  'app-page-experimental.runtime.prod.js',
];

const MSG = '"This render completed successfully. All cacheSignals are now aborted to allow clean up of any unused resources."';
const FIND = `Error(${MSG})`;

const ARMS = {
  // Retain a single process-wide Error instead of one per render. Tests whether per-render
  // identity is what matters.
  A: `(globalThis.__rscAbortErr||(globalThis.__rscAbortErr=Error(${MSG})))`,
  // react/react#37289 as written: never capture a stack. Fixes retention, destroys the trace.
  B: `(function(){var __l=Error.stackTraceLimit;Error.stackTraceLimit=0;try{return Error(${MSG})}finally{Error.stackTraceLimit=__l}})()`,
  // Candidate real fix: capture the stack, then read it once. V8 formats the structured CallSiteInfo
  // frames into a string on first access and drops the frame objects, so the trace survives and the
  // retention does not.
  C: `(function(){var __e=Error(${MSG});void __e.stack;return __e})()`,
  // Not an Error at all. On this path the render completed with pendingChunks === 0, so there may be
  // no pending tasks left for signal.reason to error.
  D: `({message:${MSG}})`,
};

const arm = process.argv[2];
if (arm !== 'stock' && !ARMS[arm]) {
  console.error(`usage: node apply-arm.mjs stock|${Object.keys(ARMS).join('|')}`);
  process.exit(1);
}

fs.mkdirSync(PRISTINE, { recursive: true });
for (const f of TARGETS) {
  const live = path.join(DIR, f);
  const saved = path.join(PRISTINE, f);
  if (!fs.existsSync(live)) { console.log(`  skip (absent)   ${f}`); continue; }
  if (!fs.existsSync(saved)) fs.copyFileSync(live, saved);
  fs.copyFileSync(saved, live); // always start from pristine

  if (arm === 'stock') { console.log(`  stock           ${f}`); continue; }

  const src = fs.readFileSync(live, 'utf8');
  const hits = src.split(FIND).length - 1;
  if (hits !== 1) { console.error(`!! ${f}: expected 1 patch site, found ${hits}`); process.exit(1); }
  fs.writeFileSync(live, src.replace(FIND, ARMS[arm]));
  console.log(`  patched arm ${arm}   ${f}`);
}
console.log(`arm=${arm} applied`);
