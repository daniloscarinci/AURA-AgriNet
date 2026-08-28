/* AURA-AgriNet test harness.
   ---------------------------------------------------------------------------
   index.html ships as one file: every module is a `const` inside a single IIFE
   scope, so nothing is importable and nothing is attached to `window`. Rather
   than restructure a working app to suit its tests, the harness boots the real
   inline script inside a `vm` context against a stub DOM and appends a probe
   line that hands the module objects back out. The code under test is therefore
   byte-for-byte the code that ships -- no build step, no test-only export list
   that can drift from the app.

   Two things are deliberately deterministic, because the app is a simulation:

     - Math.random is replaced by a seeded PRNG (mulberry32). A "bounded random
       walk stays in bounds" test is worthless if it passes on one seed and
       fails on the next, so the seed is fixed and the walk is reproducible.
     - setTimeout/setInterval are virtual. The ingestion layer models a
       high-latency downlink (2-4s one-way), so real timers would make the suite
       take minutes and still be flaky. `advance(ms)` moves the virtual clock and
       flushes microtasks between callbacks, so awaiting a downlink is exact.  */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* ---------------------------------------------------------------- source ---- */

function readSource() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc)[^>]*>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) {
    throw new Error(`expected exactly 1 inline <script>, found ${scripts.length}`);
  }
  // Markup only: strips the script so element scans never match JS string content.
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  return { html, markup, script: scripts[0][1] };
}

/* ------------------------------------------------------------ seeded rng ---- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------- virtual time ---- */

function makeTimers() {
  let now = 0;
  let seq = 0;
  const q = new Map();
  const flush = () => new Promise(r => setImmediate(r));

  const api = {
    setTimeout(fn, ms, ...args) {
      const id = ++seq;
      q.set(id, { at: now + (Number(ms) || 0), fn, args, every: null });
      return id;
    },
    setInterval(fn, ms, ...args) {
      const id = ++seq;
      const every = Math.max(1, Number(ms) || 1);
      q.set(id, { at: now + every, fn, args, every });
      return id;
    },
    clearTimeout(id) { q.delete(id); },
    clearInterval(id) { q.delete(id); },
    now: () => now,
    pending: () => q.size,

    /** Advance virtual time, running every callback that comes due in order and
        flushing the microtask queue after each so promise chains settle. */
    async advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        if (++guard > 100000) throw new Error('timer storm: 100k callbacks in one advance()');
        let pick = null, pickId = null;
        for (const [id, t] of q) {
          if (t.at > target) continue;
          if (pick === null || t.at < pick.at || (t.at === pick.at && id < pickId)) { pick = t; pickId = id; }
        }
        if (!pick) break;
        now = pick.at;
        if (pick.every !== null) pick.at = now + pick.every;
        else q.delete(pickId);
        pick.fn(...pick.args);
        await flush();
      }
      now = target;
      await flush();
    },
  };
  return api;
}

/* ------------------------------------------------------------- stub  DOM ---- */

