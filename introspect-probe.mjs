// introspect-probe.mjs — runs INSIDE WebContainer node with flags:
//   --expose-internals --expose-gc --experimental-vm-modules
// Reverse-engineers HOW WC implements the 3 RED-wall buckets that supposedly
// need V8 embedder APIs unavailable to browser JS:
//   1. promise hooks  (v8.promiseHooks / async_hooks PROMISE  -> V8 SetPromiseHook)
//   2. vm realms      (vm.SourceTextModule/SyntheticModule    -> ModuleWrap/contextify)
//   3. gc + WeakRef   (global.gc + internal/util.WeakReference -> V8 weak globals)
//
// Method (per user): for each function, .toString() distinguishes a real native
// binding ("[native code]") from a JS reimplementation (full source — which we
// then dump, "download sections of code"); and we deliberately throw inside each
// subsystem with stackTraceLimit=Infinity so the stack reveals WC's internal
// module paths and where the trail ends (native vs a JS file).
//
// Emits ONE JSON object to stdout. Everything is try/caught so one failure can't
// blank the report.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

Error.stackTraceLimit = Infinity;
const R = {};
const pending = [];           // async sub-probes queued by safeInto(); awaited at the end
const safe = (k, fn) => { try { R[k] = fn(); } catch (e) { R[k] = { __error: String(e && e.stack || e) }; } };
// safeInto: run a sub-probe; if it returns a promise, queue it and fill the key when it settles.
function safeInto(out, key, fn) {
  try {
    const v = fn();
    if (v && typeof v.then === 'function') { pending.push(v.then((r) => { out[key] = r; }, (e) => { out[key] = { __error: String(e && e.stack || e) }; })); out[key] = { __pending: true }; }
    else out[key] = v;
  } catch (e) { out[key] = { __error: String(e && e.stack || e) }; }
}
const fnInfo = (f) => {
  if (typeof f !== 'function') return { type: typeof f };
  let s = '';
  try { s = Function.prototype.toString.call(f); } catch (e) { s = '<toString threw: ' + e + '>'; }
  const native = /\{\s*\[native code\]\s*\}/.test(s);
  return { native, len: s.length, src: native ? s : s.slice(0, 4000) };
};
// gc() may be sync, async, or (in a reimpl) never resolve — cap every call.
const gcOnce = () => Promise.race([
  Promise.resolve().then(() => (typeof globalThis.gc === 'function' ? globalThis.gc() : undefined)),
  new Promise((r) => setTimeout(r, 2000)),
]);
const dumpFns = (obj, names) => {
  const out = {};
  for (const n of names) { try { out[n] = fnInfo(obj && obj[n]); } catch (e) { out[n] = { __error: String(e) }; } }
  return out;
};

// ---------- 0. runtime identity (process.versions.v8 is the single best tell) ----------
safe('runtime', () => ({
  version: process.version,
  versions: process.versions,
  release: process.release,
  execPath: process.execPath,
  platform: process.platform,
  arch: process.arch,
  execArgv: process.execArgv,
  features: { ...process.features },
  config: process.config,
  builtinModulesCount: (require('node:module').builtinModules || []).length,
  moduleLoadList: (process.moduleLoadList || []).slice(0, 120),
}));

// ---------- 1. low-level bindings: do the real C++ bindings exist? ----------
safe('bindings', () => {
  const out = {};
  const tryBinding = (name) => {
    const rec = {};
    try { const b = process.binding(name); rec.processBinding = Object.keys(b).sort(); }
    catch (e) { rec.processBinding = { __error: String(e).slice(0, 200) }; }
    try {
      // internalBinding is exposed under --expose-internals via internal/test/binding
      const ib = require('internal/test/binding').internalBinding;
      const b = ib(name); rec.internalBinding = Object.keys(b).sort();
    } catch (e) { rec.internalBinding = { __error: String(e).slice(0, 200) }; }
    return rec;
  };
  for (const n of ['async_wrap', 'util', 'contextify', 'module_wrap', 'task_queue', 'timers', 'config', 'builtins'])
    out[n] = tryBinding(n);
  return out;
});

