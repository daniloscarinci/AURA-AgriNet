/* Zero-dependency test runner.

   The app has no build step and no node_modules, and the test suite keeps that
   property: `node tests/run.js` is the whole story. Assertions are the handful
   this suite actually needs -- adding a framework to run 250 checks against one
   HTML file would be more machinery than the thing it tests.

   Usage:
     node tests/run.js                 run everything
     node tests/run.js logic           run suites whose file matches "logic"
     node tests/run.js --verbose       print every passing check, not just totals
*/
'use strict';

const path = require('path');

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose') || args.includes('-v');
const FILTER = args.filter(a => !a.startsWith('-'));

const state = { file: '', suite: '', pass: 0, fail: 0, failures: [], suites: new Map() };

/* ------------------------------------------------------------ assertions --- */

class Failed extends Error {}

function fail(msg) { throw new Failed(msg); }

const assert = {
  ok(v, msg) { if (!v) fail(`${msg}: expected truthy, got ${fmt(v)}`); },
  notOk(v, msg) { if (v) fail(`${msg}: expected falsy, got ${fmt(v)}`); },
  equal(a, b, msg) { if (a !== b) fail(`${msg}: expected ${fmt(b)}, got ${fmt(a)}`); },
  notEqual(a, b, msg) { if (a === b) fail(`${msg}: expected anything but ${fmt(b)}`); },
  close(a, b, tol, msg) {
    if (typeof a !== 'number' || !isFinite(a)) fail(`${msg}: expected a finite number, got ${fmt(a)}`);
    if (Math.abs(a - b) > tol) fail(`${msg}: expected ${b} ±${tol}, got ${a} (off by ${(a - b).toFixed(4)})`);
  },
  between(v, lo, hi, msg) {
    if (typeof v !== 'number' || !isFinite(v)) fail(`${msg}: expected a finite number, got ${fmt(v)}`);
    if (v < lo || v > hi) fail(`${msg}: expected within [${lo}, ${hi}], got ${v}`);
  },
  greater(a, b, msg) { if (!(a > b)) fail(`${msg}: expected > ${fmt(b)}, got ${fmt(a)}`); },
  less(a, b, msg) { if (!(a < b)) fail(`${msg}: expected < ${fmt(b)}, got ${fmt(a)}`); },
  includes(hay, needle, msg) {
    const has = typeof hay === 'string' ? hay.includes(needle) : Array.isArray(hay) && hay.includes(needle);
    if (!has) fail(`${msg}: expected ${fmt(hay)} to include ${fmt(needle)}`);
  },
  notIncludes(hay, needle, msg) {
    const has = typeof hay === 'string' ? hay.includes(needle) : Array.isArray(hay) && hay.includes(needle);
    if (has) fail(`${msg}: expected ${fmt(hay)} not to include ${fmt(needle)}`);
  },
  deepEqual(a, b, msg) {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) fail(`${msg}: expected ${B}, got ${A}`);
  },
  throws(fn, msg) {
    try { fn(); } catch (e) { return; }
    fail(`${msg}: expected a throw, none happened`);
  },
};

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v.length > 90 ? v.slice(0, 90) + '…' : v);
  if (typeof v === 'number') return String(v);
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `[${v.slice(0, 8).map(fmt).join(', ')}${v.length > 8 ? ', …' : ''}]`;
  if (v instanceof Set) return `Set(${v.size})`;
  if (v instanceof Map) return `Map(${v.size})`;
  if (typeof v === 'object') { try { const s = JSON.stringify(v); return s.length > 90 ? s.slice(0, 90) + '…' : s; } catch { return '[object]'; } }
  return String(v);
}

/* ------------------------------------------------------------- structure --- */

const registry = [];

function suite(name, fn) { registry.push({ name, fn, file: state.file }); }

const pending = [];
function test(name, fn) { pending.push({ name, fn }); }

/* ---------------------------------------------------------------- runner --- */

const C = process.stdout.isTTY
  ? { dim: s => `\x1b[2m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`,
      bold: s => `\x1b[1m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m` }
  : { dim: s => s, red: s => s, green: s => s, bold: s => s, yellow: s => s };

async function main() {
  const files = ['logic.test.js', 'live.test.js', 'i18n.test.js', 'controls.test.js', 'assets.test.js']
    .filter(f => !FILTER.length || FILTER.some(x => f.includes(x)));

  if (!files.length) {
    console.error(`no test files match ${FILTER.join(', ')}`);
    process.exit(2);
  }

  const t0 = Date.now();

  for (const file of files) {
    state.file = file;
    require(path.join(__dirname, file))({ suite, test, assert, fail });
  }

  for (const s of registry) {
    pending.length = 0;
    state.suite = s.name;
    let setupError = null;
    try {
      await s.fn();                       // collects tests via test()
    } catch (e) {
      setupError = e;
    }

    const local = { pass: 0, fail: 0 };
    if (setupError) {
      local.fail++;
      state.fail++;
      state.failures.push({ suite: s.name, test: '<suite setup>', message: setupError.message, stack: setupError.stack });
    }

    for (const t of pending.slice()) {
      try {
        await t.fn();
        local.pass++; state.pass++;
        if (VERBOSE) console.log(`  ${C.green('✓')} ${C.dim(s.name + ' › ')}${t.name}`);
      } catch (e) {
        local.fail++; state.fail++;
        state.failures.push({
          suite: s.name, test: t.name, message: e.message,
          stack: e instanceof Failed ? null : e.stack,
        });
        if (VERBOSE) console.log(`  ${C.red('✗')} ${C.dim(s.name + ' › ')}${t.name}`);
      }
    }
    state.suites.set(s.name, local);

    if (!VERBOSE) {
      const mark = local.fail ? C.red('✗') : C.green('✓');
      const tail = local.fail ? C.red(`${local.fail} failed`) : C.dim(`${local.pass} checks`);
      console.log(`${mark} ${s.name.padEnd(46, ' ')} ${tail}`);
    }
  }

  const ms = Date.now() - t0;
  console.log('');

  if (state.failures.length) {
    console.log(C.bold(C.red(`${state.failures.length} failing:`)));
    state.failures.forEach((f, i) => {
      console.log(`\n${C.red(String(i + 1) + ')')} ${C.bold(f.suite)} › ${f.test}`);
      console.log(`   ${f.message}`);
      if (f.stack) console.log(C.dim(f.stack.split('\n').slice(1, 4).map(l => '   ' + l.trim()).join('\n')));
    });
    console.log('');
  }

  const total = state.pass + state.fail;
  const line = `${total} checks · ${state.pass} passed · ${state.fail} failed · ${ms}ms`;
  console.log(state.fail ? C.bold(C.red(line)) : C.bold(C.green(line)));
  process.exit(state.fail ? 1 : 0);
}

main().catch(e => {
  console.error(C.red('runner crashed:'), e && e.stack || e);
  process.exit(2);
});