function makeNode(tag, id, doc) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    parentNode: null,
    childNodes: [],
    dataset: {},
    style: {},
    attributes: {},
    _text: '',
    _html: '',
    _listeners: {},
    // Layout: the map and chat scroller read these; fixed values keep geometry
    // assertions meaningful without a layout engine.
    scrollHeight: 1000, scrollTop: 0, clientHeight: 400,
    clientWidth: 800, offsetWidth: 800, offsetHeight: 400,

    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? '' : String(v); },
    get innerHTML() { return this._html; },
    /* No HTML parser here. Setting innerHTML records the markup (which is what
       assertions read) and synthesises ONE element child, because app code
       legitimately does `holder.innerHTML = …; parent.appendChild(holder.firstElementChild)`.
       Child COUNTS are therefore not meaningful — assert against the markup
       string, never against children.length. */
    set innerHTML(v) {
      this._html = v == null ? '' : String(v);
      this.childNodes = [];
      if (this._html.trim()) {
        const kid = makeNode('div', '', doc);
        kid._html = this._html;
        kid.parentNode = this;
        this.childNodes.push(kid);
      }
    },
    get children() { return this.childNodes; },
    get firstChild() { return this.childNodes[0] || null; },
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    get firstElementChild() { return this.childNodes[0] || null; },
    get lastElementChild() { return this.childNodes[this.childNodes.length - 1] || null; },
    get value() { return this.attributes.value == null ? '' : this.attributes.value; },
    set value(v) { this.attributes.value = String(v); },
    get className() { return [...this.classList._set].join(' '); },
    set className(v) { this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); },

    classList: {
      _set: new Set(),
      add(...c) { c.filter(Boolean).forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, force) {
        const on = force === undefined ? !this._set.has(c) : !!force;
        on ? this._set.add(c) : this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); },
      get length() { return this._set.size; },
    },

    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = v; },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
    hasAttribute(k) { return k in this.attributes; },
    removeAttribute(k) { delete this.attributes[k]; },

    appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
    removeChild(c) { this.childNodes = this.childNodes.filter(x => x !== c); c.parentNode = null; return c; },
    insertBefore(c) { return this.appendChild(c); },
    replaceChildren(...c) { this.childNodes = []; c.forEach(x => this.appendChild(x)); },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    contains(other) { return this.childNodes.includes(other); },

    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter(f => f !== fn);
    },
    dispatch(type, evt) { (this._listeners[type] || []).forEach(fn => fn(evt || { type, target: node })); },

    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest(sel) { return doc && doc._closest ? doc._closest(this, sel) : null; },

    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 400, width: 800, height: 400 }; },
    scrollTo() {}, scrollIntoView() {}, focus() {}, blur() {}, click() { this.dispatch('click', { type: 'click', target: this }); },
    // SVG path geometry, used by the driver animation.
    getTotalLength() { return 1000; },
    getPointAtLength(l) { return { x: l * 0.6, y: l * 0.34 }; },
    animate() { return { cancel() {}, finished: Promise.resolve() }; },
  };
  return node;
}