// ---------- 2. PROMISE HOOKS ----------
safe('promiseHooks', () => {
  const out = {};
  let v8;
  try { v8 = require('node:v8'); } catch (e) { return { __error: 'no v8: ' + e }; }
  out.v8_promiseHooks_keys = v8.promiseHooks ? Object.keys(v8.promiseHooks) : null;
  out.fns = v8.promiseHooks ? dumpFns(v8.promiseHooks, ['onInit', 'onBefore', 'onAfter', 'onResolve', 'createHook']) : null;

  // Is global Promise native / unpatched?
  out.Promise = { src: fnInfo(Promise), ctorMatch: (() => { try { return Promise.resolve().constructor === Promise; } catch { return false; } })() };

  // Live behavior — literal core of test-promise-hook-on-init.js
  safeInto(out, 'live_onInit', () => {
    const seen = [];
    const stop = v8.promiseHooks.onInit((_p, parent) => seen.push({ parentIsUndefined: undefined === parent }));
    const parent = Promise.resolve();
    parent.then();
    stop();
    const afterStop = seen.length;
    Promise.resolve();
    return { firedCount: seen.length, firedForParentAndChild: seen.length >= 2, noFireAfterStop: seen.length === afterStop, sample: seen.slice(0, 4) };
  });

  // Live behavior — async_hooks PROMISE init/resolve (core of test-async-hooks-promise.js)
  safeInto(out, 'live_asyncHooks', () => {
    const async_hooks = require('node:async_hooks');
    const inits = []; const resolves = [];
    const hook = async_hooks.createHook({
      init: (id, type, triggerId) => { if (type === 'PROMISE') inits.push({ id, triggerId }); },
      promiseResolve: (id) => resolves.push(id),
    }).enable();
    const a = Promise.resolve(42);
    a.then(() => {});
    hook.disable();
    return {
      promiseInitsSeen: inits.length,
      sawPromiseType: inits.length > 0,
      firstTriggerId: inits[0] && inits[0].triggerId,
      chainTriggerMatches: inits[1] && inits[0] && inits[1].triggerId === inits[0].id,
      resolvesSeen: resolves.length,
    };
  });

  // Deliberate throw INSIDE a promise hook -> stack reveals WC's hook dispatch path
  safeInto(out, 'throwStack', () => {
    let captured = null;
    const onUnc = (e) => { captured = e.stack; };
    process.prependOnceListener('uncaughtException', onUnc);
    try {
      const stop = v8.promiseHooks.onInit(() => { throw new Error('PROMISE_HOOK_PROBE'); });
      try { Promise.resolve(); } catch (e) { captured = e.stack; }
      stop();
    } catch (e) { captured = e.stack; }
    process.removeListener('uncaughtException', onUnc);
    return captured;
  });
  return out;
});

// ---------- 3. GC + WeakReference ----------
safe('gc', () => {
  const out = {};
  out.global_gc = fnInfo(globalThis.gc);
  out.execArgvHasExposeGc = process.execArgv.includes('--expose-gc');
  out.WeakRef_std = typeof WeakRef;

  // Standard WeakRef + global.gc(): does forcing GC actually collect?
  safeInto(out, 'live_weakref', async () => {
    if (typeof globalThis.gc !== 'function') return { skipped: 'no global.gc' };
    let obj = { tag: 'collectme' };
    const ref = new WeakRef(obj);
    obj = null;
    let collectedAt = -1;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
      await gcOnce();
      if (ref.deref() === undefined) { collectedAt = i; break; }
    }
    return { collected: collectedAt >= 0, iterations: collectedAt };
  });

  // internal/util.WeakReference (the actual binding test-internal-util-weakreference uses)
  safeInto(out, 'internal_WeakReference', async () => {
    const iu = require('internal/util');
    const WR = iu.WeakReference;
    const info = { exists: typeof WR, ctor: fnInfo(WR) };
    if (typeof WR !== 'function') return info;
    try { info.get_src = fnInfo(WR.prototype.get); } catch {}
    let obj = { hello: 'world' };
    const ref = new WR(obj);
    info.getMatchesBeforeGc = ref.get() === obj;
    obj = null;
    if (typeof globalThis.gc === 'function') {
      let at = -1;
      for (let i = 0; i < 10; i++) { await new Promise((r) => setImmediate(r)); await gcOnce(); if (ref.get() === undefined) { at = i; break; } }
      info.collected = at >= 0; info.iterations = at;
    } else info.collected = 'no global.gc';
    return info;
  });

  safeInto(out, 'v8_heap', () => {
    const v8 = require('node:v8');
    return { getHeapStatistics: typeof v8.getHeapStatistics, queryObjects: typeof v8.queryObjects, sample: (() => { try { return Object.keys(v8.getHeapStatistics()); } catch { return null; } })() };
  });
  return out;
});