function makeDocument(markup) {
  const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
  const nodes = new Map();
  const requested = new Set();   // every id the script asked for

  /* Opening tag per id, so a stub node starts life with the attributes the real
     element has. This matters more than it looks: `#manualLayer` ships with a
     bare `hidden`, and a stub that reported `hidden === undefined` would make
     `isOpen()` answer true before anything had opened. */
  const tagById = new Map();
  for (const m of markup.matchAll(/<([a-zA-Z][\w-]*)((?:\s[^>]*)?)>/g)) {
    const id = m[2].match(/\sid="([^"]+)"/);
    if (id) tagById.set(id[1], { tag: m[1], attrs: m[2] });
  }

  function hydrate(node, id) {
    const spec = tagById.get(id);
    if (!spec) return node;
    node.tagName = spec.tag.toUpperCase();
    node.hidden = /\shidden(?=[\s/>]|$)/.test(' ' + spec.attrs);
    for (const a of spec.attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      const [, k, v] = a;
      if (k === 'class') node.className = v;
      else if (k === 'id') continue;
      else {
        node.attributes[k] = v;
        if (k.startsWith('data-')) node.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        if (k === 'value') node.attributes.value = v;
      }
    }
    return node;
  }

  const doc = {
    hidden: false,
    readyState: 'complete',
    _listeners: {},
    _ids: ids,
    _requested: requested,
    _nodes: nodes,
    _closest: () => null,
  };
  doc.documentElement = makeNode('html', '', doc);
  doc.body = makeNode('body', '', doc);
  doc.head = makeNode('head', '', doc);

  doc.getElementById = function (id) {
    requested.add(id);
    if (!nodes.has(id)) nodes.set(id, hydrate(makeNode('div', id, doc), id));
    return nodes.get(id);
  };
  doc.createElement = t => makeNode(t, '', doc);
  doc.createElementNS = (ns, t) => makeNode(t, '', doc);
  doc.createTextNode = t => ({ nodeType: 3, textContent: String(t) });
  doc.createDocumentFragment = () => makeNode('fragment', '', doc);

  /* querySelectorAll is answered from the markup, so control-reachability tests
     see the same elements the browser would. Only the selector shapes the app
     actually uses are supported -- an unsupported selector throws rather than
     silently returning [] and turning a real miss into a passing test. */
  doc.querySelectorAll = function (sel) {
    // Digits belong in an attribute name: the translator's own hook is data-i18n.
    /* An optional tag in front: `button[data-role]` rather than `[data-role]`.
       The app needs the distinction because setRole writes data-role onto
       <body>, and a bare attribute selector therefore also selects the document
       body -- which is how every click in the app came to re-run setRole. */
    const attr = sel.match(/^([a-z]*)\[data-([a-z0-9-]+)\]$/);
    if (attr) {
      const [, tag, name] = attr;
      const re = tag
        ? new RegExp(`<${tag}\\b[^>]*\\bdata-${name}="([^"]*)"`, 'g')
        : new RegExp(`data-${name}="([^"]*)"`, 'g');
      return [...markup.matchAll(re)].map(m => {
        const n = makeNode('button', '', doc);
        n.dataset[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = m[1];
        n.setAttribute(`data-${name}`, m[1]);
        return n;
      });
    }
    const cls = sel.match(/^\.([A-Za-z0-9_-]+)$/);
    if (cls) {
      const re = new RegExp(`class="[^"]*\\b${cls[1]}\\b[^"]*"[^>]*`, 'g');
      return [...markup.matchAll(new RegExp(`<([a-z]+)[^>]*class="[^"]*\\b${cls[1]}\\b[^"]*"[^>]*>`, 'g'))].map(m => {
        const n = makeNode(m[1], '', doc);
        const tag = m[0];
        [...tag.matchAll(/data-([a-z-]+)="([^"]*)"/g)].forEach(d => {
          n.dataset[d[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d[2];
          n.setAttribute(`data-${d[1]}`, d[2]);
        });
        return n;
      });
    }
    throw new Error(`stub DOM: unsupported selector ${JSON.stringify(sel)}`);
  };
  doc.querySelector = sel => doc.querySelectorAll(sel)[0] || null;
  /* The options argument is honoured rather than dropped. A listener bound with
     {once:true} is a different thing from a permanent one -- the alarm's audio
     unlock was bound once and could never re-arm a context the system suspended
     again -- and a stub that ignores the difference makes that class of bug
     invisible to every test that looks for it. */
  doc.addEventListener = function (t, fn, opts) {
    (doc._listeners[t] ||= []).push({ fn, once: !!(opts && opts.once) });
  };
  doc.removeEventListener = function (t, fn) {
    if (doc._listeners[t]) doc._listeners[t] = doc._listeners[t].filter(e => e.fn !== fn);
  };
  doc.dispatch = (t, evt) => {
    const entries = (doc._listeners[t] || []).slice();
    doc._listeners[t] = (doc._listeners[t] || []).filter(e => !e.once);
    entries.forEach(e => e.fn(evt || { type: t }));
  };
  return doc;
}

/* --------------------------------------------------------------- audio ----- */

/* A Web Audio stub that records instead of sounding.

   The app synthesises its alarm at call time, so without this the audio path was
   simply never executed by the suite: window.AudioContext was undefined, so
   Alarm.context() returned null and every test ran the branch where there is no
   engine at all. Recording rather than stubbing to no-ops is the point -- what a
   test needs to assert about a sound it cannot hear is the graph: what connects
   to what, at what gain, at what time.

   mode: 'running' (default), 'suspended', 'blocked' (a context that exists but
   whose resume() is refused -- the backgrounded-iOS shape), or pass audio:false
   to boot() for an engine with no Web Audio whatsoever. */
function makeAudioContext(mode) {
  class Param {
    constructor() { this.ops = []; }
    setValueAtTime(v, t) { this.ops.push(['set', v, t]); return this; }
    exponentialRampToValueAtTime(v, t) {
      // The real API throws on zero, and a linear ramp to zero clicks. Both are
      // defects a test must see rather than absorb.
      if (v === 0) throw new RangeError('exponentialRampToValueAtTime: value must not be 0');
      this.ops.push(['exp', v, t]); return this;
    }
    linearRampToValueAtTime(v, t) { this.ops.push(['lin', v, t]); return this; }
    cancelScheduledValues() { return this; }
    get peak() { return this.ops.reduce((m, o) => Math.max(m, o[1]), 0); }
  }
  class Node {
    constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.outs = []; }
    connect(dst) { this.outs.push(dst); return dst; }
    disconnect() { this.outs = []; }
    /** Whether this node's signal can reach the speaker at all. */
    reaches(dst, seen = new Set()) {
      if (this === dst) return true;
      if (seen.has(this)) return false;
      seen.add(this);
      return this.outs.some(o => o.reaches && o.reaches(dst, seen));
    }
  }
  class Osc extends Node {
    constructor(ctx) {
      super(ctx, 'osc');
      this.type = 'sine'; this.frequency = new Param(); this.detune = new Param();
    }
    start(t) { this.startedAt = t; this.ctx.oscs.push(this); }
    stop(t) { this.stoppedAt = t; }
  }
  class Gain extends Node {
    constructor(ctx) { super(ctx, 'gain'); this.gain = new Param(); }
  }
  return class AudioContextStub {
    constructor() {
      this.state = mode === 'blocked' ? 'suspended' : mode;
      this._t = 0;
      this.destination = new Node(this, 'destination');
      this.oscs = [];
      this.resumeCalls = 0;
      AudioContextStub.last = this;
    }
    get currentTime() { return this._t; }
    /** Move the context clock, the way time passing between two alarms would. */
    advanceTo(t) { this._t = t; }
    createOscillator() { return new Osc(this); }
    createGain() { return new Gain(this); }
    resume() {
      this.resumeCalls++;
      if (mode === 'blocked') return Promise.reject(new Error('NotAllowedError'));
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  };
}

/* ----------------------------------------------------------------- boot ----- */

/** Boot the shipped inline script headlessly.
    @param {object} opts
    @param {number} opts.seed      PRNG seed (fixed by default, so runs repeat)
    @param {number} opts.clock     initial Date.now() the app sees
    @param {string} opts.search    location.search, e.g. '?role=DRIVER'
    @param {boolean} opts.mobile   what matchMedia('(max-width:1023px)') returns
    @param {object} opts.storage   pre-seeded localStorage contents */