// ---------- 4. VM REALMS / MODULES ----------
safe('vm', () => {
  const out = {};
  const vm = require('node:vm');
  out.surface = {
    SourceTextModule: typeof vm.SourceTextModule,
    SyntheticModule: typeof vm.SyntheticModule,
    Module: typeof vm.Module,
    compileFunction: typeof vm.compileFunction,
    runInNewContext: typeof vm.runInNewContext,
    measureMemory: typeof vm.measureMemory,
    constants: vm.constants ? Object.keys(vm.constants) : null,
  };
  out.fns = dumpFns(vm, ['SourceTextModule', 'SyntheticModule', 'Module', 'compileFunction', 'runInNewContext']);

  // Realm isolation: is a new context a separate realm (distinct intrinsics)?
  safeInto(out, 'realm', () => ({
    objectIsShared: vm.runInNewContext('Object') === Object,                 // true => NOT isolated
    symbolForShared: vm.runInNewContext('Symbol.for("x")') === Symbol.for('x'), // registry IS cross-realm even when isolated
    arrayCrossRealm: vm.runInNewContext('[]') instanceof Array,             // false in a true separate realm
    eval: vm.runInNewContext('1+2'),
  }));

  // Core of test-vm-module-synthetic.js, inline
  safeInto(out, 'live_synthetic', async () => {
    if (typeof vm.SyntheticModule !== 'function' || typeof vm.SourceTextModule !== 'function') return { skipped: 'no module classes' };
    const s = new vm.SyntheticModule(['x'], function () { this.setExport('x', 1); });
    const m = new vm.SourceTextModule(`import { x } from 'synthetic'; export const getX = () => x;`);
    await m.link(() => s);
    await m.evaluate();
    const first = m.namespace.getX();
    s.setExport('x', 42);
    const second = m.namespace.getX();
    return { firstX: first, secondX: second, ok: first === 1 && second === 42 };
  });

  safeInto(out, 'importModuleDynamically', () => {
    try {
      vm.compileFunction('return import("x")', [], { importModuleDynamically: () => {} });
      return { supported: true };
    } catch (e) { return { supported: false, err: String(e).slice(0, 200) }; }
  });

  // Deliberate throw inside a vm context -> stack reveals contextify/module path
  safeInto(out, 'throwStack', () => {
    try { vm.runInNewContext('throw new Error("VM_PROBE")'); } catch (e) { return e.stack; }
    return null;
  });
  return out;
});

// ---------- 5. ENGINE DISCRIMINATOR: browser-V8 (JS-faked embedder) vs V8-in-WASM ----------
// Perf: jitless V8-in-WASM runs hot numeric code ~10-30x slower than native-JIT browser V8.
safe('perf', () => {
  const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
  const t0 = performance.now();
  let x = 0; for (let i = 0; i < 1e8; i++) { x += i % 7; }
  const loopMs = performance.now() - t0;
  const t1 = performance.now(); const f = fib(34); const fibMs = performance.now() - t1;
  return { loop1e8Ms: Math.round(loopMs), fib34Ms: Math.round(fibMs), fib34: f, x };
});

// Promise-hook coverage: real V8 SetPromiseHook sees ALL promises incl. async-fn-internal
// ones; a JS global-Promise wrapper only sees promises made via the global Promise.
safe('engineDiscriminator', () => {
  const out = {};
  out.promiseNative = fnInfo(Promise).native;
  out.promiseCtorMatch = (() => { try { return Promise.resolve().constructor === Promise; } catch { return null; } })();
  out.asyncFnReturnsGlobalPromise = (() => { try { const p = (async () => {})(); const r = { isGlobalPromise: p.constructor === Promise, ctorName: p.constructor && p.constructor.name, ctorNative: fnInfo(p.constructor).native }; p.catch(() => {}); return r; } catch (e) { return String(e); } })();
  safeInto(out, 'hookCoverage', async () => {
    const async_hooks = require('node:async_hooks');
    const counts = { explicitThen: 0, newPromise: 0, asyncFn: 0, other: 0 };
    let mode = 'other';
    const hook = async_hooks.createHook({ init: (id, type) => { if (type === 'PROMISE') counts[mode]++; } }).enable();
    mode = 'explicitThen'; Promise.resolve().then(() => {});
    mode = 'newPromise'; new Promise((r) => r());
    mode = 'asyncFn'; await (async () => { await 0; await 0; await 0; })();
    mode = 'other';
    hook.disable();
    // interpretation: asyncFn>0 => real V8 hooks; asyncFn==0 while explicitThen>0 => JS Promise-wrapper fake
    return { ...counts, verdict: counts.asyncFn > 0 ? 'real-V8-hooks' : (counts.explicitThen > 0 ? 'JS-Promise-wrapper-fake' : 'inconclusive') };
  });
  return out;
});

await Promise.all(pending);   // settle async sub-probes queued during the synchronous safe() blocks
process.stdout.write(JSON.stringify(R, null, 2));