function boot(opts = {}) {
  const { markup, script, html } = readSource();
  const seed = opts.seed === undefined ? 20260808 : opts.seed;
  const clock = opts.clock === undefined ? Date.UTC(2026, 7, 8, 9, 0, 0) : opts.clock;

  const document = makeDocument(markup);
  const timers = makeTimers();
  const rng = mulberry32(seed);
  const store = new Map(Object.entries(opts.storage || {}));
  const warnings = [];
  const errors = [];

  // Math clone so only `random` is swapped; everything else stays native.
  const SeededMath = Object.create(Math);
  Object.defineProperty(SeededMath, 'random', { value: () => rng() });

  const FixedDate = new Proxy(Date, {
    apply: (t, self, args) => new Date(...(args.length ? args : [clock])).toString(),
    construct: (t, args) => (args.length ? new Date(...args) : new Date(clock)),
    get: (t, p) => (p === 'now' ? () => clock : Reflect.get(t, p)),
  });

  const sandbox = {
    document,
    Math: SeededMath,
    Date: FixedDate,
    console: {
      log: () => {},
      warn: (...a) => warnings.push(a.join(' ')),
      error: (...a) => errors.push(a.map(x => (x && x.stack) || String(x)).join(' ')),
      info: () => {},
      debug: () => {},
    },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
      clear: () => store.clear(),
      key: i => [...store.keys()][i] ?? null,
      get length() { return store.size; },
    },
    /* Network is OFF by default so the suite is hermetic and deterministic: a
       test that silently reaches the real Open-Meteo would pass or fail with the
       weather. Pass `fetch` to inject a stub, or `online:false` to exercise the
       offline path explicitly. */
    fetch: opts.fetch || (() => Promise.reject(new Error('network disabled in tests'))),
    AbortController: typeof AbortController === 'function' ? AbortController : undefined,
    /* vibrate is recorded, not stubbed away. The buzz is half the alarm -- the
       half that survives a phone on silent in a coat pocket, which is where the
       phone actually is -- and a second vibrate() call REPLACES the pattern
       already running rather than queueing behind it, which is a defect only a
       recording stub can catch. */
    navigator: {
      onLine: opts.online !== false, userAgent: 'aura-tests', language: 'en',
      vibrate(pattern) { sandbox.__vibes.push({ pattern, at: Date.now() }); return true; },
    },
    location: { search: opts.search || '', protocol: 'http:', hostname: 'localhost',
                href: 'http://localhost/', reload: () => {} },
    performance: { now: () => timers.now() },
    requestAnimationFrame: fn => timers.setTimeout(() => fn(timers.now()), 16),
    cancelAnimationFrame: id => timers.clearTimeout(id),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    queueMicrotask,
    Promise, Object, Array, String, Number, Boolean, JSON, Map, Set, WeakMap, WeakSet,
    Error, TypeError, RangeError, RegExp, Symbol, Infinity, NaN, isFinite, isNaN,
    parseInt, parseFloat, URLSearchParams, URL, Intl,
  };

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__vibes = [];
  // Present by default: the audio path is part of the app, and a suite that only
  // ever ran the no-engine branch was testing the alarm's decision, not its sound.
  if (opts.audio !== false) sandbox.AudioContext = makeAudioContext(opts.audio || 'running');
  sandbox.window._listeners = {};
  sandbox.window.addEventListener = (t, fn, opts) => {
    (sandbox.window._listeners[t] ||= []).push({ fn, once: !!(opts && opts.once) });
  };
  sandbox.window.removeEventListener = (t, fn) => {
    if (sandbox.window._listeners[t]) sandbox.window._listeners[t] = sandbox.window._listeners[t].filter(e => e.fn !== fn);
  };
  sandbox.window.dispatch = (t, evt) => {
    const entries = (sandbox.window._listeners[t] || []).slice();
    sandbox.window._listeners[t] = (sandbox.window._listeners[t] || []).filter(e => !e.once);
    entries.forEach(e => e.fn(evt || { type: t }));
  };
  sandbox.window.matchMedia = q => ({
    media: q,
    matches: /max-width:\s*1023px/.test(q) ? !!opts.mobile : false,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  sandbox.window.scrollTo = () => {};
  sandbox.window.innerWidth = opts.mobile ? 390 : 1440;
  sandbox.window.innerHeight = opts.mobile ? 844 : 900;
  // No serviceWorker key at all: the app feature-detects with `'serviceWorker' in navigator`.

  vm.createContext(sandbox);

  const PROBE = `
;globalThis.__AURA__ = {
  Geo, Region, State, Telemetry, Dispatch, Orders, Scoring, Log, Alarm, Console, EventEngine, Triage, Views, Manual, Live, Places, Cities, Agronomy, Sat, Search, I18n, Theme, IosHint, Farm, SOILS, ICONS, icon, paintIcons,
  CFG, SOURCES, METRICS, CROPS, REGIONS, EDGE_SPEC, PEOPLE, SEV, MAP_VIEW,
  DEFAULT_REGION, PLOTS, ROUTE_ORIGIN, ROUTE_DEST,
  get NODES(){ return NODES; }, get EDGES(){ return EDGES; }, get REGION(){ return REGION; },
  fmt, esc, clockStr, clockStrFull, metricSeverity, sevColour, statusWord
};`;

  vm.runInContext(script + PROBE, sandbox, { filename: 'index.html (inline)', timeout: 30000 });

  return {
    app: sandbox.__AURA__,
    window: sandbox,
    document,
    timers,
    storage: store,
    /** The AudioContext the app actually built, once a first sound has built one. */
    get audio() { return sandbox.AudioContext && sandbox.AudioContext.last; },
    /** Every navigator.vibrate call, in order, with the time it was made. */
    vibes: sandbox.__vibes,
    warnings,
    errors,
    markup,
    html,
    /** Drive the ingestion pipeline the way the browser would. */
    advance: timers.advance,
  };
}

module.exports = { boot, readSource, makeTimers, mulberry32, ROOT };
