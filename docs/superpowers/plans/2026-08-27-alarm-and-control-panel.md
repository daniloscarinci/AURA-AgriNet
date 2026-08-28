# Alarm Fixes and Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four defects in the critical-message alarm, add a quieter `serious` tone under it, and replace the mobile-only simulation sheet with one control panel that reaches the app's basic commands on both screens.

**Architecture:** The app is one 462 KB `index.html` with an inline script organised into numbered modules. The alarm is MODULE 5b; the panel becomes a new MODULE 6c beside it. Tests boot the shipped inline script headlessly through `tests/harness.js` — which today defines no `AudioContext`, so the alarm's audio path has never executed under test. That gap is closed first, because nothing else in this plan is verifiable until it is.

**Tech Stack:** Vanilla ES2015+, no build step, no dependencies. Prebuilt Tailwind (new utility classes do nothing — write real CSS). Zero-dependency test runner: `node tests/run.js`. Android packaging via Gradle 8.9 + AGP, JDK 17.

**Spec:** `docs/superpowers/specs/2026-08-27-alarm-and-control-panel-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tests/harness.js` | headless sandbox around the inline script | add recording `AudioContext`; honour `{once:true}` |
| `index.html` MODULE 5b (~3242–3336) | the alarm | master gain, tokens, coalescing, re-arm, second tone |
| `index.html` MODULE 3 State (~2440–2590) | persisted state | add `haptics` |
| `index.html` MODULE 7 Views (~4081, 4937, 6158) | rendering | third trigger mount, panel render, drop `openSheet` |
| `index.html` new MODULE 6c | the control panel | new |
| `index.html` markup (~1626, 1971–2010) | header button; panel replaces `#simSheet` | new / delete |
| `index.html` CSS (~1009–1040) | panel styling | new rules |
| `tests/controls.test.js` | control-surface suites | two new suites |
| `i18n/{es,fr,pt}.json` | catalogues | every new English string |
| `sw.js` | offline shell | `CACHE_VERSION` bump |
| `android/app/build.gradle.kts` | package | version bump |
| `README.md` | documentation | panel + tones |

**Ordering constraint:** Task 1 before everything. Tasks 2–5 touch the same ~90 lines of MODULE 5b and must run in order. Task 10 (i18n) must land in the **same commit** as the strings it translates, or `i18n · catalogues` fails — the catalogues are at exactly 1.0 coverage over 556 strings, and `meta.coverage` is asserted within 0.02 of the real ratio.

---

## Task 1: Teach the harness to hear

The harness builds a sandbox with no `AudioContext` (`tests/harness.js:356`), so `Alarm.context()` returns `null` in every test and `play()` has never run. It also ignores the options argument to `addEventListener`, so a `{once:true}` listener is indistinguishable from a permanent one — which is why defect 1.3 has no test.

**Files:**
- Modify: `tests/harness.js:280-298` (document listeners), `tests/harness.js:356-370` (sandbox)

- [ ] **Step 1: Make document listeners honour `{once:true}`**

In `makeDocument`, replace the listener pair:

```js
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
```

- [ ] **Step 2: Mirror it on `window`**

Same three replacements against `sandbox.window._listeners`, `sandbox.window.addEventListener`, `removeEventListener` and `dispatch`.

- [ ] **Step 3: Add the recording AudioContext**

Above `vm.createContext(sandbox)`:

```js
/* A Web Audio stub that records instead of sounding.

   The app synthesises its alarm at call time, so without this the audio path is
   simply never executed by the suite: `window.AudioContext` was undefined, so
   Alarm.context() returned null and every test exercised the branch where there
   is no engine. Recording rather than stubbing to no-ops is the point -- what
   the tests need to assert is the graph: what connects to what, at what gain,
   at what time.

   opts.audio: 'running' (default), 'suspended', 'blocked' (resume rejects, the
   backgrounded-iOS shape), or false for an engine with no Web Audio at all. */
function makeAudioContext(mode) {
  class Param {
    constructor() { this.ops = []; }
    setValueAtTime(v, t) { this.ops.push(['set', v, t]); return this; }
    exponentialRampToValueAtTime(v, t) {
      // The real API throws on zero, and a linear ramp to zero clicks. Both are
      // bugs a test must see rather than absorb.
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
```

- [ ] **Step 4: Wire it into the sandbox and record vibration**

In the `sandbox` object literal, replace the `navigator` line:

```js
    navigator: {
      onLine: opts.online !== false, userAgent: 'aura-tests', language: 'en',
      /* Recorded, not stubbed away: the buzz is half the alarm -- it is the half
         that survives a phone on silent in a pocket -- and a second vibrate()
         call cancels the pattern already running, which is a defect only a
         recording stub can catch. */
      vibrate(pattern) { sandbox.__vibes.push({ pattern, at: timers.now() }); return true; },
    },
```

After `sandbox.window = sandbox;` add:

```js
  sandbox.__vibes = [];
  if (opts.audio !== false) {
    sandbox.AudioContext = makeAudioContext(opts.audio || 'running');
  }
```

- [ ] **Step 5: Expose both on the boot return**

In the returned object, after `storage: store,`:

```js
    /** The AudioContext the app actually built, once it has built one. */
    get audio() { return sandbox.AudioContext && sandbox.AudioContext.last; },
    /** Every navigator.vibrate call, in order, with the time it was made. */
    vibes: sandbox.__vibes,
```

- [ ] **Step 6: Run the whole suite — nothing may regress**

Run: `node tests/run.js`
Expected: `842 checks · 842 passed · 0 failed`. The app now builds a real (stubbed) AudioContext in every test, so any existing test that assumed no audio engine will surface here.

- [ ] **Step 7: Commit**

```bash
git add tests/harness.js
git commit -m "A test harness that can hear, and one that knows once means once"
```

---

## Task 2: A master gain, and a return value that is true

Fixes defect 1.1. `fire()` returns `true` for every non-mute case including the one where zero oscillators were scheduled.

**Files:**
- Modify: `index.html:3242-3336` (MODULE 5b)
- Test: `tests/controls.test.js` (new suite `controls · the alarm sounds`)

- [ ] **Step 1: Write the failing tests**

Add after the existing `controls · the alarm` suite:

```js
  /* ===================================================== alarm · sound ==== */
  /* The decision around the alarm was always tested; the sound never was, because
     the harness had no AudioContext and every test ran the no-engine branch. These
     assert the graph itself: what reaches the speaker, how loud, and when. */
  suite('controls · the alarm sounds', () => {
    const fireOnce = (o = {}) => {
      const h = boot(o);
      h.app.State.data.muted = false;
      const out = h.app.Alarm.fire();
      return { h, out, ctx: h.audio };
    };

    test('every voice reaches the speaker through the master gain', () => {
      const { ctx } = fireOnce();
      assert.greater(ctx.oscs.length, 3, 'the motif is a single tone, not a phrase');
      ctx.oscs.forEach((o, i) => {
        assert.ok(o.reaches(ctx.destination), `voice ${i} is built but never heard`);
        // osc -> voice gain -> master -> destination. A voice wired straight to
        // the destination cannot be ducked or scaled with the others.
        assert.ok(o.outs[0] && o.outs[0].kind === 'gain', `voice ${i} has no envelope`);
        assert.ok(o.outs[0].outs[0] && o.outs[0].outs[0].kind === 'gain',
          `voice ${i} bypasses the master gain`);
      });
    });

    test('one alarm does not clip', () => {
      const { ctx } = fireOnce();
      assert.less(peakGain(ctx), 1.0, 'the summed voices clip');
    });

    test('fire() says what happened rather than that something did', () => {
      const h = boot();
      h.app.State.data.muted = true;
      assert.equal(h.app.Alarm.fire(), 'muted', 'a silenced alarm did not say so');
      h.app.State.data.muted = false;
      assert.equal(h.app.Alarm.fire(), 'played', 'a sounded alarm did not say so');
    });

    test('an engine with no audio and no motor admits nothing happened', () => {
      const h = boot({ audio: false });
      h.window.navigator.vibrate = undefined;
      h.app.State.data.muted = false;
      assert.equal(h.app.Alarm.fire(), 'silent',
        'the caller was told the grower had been alerted when nothing occurred');
    });

    test('an engine with a motor but no audio reports the buzz', () => {
      const h = boot({ audio: false });
      h.app.State.data.muted = false;
      assert.equal(h.app.Alarm.fire(), 'buzzed', 'the vibration went unreported');
      assert.equal(h.vibes.length, 1, 'nothing buzzed');
    });

    test('a suspended context is resumed before anything is scheduled', async () => {
      const h = boot({ audio: 'suspended' });
      h.app.State.data.muted = false;
      assert.equal(h.app.Alarm.fire(), 'waking', 'a suspended context reported as played');
      assert.equal(h.audio.resumeCalls, 1, 'the context was never resumed');
      await new Promise(r => setImmediate(r));
      assert.greater(h.audio.oscs.length, 3, 'the tone never followed the resume');
    });

    /* The backgrounded-iOS shape. resume() rejects outside a user gesture, so the
       tone never lands -- and the old fire() returned true regardless, telling
       the caller a grower had been alerted who had not. */
    test('a refused resume is not reported as a sound', async () => {
      const h = boot({ audio: 'blocked' });
      h.app.State.data.muted = false;
      h.app.Alarm.fire();
      await new Promise(r => setImmediate(r));
      assert.equal(h.audio.oscs.length, 0, 'this proves nothing if the tone played');
      assert.equal(h.app.Alarm.lastOutcome(), 'blocked',
        'the alarm believes it sounded when the phone refused it');
    });
  });
```

And this helper immediately above the suite:

```js
  /* The loudest instant of a motif: the summed peak of every voice alive at once.
     Above 1.0 the sum clips, which is heard as a crack rather than a tone. */
  function peakGain(ctx) {
    const voices = ctx.oscs.map(o => ({
      s: o.startedAt, e: o.stoppedAt, g: o.outs[0] ? o.outs[0].gain.peak : 0,
    }));
    let peak = 0;
    [...new Set(voices.flatMap(v => [v.s, v.e]))].forEach(t => {
      const sum = voices.filter(v => t >= v.s && t < v.e).reduce((a, v) => a + v.g, 0);
      if (sum > peak) peak = sum;
    });
    return peak;
  }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node tests/run.js controls`
Expected: FAIL — `fire() says what happened` gets `true`, not `'played'`; `bypasses the master gain` fails because voices connect straight to `destination`; `lastOutcome` is not a function.

- [ ] **Step 3: Add the master gain and the tokens**

In MODULE 5b, replace `context()`, `unlock()`, `pulse()`, `body()`, `play()` and `fire()`. Keep `ROOT`, `LIFT`, `STEP`, `VIBE` and `shouldFire` where they are for now — Task 5 rewrites them.

```js
  let ctx = null;
  let master = null;
  let outcome = 'silent';       // what the last fire() actually managed to do

  function context(){
    if(ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if(!Ctor) return null;                       // no Web Audio: the buzz still runs
    try{ ctx = new Ctor(); }catch(e){ ctx = null; return null; }
    /* One gain every voice passes through. Without it there is no single place to
       scale a tone or to hold two of them apart, and the only volume control the
       app has is mute-or-not. */
    try{
      master = ctx.createGain();
      master.gain.setValueAtTime(1, ctx.currentTime);
      master.connect(ctx.destination);
    }catch(e){ master = null; }
    return ctx;
  }
```

`pulse` and `body` change only in where they connect — `master || c.destination`, so a context whose gain node could not be built still makes a sound:

```js
  function pulse(c, at, freq, gain, dur){
    const out = master || c.destination;
    [[freq, gain], [freq * 1.5, gain * 0.45]].forEach(pair => {
      const osc = c.createOscillator();
      const amp = c.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(pair[0], at);
      amp.gain.setValueAtTime(0.0001, at);
      amp.gain.exponentialRampToValueAtTime(pair[1], at + 0.006);
      amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(amp).connect(out);
      osc.start(at);
      osc.stop(at + dur + 0.02);
    });
  }

  function body(c, at){
    const out = master || c.destination;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(ROOT / 4, at);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + 0.62);
    osc.connect(amp).connect(out);
    osc.start(at);
    osc.stop(at + 0.66);
  }
```

And `fire()` reports rather than asserts:

```js
  /* What the alarm managed to do, not what it was permitted to attempt.

       'muted'     the reader silenced it
       'silent'    no Web Audio and no motor -- nothing happened at all
       'buzzed'    vibration only; this engine has no audio
       'waking'    a suspended context was asked to resume; the tone follows if
                   the engine allows it, and lastOutcome() turns 'blocked' if not
       'played'    scheduled against a running context

     The old boolean could not tell 'played' from 'silent', so a backgrounded
     iOS PWA -- where resume() is refused and no oscillator is ever built --
     reported a grower as alerted who had heard and felt nothing. */
  function fire(){
    if(State.data.muted) return (outcome = 'muted');
    let buzzed = false;
    try{
      if(navigator.vibrate){ navigator.vibrate(VIBE); buzzed = true; }
    }catch(e){}

    const c = context();
    if(!c) return (outcome = buzzed ? 'buzzed' : 'silent');

    /* resume() first and schedule in its callback. Scheduling against a suspended
       context writes events against a clock that is not moving, and they all
       arrive at once when it starts again. */
    if(c.state === 'suspended'){
      try{
        c.resume().then(() => { play(c); outcome = 'played'; })
                  .catch(() => { outcome = 'blocked'; });
      }catch(e){ return (outcome = buzzed ? 'buzzed' : 'silent'); }
      return (outcome = 'waking');
    }
    try{ play(c); }catch(e){ return (outcome = buzzed ? 'buzzed' : 'silent'); }
    return (outcome = 'played');
  }

  /** What the last fire() ended up doing, once any async resume has settled. */
  function lastOutcome(){ return outcome; }
```

Add `lastOutcome` to the module's return: `return { fire, lastOutcome, shouldFire, unlock, VIBE };`

- [ ] **Step 4: Run the tests**

Run: `node tests/run.js controls`
Expected: the new suite passes. `controls · the alarm` still fails on two assertions (`fire()` now returns strings, not booleans) — Step 5 fixes those.

- [ ] **Step 5: Update the two assertions that read the old boolean**

In `controls · the alarm`, test `muting it actually stops it`:

```js
    test('muting it actually stops it', () => {
      const h = boot();
      h.app.State.data.muted = true;
      assert.equal(h.app.Alarm.fire(), 'muted', 'the alarm sounded while muted');
      h.app.State.data.muted = false;
      assert.notEqual(h.app.Alarm.fire(), 'muted', 'the alarm stayed silent while armed');
    });
```

And in `a restored transcript does not sound the alarm`, change the stub's return:

```js
      back.app.Alarm.fire = () => { fired++; return 'played'; };
```

- [ ] **Step 6: Run the whole suite**

Run: `node tests/run.js`
Expected: all green, total above 842.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/controls.test.js
git commit -m "The alarm stops claiming it woke somebody it did not"
```

---

## Task 3: Two alarms at once stop clipping each other

Fixes defect 1.2. Two fires 100 ms apart schedule 14 voices against one destination: peak summed gain 1.373, which clips, and the second `navigator.vibrate` cancels the first pattern mid-rhythm.

**Files:**
- Modify: `index.html` MODULE 5b
- Test: `tests/controls.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `controls · the alarm sounds`:

```js
    /* Two rules can arm in one interaction -- frost and road saturation both sit
       in the panel -- and two motifs on one destination sum past 1.0, which is a
       crack, not an alarm. The second buzz also cancels the first pattern
       mid-rhythm, and the rhythm is what identifies the alarm on a phone in a
       pocket. */
    test('a second alarm during the first neither clips nor cuts it', async () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.app.Alarm.fire();
      const alone = peakGain(h.audio);
      h.audio.advanceTo(0.10);              // still inside the first motif
      h.app.Alarm.fire();
      assert.close(peakGain(h.audio), alone, 0.001,
        'the two motifs overlap and sum past what one of them peaks at');
      assert.less(peakGain(h.audio), 1.0, 'the summed voices clip');
      assert.equal(h.vibes.length, 1,
        'the second buzz restarted the pattern the first was still playing');
    });

    test('the second alarm is still heard, after the first rather than over it', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.app.Alarm.fire();
      const firstEnds = Math.max(...h.audio.oscs.map(o => o.stoppedAt));
      const before = h.audio.oscs.length;
      h.audio.advanceTo(0.10);
      h.app.Alarm.fire();
      assert.greater(h.audio.oscs.length, before, 'the second alarm was thrown away');
      const late = h.audio.oscs.slice(before);
      assert.ok(late.every(o => o.startedAt >= firstEnds),
        'the second motif starts before the first has finished');
    });

    test('a burst does not commit a queue of alarms', () => {
      const h = boot();
      h.app.State.data.muted = false;
      let coalesced = 0;
      for(let i = 0; i < 10; i++) if(h.app.Alarm.fire() === 'coalesced') coalesced++;
      assert.greater(coalesced, 5,
        'ten criticals in one tick queued ten motifs, which is a minute of noise');
    });
```

- [ ] **Step 2: Run and watch them fail**

Run: `node tests/run.js controls`
Expected: FAIL — peak gain 1.373 against an expected 0.846, two vibrate calls, no `'coalesced'` token.

- [ ] **Step 3: Implement coalescing**

Add beside the other constants in MODULE 5b:

```js
  const GAP   = 0.12;       // seconds of air between two motifs that follow each other
  const QUEUE = 1.5;        // beyond this a queued alarm is stale news; drop it
  let busyUntil = 0;        // context time the current motif finishes at
  let vibeUntil = 0;        // wall clock the current pattern finishes at
```

`play` returns the time it ends at, and takes its start time from the caller:

```js
  /** Schedules the motif and returns the context time it finishes at, or 0 when
      it was dropped for landing too far behind a queue of its own kind. */
  function play(c){
    const now = c.currentTime;
    /* Not on top of a motif still sounding: two summed motifs peak past 1.0,
       which clips. After it, with air between, so both are heard as themselves. */
    const t0 = Math.max(now + 0.02, busyUntil + GAP);
    if(t0 - now > QUEUE) return 0;      // a queue this deep is noise, not an alarm
    body(c, t0);
    pulse(c, t0,            ROOT, 0.22, 0.19);
    pulse(c, t0 + STEP,     ROOT, 0.22, 0.19);
    pulse(c, t0 + STEP * 2, LIFT, 0.26, 0.30);
    busyUntil = t0 + 0.66;
    return busyUntil;
  }
```

And `fire()` gates the buzz on the same rule and reports the drop. Replace the vibration block and the two `play(c)` call sites:

```js
    let buzzed = false;
    try{
      /* The same rule as the tone. navigator.vibrate REPLACES the running
         pattern rather than queueing behind it, so a second call inside the
         first truncates the rhythm -- and the rhythm is what tells this alarm
         apart from every other notification on the phone. */
      const nowMs = Date.now();
      if(navigator.vibrate && nowMs >= vibeUntil){
        navigator.vibrate(VIBE);
        vibeUntil = nowMs + VIBE.reduce((a, b) => a + b, 0);
        buzzed = true;
      }
    }catch(e){}
```

```js
    if(c.state === 'suspended'){
      try{
        c.resume().then(() => { outcome = play(c) ? 'played' : 'coalesced'; })
                  .catch(() => { outcome = 'blocked'; });
      }catch(e){ return (outcome = buzzed ? 'buzzed' : 'silent'); }
      return (outcome = 'waking');
    }
    let ends = 0;
    try{ ends = play(c); }catch(e){ return (outcome = buzzed ? 'buzzed' : 'silent'); }
    return (outcome = ends ? 'played' : 'coalesced');
```

- [ ] **Step 4: Run the tests**

Run: `node tests/run.js controls`
Expected: PASS. Peak gain for two fires equals the single-fire figure.

- [ ] **Step 5: Run the whole suite and commit**

Run: `node tests/run.js` — expected all green.

```bash
git add index.html tests/controls.test.js
git commit -m "Two alarms at once wait for each other instead of cracking"
```

---

## Task 4: An alarm that comes back

Fixes defect 1.3. `index.html:9042` binds `Alarm.unlock` with `{once:true}`, so after the first gesture nothing can revive a context the system re-suspends.

**Files:**
- Modify: `index.html:9040-9043`, MODULE 5b `unlock()`
- Test: `tests/controls.test.js`

- [ ] **Step 1: Write the failing test**

```js
    /* Bound {once:true}, the unlock listener is gone after the first gesture. The
       system re-suspends a context whenever the screen goes off, and fire() then
       calls resume() from a timer rather than a gesture -- which is exactly where
       iOS refuses. The alarm is silent for the rest of the session and says it
       played. The reader's next tap has to be able to bring it back. */
    test('a later gesture revives a context the system suspended again', () => {
      const h = boot();
      h.document.dispatch('pointerdown');            // first gesture: builds it
      assert.ok(h.audio, 'no context was built by the first gesture');
      h.audio.state = 'suspended';                   // screen off, app backgrounded
      const before = h.audio.resumeCalls;
      h.document.dispatch('pointerdown');            // the reader comes back
      assert.greater(h.audio.resumeCalls, before,
        'the unlock listener was spent on the first gesture and never re-armed');
      assert.equal(h.audio.state, 'running', 'the context stayed suspended');
    });

    test('an already running context costs a gesture nothing', () => {
      const h = boot();
      h.document.dispatch('pointerdown');
      const calls = h.audio.resumeCalls;
      h.document.dispatch('pointerdown');
      h.document.dispatch('pointerdown');
      assert.equal(h.audio.resumeCalls, calls, 'every tap is resuming a running context');
    });
```

- [ ] **Step 2: Run and watch it fail**

Run: `node tests/run.js controls`
Expected: FAIL — `resumeCalls` does not increase, because the listener was removed after the first gesture (the harness now honours `once`, so this is observable for the first time).

- [ ] **Step 3: Bind it permanently**

Replace `index.html:9040-9043`:

```js
  /* Audio needs a gesture in most engines, and the context only has to be built
     once -- but it does not stay usable once built. The system suspends a running
     context whenever the screen goes off or the app is backgrounded, and fire()
     resumes from a timer, which is precisely the place iOS refuses. So this stays
     bound rather than running {once:true}: the reader's next tap is what brings
     the alarm back, and unlock returns immediately when there is nothing to do. */
  ['pointerdown', 'keydown'].forEach(evt =>
    document.addEventListener(evt, Alarm.unlock));
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden) Alarm.unlock();
  });
```

And make `unlock` cheap enough to run on every gesture:

```js
  /** Called from every gesture, so it must cost nothing when there is nothing to
      do: one property read on a context that is already running. */
  function unlock(){
    const c = context();
    if(c && c.state === 'suspended'){ try{ c.resume(); }catch(e){} }
    return c;
  }
```

- [ ] **Step 4: Run the tests**

Run: `node tests/run.js` — expected all green.

- [ ] **Step 5: Commit**

```bash
git add index.html tests/controls.test.js
git commit -m "The next tap brings the alarm back"
```

---

## Task 5: A second tone, a fifth below

**Files:**
- Modify: `index.html` MODULE 5b, `index.html:3366` (`Console.post`)
- Test: `tests/controls.test.js`

- [ ] **Step 1: Write the failing tests**

```js
    /* Critical lifts to the fifth above; serious drops to the fifth below. One
       interval, two directions -- learnt once, then read without thinking. The
       serious tone is shorter, quieter and has no low body under it, so it is
       audibly the subordinate of the two rather than a second emergency. */
    test('serious sounds, and sounds like the smaller sibling', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.app.Alarm.fire('serious');
      const s = { peak: peakGain(h.audio), span: span(h.audio), n: h.audio.oscs.length };
      const h2 = boot();
      h2.app.State.data.muted = false;
      h2.app.Alarm.fire('critical');
      const c = { peak: peakGain(h2.audio), span: span(h2.audio), n: h2.audio.oscs.length };

      assert.greater(s.n, 0, 'a serious message makes no sound at all');
      assert.less(s.peak, c.peak, 'the two tones are equally loud, so neither ranks');
      assert.less(s.span, c.span, 'the two tones are the same length');
      assert.notOk(h.audio.oscs.some(o => o.type === 'sine'),
        'the serious tone carries the low body, which is what makes critical urgent');
    });

    test('the two tones move in opposite directions', () => {
      const at = (h, sev) => {
        h.app.State.data.muted = false;
        h.app.Alarm.fire(sev);
        const v = h.audio.oscs.filter(o => o.type === 'triangle')
          .map(o => ({ t: o.startedAt, f: o.frequency.ops[0][1] }))
          .sort((a, b) => a.t - b.t || a.f - b.f);
        return { first: v[0].f, last: v[v.length - 1].f };
      };
      const c = at(boot(), 'critical');
      const s = at(boot(), 'serious');
      assert.greater(c.last, c.first, 'critical does not lift');
      assert.less(s.last, s.first, 'serious does not fall');
    });

    test('a serious message is worth a sound and a warning is not', () => {
      const { app } = boot();
      assert.equal(app.Alarm.toneFor({ severity: 'critical' }), 'critical');
      assert.equal(app.Alarm.toneFor({ severity: 'serious' }), 'serious');
      assert.equal(app.Alarm.toneFor({ severity: 'warning' }), null);
      assert.equal(app.Alarm.toneFor({ severity: 'good' }), null);
      assert.equal(app.Alarm.toneFor({ severity: 'serious', mine: true }), null,
        'your own words, echoed back, are not news');
    });
```

Add beside `peakGain`:

```js
  /** How long a motif occupies the speaker, first voice on to last voice off. */
  function span(ctx) {
    return Math.max(...ctx.oscs.map(o => o.stoppedAt)) -
           Math.min(...ctx.oscs.map(o => o.startedAt));
  }
```

And extend the existing `only a critical message is worth interrupting someone for` case list, which asserts `serious → false` and is now wrong:

```js
        [{ severity: 'serious' }, true],
```

- [ ] **Step 2: Run and watch them fail**

Run: `node tests/run.js controls`
Expected: FAIL — `toneFor` is not a function.

- [ ] **Step 3: Implement the tone table**

Replace the constants block at the top of MODULE 5b:

```js
  const ROOT = 587.33;      // D5
  const LIFT = 880.00;      // A5 -- the fifth above it, and the reason it lifts
  const DROP = 440.00;      // A4 -- the same fifth below, and the reason it falls
  const STEP = 0.17;        // seconds between pulses

  /* Two tones, one family.

     Critical lifts to the fifth above the root; serious drops to the fifth below
     it. The same interval in opposite directions, which is a relationship a
     listener learns once and then reads without attending to it. Serious is
     shorter, quieter, and carries no low body, so it is plainly the subordinate
     of the two rather than a second emergency -- an alarm that fires twice at
     full weight for two different things is one that ranks neither.

     The vibration is matched to the rhythm of each, because the two are one
     signal: the buzz is the half that survives a phone on silent in a pocket. */
  const TONES = {
    critical: { body: true,  gain: 0.22, lift: 0.26, tail: 0.30, at: LIFT,
                dur: 0.19, span: 0.66, vibe: [90, 70, 90, 70, 170] },
    serious:  { body: false, gain: 0.14, lift: 0.16, tail: 0.22, at: DROP,
                dur: 0.15, span: 0.34, vibe: [60, 60, 110] }
  };
  /* Kept for the harness, which asserts the critical rhythm is more than one
     buzz -- a single pulse is indistinguishable from every other notification. */
  const VIBE = TONES.critical.vibe;
```

`play` takes a severity and reads the table:

```js
  function play(c, sev){
    const T = TONES[sev] || TONES.critical;
    const now = c.currentTime;
    const t0 = Math.max(now + 0.02, busyUntil + GAP);
    if(t0 - now > QUEUE) return 0;
    if(T.body) body(c, t0);
    if(T.body){
      pulse(c, t0,            ROOT, T.gain, T.dur);
      pulse(c, t0 + STEP,     ROOT, T.gain, T.dur);
      pulse(c, t0 + STEP * 2, T.at, T.lift, T.tail);
    } else {
      // Two pulses, not three: the shorter phrase is half of what makes this one
      // read as the smaller of the pair.
      pulse(c, t0,        ROOT, T.gain, T.dur);
      pulse(c, t0 + STEP, T.at, T.lift, T.tail);
    }
    busyUntil = t0 + T.span;
    return busyUntil;
  }
```

`body` loses its hardcoded length so the two tones cannot drift apart:

```js
  function body(c, at){
    const out = master || c.destination;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(ROOT / 4, at);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + TONES.critical.span - 0.04);
    osc.connect(amp).connect(out);
    osc.start(at);
    osc.stop(at + TONES.critical.span);
  }
```

`toneFor` replaces the boolean decision, and `shouldFire` is expressed in terms of it so the two can never disagree:

```js
  /** Which tone a message earns, or null for one not worth interrupting anybody
      for. Pure, so the rule can be tested without an audio device near it. */
  function toneFor(msg){
    if(!msg || msg.mine) return null;
    return TONES[msg.severity] ? msg.severity : null;
  }
  function shouldFire(msg){ return toneFor(msg) !== null; }
```

`fire` takes the severity through:

```js
  function fire(sev){
    const tone = TONES[sev] ? sev : 'critical';
    if(State.data.muted) return (outcome = 'muted');
    let buzzed = false;
    try{
      const nowMs = Date.now();
      if(navigator.vibrate && State.data.haptics !== false && nowMs >= vibeUntil){
        navigator.vibrate(TONES[tone].vibe);
        vibeUntil = nowMs + TONES[tone].vibe.reduce((a, b) => a + b, 0);
        buzzed = true;
      }
    }catch(e){}
    const c = context();
    if(!c) return (outcome = buzzed ? 'buzzed' : 'silent');
    if(c.state === 'suspended'){
      try{
        c.resume().then(() => { outcome = play(c, tone) ? 'played' : 'coalesced'; })
                  .catch(() => { outcome = 'blocked'; });
      }catch(e){ return (outcome = buzzed ? 'buzzed' : 'silent'); }
      return (outcome = 'waking');
    }
    let ends = 0;
    try{ ends = play(c, tone); }catch(e){ return (outcome = buzzed ? 'buzzed' : 'silent'); }
    return (outcome = ends ? 'played' : 'coalesced');
  }
```

Export it: `return { fire, lastOutcome, shouldFire, toneFor, unlock, VIBE, TONES };`

- [ ] **Step 4: Pass the severity from the console**

`index.html:3366` currently discards which tone is wanted:

```js
    const tone = Alarm.toneFor(msg);
    if(tone) Alarm.fire(tone);
```

- [ ] **Step 5: Run the whole suite**

Run: `node tests/run.js`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/controls.test.js
git commit -m "A quieter tone under the alarm, a fifth the other way"
```

---

## Task 6: A vibration the reader can turn off

**Files:**
- Modify: `index.html:2449` (defaults), `:2529` (snapshot), `:2576` (restore)
- Test: `tests/controls.test.js`

- [ ] **Step 1: Write the failing test**

```js
    test('vibration has its own switch, and it survives a restart', () => {
      const h = boot();
      assert.equal(h.app.State.data.haptics, true, 'the motor is off by default');
      h.app.State.data.haptics = false;
      h.app.State.data.muted = false;
      h.app.Alarm.fire('critical');
      assert.equal(h.vibes.length, 0, 'the phone buzzed after the motor was turned off');
      h.app.State.save();
      const back = boot({ storage: Object.fromEntries(h.storage) });
      assert.equal(back.app.State.data.haptics, false,
        'a reader who turned the buzz off finds it back on next launch');
    });
```

- [ ] **Step 2: Run and watch it fail**

Run: `node tests/run.js controls` — Expected: FAIL, `haptics` is `undefined`.

- [ ] **Step 3: Add the field in all three places**

Defaults, beside `muted` at `index.html:2449`:

```js
    muted: false,
    /* The buzz, separately. On a phone that lives in a pocket it is the half of
       the alarm that lands; on a desk it is the half that startles. One switch
       cannot serve both, so there are two. */
    haptics: true,
```

Snapshot, beside `muted: data.muted,`:

```js
      haptics: data.haptics,
```

Restore, beside the `muted` line:

```js
      // Explicit typeof for the same reason as muted above: a snapshot written
      // before this field existed must not read as a deliberate choice either way.
      if(typeof s.haptics === 'boolean') data.haptics = s.haptics;
```

- [ ] **Step 4: Run and commit**

Run: `node tests/run.js` — expected all green.

```bash
git add index.html tests/controls.test.js
git commit -m "The buzz gets its own switch"
```

---

## Task 7: The panel's markup and styling

The panel **replaces** `#simSheet` (`index.html:1973-2010`). The location search moves across keeping its ids, so `Search` needs no change.

**Files:**
- Modify: `index.html:1631-1637` (header), `:1971-2010` (sheet → panel), CSS near `:1009`
- Test: `tests/controls.test.js`

- [ ] **Step 1: Write the failing tests (new suite)**

```js
  /* ==================================================== control panel ===== */
  /* The controls sat in four places: the header, the ops panel, the console head
     and a mobile-only sheet called "Event Simulation" -- a name far too narrow
     for what it already held. The panel replaces that sheet and reaches the rest
     without moving buttons readers have already learnt. */
  suite('controls · the control panel', () => {
    const IDS = ['ctrlPanel', 'btnPanel', 'ctrlClose', 'triggerButtonsPanel',
                 'btnPauseP', 'btnSpeedP', 'btnSyncP', 'btnAlarmP', 'btnHapticsP',
                 'btnTestAlarm', 'ctrlStatus', 'btnRefreshP', 'btnClearChat',
                 'btnResetAll', 'ctrlResetConfirm'];

    test('every element the panel drives exists in the markup', () => {
      const { document } = boot();
      IDS.forEach(id => assert.ok(document.getElementById(id), `#${id} is missing`));
    });

    test('the simulation sheet is gone, and nothing still reaches for it', () => {
      const { markup, script } = readSource();
      assert.notIncludes(markup, 'id="simSheet"', 'the replaced sheet is still in the markup');
      assert.notIncludes(script, "el('simSheet')", 'the script still reaches for the deleted sheet');
      assert.notIncludes(script, 'simClose', 'a listener is bound to a button that no longer exists');
    });

    test('the location search kept its ids, so Search needs no change', () => {
      const { document } = boot();
      ['placeSearchM', 'placeResultsM', 'placeGeoM'].forEach(id =>
        assert.ok(document.getElementById(id), `#${id} was lost in the move`));
    });

    test('the panel is styled, not left to a utility class that does not exist', () => {
      const { html } = readSource();
      // Tailwind here is prebuilt: a class invented today produces no rule at all.
      assert.match(html, /\.ctrl-panel\s*\{/, 'the panel has no stylesheet rule');
      assert.match(html, /@media\s*\(min-width:\s*1024px\)[^}]*\{[\s\S]{0,600}?\.ctrl-panel/,
        'the panel is a bottom sheet on a 1440px screen');
    });
  });
```

`readSource` is already imported at the top of `controls.test.js`; confirm with `grep -n "readSource" tests/controls.test.js` and add it to the destructure if absent.

- [ ] **Step 2: Run and watch it fail**

Run: `node tests/run.js controls` — Expected: FAIL, `#ctrlPanel is missing`.

- [ ] **Step 3: Add the header button**

After the `#btnManual` button at `index.html:1631-1634`:

```html
    <button id="btnPanel" class="toggle flex-none" aria-haspopup="dialog" aria-expanded="false"
            aria-controls="ctrlPanel" title="Controls (Ctrl+K)" aria-label="Open the control panel"
            data-i18n-attr="title,aria-label">
      <span class="ic-slot" data-icon="sliders"></span><span class="wide-only">&nbsp;Controls</span>
    </button>
```

Check `ICONS` in the script for an existing glyph before adding `sliders`; if it is absent, add one beside the others following the shape of `data-icon="book"`.

- [ ] **Step 4: Replace the sheet with the panel**

Delete `index.html:1973-2010` entirely and put this in its place. `#fabSim` above it stays, with its `aria-label` updated to `Open the control panel`.

```html
<!-- ══════════════════════ CONTROL PANEL ══════════════════════
     One surface for the basic commands. It replaces the mobile-only simulation
     sheet rather than sitting beside it: that sheet was called "Event
     Simulation" and already held the feed controls and the location search,
     which is two things its name did not cover and five it did not reach.

     The header and console controls are NOT moved here. A reader who has learnt
     where the language button is should still find it there; the panel reaches
     the same state, it does not relocate the buttons. -->
<div id="ctrlPanel" class="sheet" role="dialog" aria-modal="true" aria-labelledby="ctrlTitle" hidden>
  <div class="sheet-panel ctrl-panel">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="flex items-center gap-2 mb-3">
      <span id="ctrlTitle" class="panel-title" data-i18n>Controls</span>
      <div class="flex-1"></div>
      <button id="ctrlClose" class="toggle" aria-label="Close the control panel"
              data-i18n-attr="aria-label" data-i18n>Close</button>
    </div>

    <div class="ctrl-grid">
      <section class="ctrl-sec">
        <h3 class="ctrl-legend" data-i18n>Feed</h3>
        <div class="ctrl-row">
          <button id="btnPauseP" class="btn c-info"><span class="btn-glyph">❚❚</span><span data-i18n>Pause feed</span></button>
          <button id="btnSpeedP" class="btn c-info" style="flex:none" aria-label="Simulation speed" data-i18n-attr="aria-label"><span class="btn-glyph">»</span><span>×1</span></button>
          <button id="btnSyncP" class="btn c-info" style="flex:none" aria-label="Fetch observations now" data-i18n-attr="aria-label"><span class="btn-glyph">↻</span><span data-i18n>Sync</span></button>
        </div>
      </section>

      <section class="ctrl-sec">
        <h3 class="ctrl-legend" data-i18n>Alerts</h3>
        <div class="ctrl-row">
          <button id="btnAlarmP" class="btn c-info" aria-pressed="true"><span class="btn-glyph">♫</span><span data-i18n>Alert sound</span><span class="ctrl-state" data-i18n>On</span></button>
          <button id="btnHapticsP" class="btn c-info" aria-pressed="true"><span class="btn-glyph">≈</span><span data-i18n>Vibration</span><span class="ctrl-state" data-i18n>On</span></button>
        </div>
        <div class="ctrl-row">
          <button id="btnTestAlarm" class="btn c-info"><span class="btn-glyph">▸</span><span data-i18n>Test the alert sound</span></button>
        </div>
        <p class="ctrl-note" data-i18n>Critical messages sound a three-note alarm; serious ones a shorter, quieter tone. Nothing else makes a sound.</p>
      </section>

      <section class="ctrl-sec ctrl-wide">
        <h3 class="ctrl-legend" data-i18n>Simulate</h3>
        <div id="triggerButtonsPanel" class="flex flex-col gap-2"></div>
        <p class="ctrl-note" data-i18n>Triggers inject a telemetry excursion and let the normal rule path run, so they land on the next downlink. Raise the speed to compress the wait.</p>
      </section>

      <section class="ctrl-sec">
        <h3 class="ctrl-legend" data-i18n>Location</h3>
        <div class="search search-block" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-owns="placeResultsM">
          <span class="search-icon" aria-hidden="true">⌕</span>
          <input id="placeSearchM" class="field search-input" type="search" autocomplete="off"
                 spellcheck="false" placeholder="Search any location…"
                 aria-label="Search for a location" aria-controls="placeResultsM" aria-autocomplete="list" data-i18n-attr="placeholder,aria-label">
          <button id="placeGeoM" class="search-geo" type="button" aria-label="Use my current location" data-i18n-attr="aria-label">◎</button>
          <div id="placeResultsM" class="search-results" role="listbox" aria-label="Location results" hidden data-i18n-attr="aria-label"></div>
        </div>
      </section>

      <section class="ctrl-sec">
        <h3 class="ctrl-legend" data-i18n>View</h3>
        <div class="ctrl-row">
          <button id="btnThemeP" class="btn c-info"><span class="btn-glyph">◐</span><span data-i18n>Theme</span></button>
          <button id="btnLangP" class="btn c-info"><span class="btn-glyph">⌘</span><span data-i18n>Language</span></button>
        </div>
        <div class="ctrl-row">
          <button id="btnFarmP" class="btn c-info"><span class="btn-glyph">▤</span><span data-i18n>Your farm</span></button>
          <button id="btnManualP" class="btn c-info"><span class="btn-glyph">?</span><span data-i18n>Manual</span></button>
        </div>
      </section>

      <section class="ctrl-sec">
        <h3 class="ctrl-legend" data-i18n>Data</h3>
        <div id="ctrlStatus" class="ctrl-note">—</div>
        <div class="ctrl-row">
          <button id="btnRefreshP" class="btn c-info"><span class="btn-glyph">↻</span><span data-i18n>Refresh observations</span></button>
        </div>
        <div class="ctrl-row">
          <button id="btnClearChat" class="btn c-info"><span class="btn-glyph">⌫</span><span data-i18n>Clear the transcript</span></button>
        </div>
        <div class="ctrl-row">
          <button id="btnResetAll" class="btn c-crit"><span class="btn-glyph">⚠</span><span data-i18n>Reset everything</span></button>
        </div>
        <div id="ctrlResetConfirm" class="ctrl-confirm" hidden>
          <p class="ctrl-note" data-i18n>This clears the saved snapshot, the transcript, your farm answers, the language and the theme.</p>
          <div class="ctrl-row">
            <button id="btnResetYes" class="btn c-crit" style="flex:1"><span data-i18n>Yes, reset</span></button>
            <button id="btnResetNo" class="btn c-info" style="flex:1"><span data-i18n>Cancel</span></button>
          </div>
        </div>
      </section>
    </div>
  </div>
</div>
```

- [ ] **Step 5: Add the CSS**

Beside the `.alarm-toggle` rules at `index.html:1009`. Every colour comes from a token — the suite rejects a raw colour in a rule below the palettes.

```css
/* The control panel. A bottom sheet on a phone, because that is what every other
   sheet in this app is and the muscle memory is worth more than novelty; a
   centred panel above 1024px, because a bottom sheet on a 1440px screen is a
   sheet in the wrong place. */
.ctrl-panel{ max-height:86vh; overflow-y:auto; }
.ctrl-grid{ display:grid; grid-template-columns:1fr; gap:14px; }
.ctrl-sec{ display:flex; flex-direction:column; gap:8px; min-width:0; }
.ctrl-legend{
  font-size:9px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--text-muted); font-weight:700; margin:0;
}
.ctrl-row{ display:flex; gap:8px; }
.ctrl-row > .btn{ width:auto; flex:1; min-width:0; }
.ctrl-note{ font-size:10.5px; line-height:1.5; color:var(--text-muted); margin:0; }
/* Pushed to the end of its button, so the label reads as the control's name and
   the value reads as its state -- rather than the two running together into a
   name that changes, which is a button you cannot learn. */
.ctrl-state{
  margin-inline-start:auto; font-size:10px; font-weight:700;
  letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted);
}
.btn[aria-pressed="false"] .ctrl-state{ color:var(--text-muted); opacity:.7; }
.ctrl-confirm{
  border:1px solid var(--hairline-2); border-radius:10px;
  padding:10px; display:flex; flex-direction:column; gap:8px;
  background:var(--surface-2);
}

@media (min-width:1024px){
  #ctrlPanel{ align-items:center; justify-content:center; }
  .ctrl-panel{
    max-width:720px; width:calc(100% - 48px);
    border-radius:14px; max-height:82vh;
  }
  .ctrl-grid{ grid-template-columns:1fr 1fr; gap:16px 20px; }
  .ctrl-wide{ grid-column:1 / -1; }
  /* The grab handle is a gesture affordance for a sheet that is dragged. A
     centred panel is not dragged, so it would be a lie. */
  .ctrl-panel .sheet-grab{ display:none; }
}
```

- [ ] **Step 6: Run the tests**

Run: `node tests/run.js controls`
Expected: the markup tests pass. `controls · every referenced element exists` may now fail for `simSheet` — Task 8 removes the script side.

- [ ] **Step 7: Commit**

```bash
git add index.html tests/controls.test.js
git commit -m "One panel where the sheet was, and room for it on a wide screen"
```

---

## Task 8: The panel's module and wiring

**Files:**
- Modify: `index.html` new MODULE 6c after MODULE 6; `:4944` (trigger mounts); `:6158` (`openSheet`); `:8779-8794`, `:8806-8820`, `:9033` (wiring)
- Test: `tests/controls.test.js`

- [ ] **Step 1: Write the failing tests**

```js
    test('it opens from the header, the button and the shortcut, and closes on Escape', () => {
      const h = boot();
      const p = h.document.getElementById('ctrlPanel');
      assert.equal(p.hidden, true, 'the panel starts open');

      h.document.getElementById('btnPanel').dispatch('click');
      assert.equal(p.hidden, false, 'the header button did not open it');

      h.document.dispatch('keydown', { key: 'Escape' });
      assert.equal(p.hidden, true, 'Escape did not close it');

      h.document.dispatch('keydown', { key: 'k', ctrlKey: true, preventDefault(){} });
      assert.equal(p.hidden, false, 'Ctrl+K did not open it');

      h.document.getElementById('ctrlClose').dispatch('click');
      assert.equal(p.hidden, true, 'Close did not close it');
    });

    test('the shortcut stays out of the way while somebody is typing', () => {
      const h = boot();
      const input = h.document.getElementById('chatInput');
      h.document.activeElement = input;
      h.document.dispatch('keydown', { key: 'k', ctrlKey: true, preventDefault(){} });
      assert.equal(h.document.getElementById('ctrlPanel').hidden, true,
        'Ctrl+K opened the panel out from under a reader mid-sentence');
    });

    /* The bug this pattern keeps producing: markup defaults painted over restored
       state, so a reader who silenced the alarm and closed the app finds it armed. */
    test('its switches report restored state, not the markup defaults', () => {
      const h = boot();
      h.app.State.data.muted = true;
      h.app.State.data.haptics = false;
      h.app.State.save();
      const back = boot({ storage: Object.fromEntries(h.storage) });
      back.app.Panel.render();
      assert.equal(back.document.getElementById('btnAlarmP').getAttribute('aria-pressed'), 'false',
        'the panel shows an armed alarm that the reader silenced');
      assert.equal(back.document.getElementById('btnHapticsP').getAttribute('aria-pressed'), 'false',
        'the panel shows a buzz the reader turned off');
    });

    test('the alarm switch and the console switch are one switch', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.document.getElementById('btnAlarmP').dispatch('click');
      assert.equal(h.app.State.data.muted, true, 'the panel switch did not mute');
      assert.equal(h.document.getElementById('btnMute').getAttribute('aria-pressed'), 'false',
        'the console glyph disagrees with the panel');
    });

    test('the test button sounds the alarm even when nothing has gone wrong', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.document.getElementById('btnTestAlarm').dispatch('click');
      assert.greater(h.audio.oscs.length, 3, 'the test button made no sound');
    });

    test('testing it while muted says so rather than doing nothing', () => {
      const h = boot();
      h.app.State.data.muted = true;
      h.document.getElementById('btnTestAlarm').dispatch('click');
      assert.equal(h.audio ? h.audio.oscs.length : 0, 0, 'a muted alarm sounded');
      assert.ok(h.app.State.data.log.some(e => /muted|silenced/i.test(e.title || '')),
        'the reader pressed test, heard nothing, and was told nothing');
    });

    test('the triggers paint into the panel too', () => {
      const h = boot();
      h.app.Views.renderTriggers();
      const host = h.document.getElementById('triggerButtonsPanel');
      assert.includes(host.innerHTML, 'data-trigger="FROST_EVENT"',
        'the panel offers no triggers, so the sheet it replaced did more than it does');
    });
```

- [ ] **Step 2: Run and watch them fail**

Run: `node tests/run.js controls` — Expected: FAIL, `Panel` is not defined.

- [ ] **Step 3: Add the third trigger mount**

`index.html:4944`:

```js
    ['triggerButtons', 'triggerButtonsMobile', 'triggerButtonsPanel'].forEach(id => {
```

`triggerButtonsMobile` no longer exists in the markup after Task 7, and the loop already guards on `if(host)`. Remove the dead id:

```js
    ['triggerButtons', 'triggerButtonsPanel'].forEach(id => {
```

Do the same in `syncControls` at `index.html:4952-4961`: replace `'btnPauseM'` with `'btnPauseP'` and `'btnSpeedM'` with `'btnSpeedP'`.

- [ ] **Step 4: Replace `openSheet` with the Panel module**

Delete `Views.openSheet` (`index.html:6158-6163`) and its entry in the Views export list. Add MODULE 6c after MODULE 6:

```js
/* ===================== MODULE 6c: THE CONTROL PANEL =====================

   The basic commands in one place. Before this they sat in four: the header, the
   ops panel, the console head, and a mobile-only sheet named for one of the five
   things it held.

   This module owns the panel's own switches and nothing else. Every command it
   offers is delegated to the module that already implements it -- Telemetry for
   the feed, Alarm for the sound, Views for the triggers, Live for the data --
   so a command cannot behave differently depending on which surface it was
   pressed from. The panel is a way in, not a second implementation. */
const Panel = (() => {
  let resetTimer = null;

  const node = () => el('ctrlPanel');
  const isOpen = () => { const p = node(); return !!p && !p.hidden; };

  function open(on){
    const p = node();
    if(!p) return;
    p.hidden = !on;
    const b = el('btnPanel');
    if(b) b.setAttribute('aria-expanded', String(!!on));
    if(on){ render(); Views.renderTriggers(); }
    else armReset(false);
  }
  const toggle = () => open(!isOpen());

  /** A switch that reports its state must keep its NAME and move its
      aria-pressed -- rewriting the label makes a button that reports state
      indistinguishable from one that sets it, and translateStatic would revert
      it on the next language change anyway. */
  function setSwitch(id, on){
    const b = el(id);
    if(!b) return;
    b.setAttribute('aria-pressed', String(on));
    const s = b.querySelector('.ctrl-state');
    if(s) s.textContent = t(on ? 'On' : 'Off');
  }

  function render(){
    if(!node()) return;
    setSwitch('btnAlarmP', !State.data.muted);
    setSwitch('btnHapticsP', State.data.haptics !== false);
    const st = el('ctrlStatus');
    if(st) st.textContent = Live.statusLine().text;
    Views.syncControls();
  }

  /* Two-step, in place, and self-reverting. A dialog would steal focus from the
     panel the reader is still working in; a single button that wipes five stores
     is one nobody can press with confidence. */
  function armReset(on){
    const box = el('ctrlResetConfirm');
    if(box) box.hidden = !on;
    clearTimeout(resetTimer);
    if(on) resetTimer = setTimeout(() => armReset(false), 5000);
  }

  function resetAll(){
    State.clearStore();
    try{ localStorage.removeItem(I18n.STORE_KEY); }catch(e){}
    try{ localStorage.removeItem(Theme.STORE_KEY); }catch(e){}
    try{ localStorage.removeItem(IosHint.STORE_KEY); }catch(e){}
    try{ location.reload(); }catch(e){}
  }

  return { open, toggle, isOpen, render, armReset, resetAll };
})();
```

- [ ] **Step 5: Replace the sheet wiring**

Replace `index.html:8779-8794`:

```js
  el('btnPanel').addEventListener('click', Panel.toggle);
  el('fabSim').addEventListener('click', () => Panel.open(true));
  el('ctrlClose').addEventListener('click', () => Panel.open(false));
  el('ctrlPanel').addEventListener('click', e => {      // tap the scrim to dismiss
    if(e.target.id === 'ctrlPanel') Panel.open(false);
  });

  el('btnPauseP').addEventListener('click', () => Telemetry.togglePause());
  el('btnSpeedP').addEventListener('click', () => Telemetry.cycleSpeed());
  el('btnSyncP').addEventListener('click', () => refreshHome().catch(() => {}));
  el('btnRefreshP').addEventListener('click', () => refreshHome().catch(() => {}));

  el('btnAlarmP').addEventListener('click', () => {
    State.commit({ muted: !State.data.muted });
    Views.renderMute(); Panel.render(); State.save();
  });
  el('btnHapticsP').addEventListener('click', () => {
    State.commit({ haptics: State.data.haptics === false });
    Panel.render(); State.save();
  });

  /* The one control that answers "is the alarm working" without waiting for a
     frost. It also unlocks audio: an engine that needs a gesture has just had
     one, so pressing this arms the alarm for the session. */
  el('btnTestAlarm').addEventListener('click', () => {
    Alarm.unlock();
    const out = Alarm.fire('critical');
    if(out === 'muted')
      Log.add('info', 'Alert sound is off', 'Turn it back on above to hear the alarm.');
    else if(out === 'silent')
      Log.add('warning', 'No way to alert you', 'This device offers neither sound nor vibration to the app.');
    else if(out === 'buzzed')
      Log.add('info', 'Vibration only', 'This device gave the app no way to play a sound.');
  });

  el('btnThemeP').addEventListener('click', () => { Panel.open(false); el('btnTheme').click(); });
  el('btnLangP').addEventListener('click',  () => { Panel.open(false); el('btnLang').click(); });
  el('btnFarmP').addEventListener('click',  () => { Panel.open(false); el('btnFarm').click(); });
  el('btnManualP').addEventListener('click',() => { Panel.open(false); Manual.toggle(); });

  el('btnClearChat').addEventListener('click', () => {
    State.data.chat.length = 0;
    Views.renderChat(); State.save();
  });
  el('btnResetAll').addEventListener('click', () => Panel.armReset(true));
  el('btnResetNo').addEventListener('click', () => Panel.armReset(false));
  el('btnResetYes').addEventListener('click', Panel.resetAll);
```

Confirm the real method names on `Telemetry` before writing them: run
`grep -n "togglePause\|cycleSpeed\|return { " index.html | sed -n '1,20p'` and read the module's export list. If the pause and speed buttons are wired inline at their old listeners rather than through named methods, lift those bodies into the two calls above instead.

- [ ] **Step 6: Extend the Escape ladder and add the shortcut**

Replace the handler at `index.html:8806-8820`:

```js
  document.addEventListener('keydown', e => {
    if(e.key === 'Escape'){
      // Innermost layer first: the manual sits above the panel.
      if(Manual.isOpen()) Manual.close(); else Panel.open(false);
      return;
    }
    if(e.key === 'Tab'){ Manual.trapFocus(e); return; }
    const typing = document.activeElement &&
                   /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    /* Ctrl/⌘+K for the panel, "?" for the manual. Neither fires while the reader
       is mid-sentence in the composer -- a shortcut that eats a keystroke is
       worse than no shortcut. */
    if((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey) && !e.altKey && !typing){
      e.preventDefault();
      Panel.toggle();
      return;
    }
    if(e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey){
      e.preventDefault();
      Manual.toggle();
    }
  });
```

- [ ] **Step 7: Paint the panel after restore**

At `index.html:9105`, beside the two calls that already run after restore for exactly this reason:

```js
  Views.renderMute();
  Views.syncConsole();
  Panel.render();
```

And add `Panel` to the harness probe list in `tests/harness.js` so the tests can reach it.

- [ ] **Step 8: Run the whole suite**

Run: `node tests/run.js`
Expected: all green. `controls · every referenced element exists` scrapes `el('…')` calls out of the script and checks each against the markup, so a typo in any new id fails there.

- [ ] **Step 9: Commit**

```bash
git add index.html tests/harness.js tests/controls.test.js
git commit -m "A panel that reaches the commands instead of reimplementing them"
```

---

## Task 9: Reset asks once

**Files:**
- Modify: none (Task 8 wired it); this task only proves it
- Test: `tests/controls.test.js`

- [ ] **Step 1: Write the tests**

```js
    test('one press does not reset anything', () => {
      const h = boot();
      h.app.State.save();
      const before = h.storage.size;
      h.document.getElementById('btnResetAll').dispatch('click');
      assert.equal(h.document.getElementById('ctrlResetConfirm').hidden, false,
        'the confirmation never appeared');
      assert.equal(h.storage.size, before, 'one press wiped the store');
    });

    test('cancelling puts it away', () => {
      const h = boot();
      h.document.getElementById('btnResetAll').dispatch('click');
      h.document.getElementById('btnResetNo').dispatch('click');
      assert.equal(h.document.getElementById('ctrlResetConfirm').hidden, true,
        'cancel left the reset armed');
    });

    /* Armed and forgotten is the dangerous state: a reader who walked away comes
       back to a Yes button under their thumb. */
    test('an armed reset disarms itself', () => {
      const h = boot();
      h.document.getElementById('btnResetAll').dispatch('click');
      h.timers.advance(6000);
      assert.equal(h.document.getElementById('ctrlResetConfirm').hidden, true,
        'the reset stayed armed after the reader left it');
    });

    test('confirming clears every store the app writes', () => {
      const h = boot({ storage: { 'aura-agrinet:v1': '{}', 'aura-lang': 'pt', 'aura-theme': 'dark' } });
      let reloaded = false;
      h.window.location.reload = () => { reloaded = true; };
      h.document.getElementById('btnResetAll').dispatch('click');
      h.document.getElementById('btnResetYes').dispatch('click');
      ['aura-agrinet:v1', 'aura-lang', 'aura-theme'].forEach(k =>
        assert.notOk(h.storage.has(k), `${k} survived a reset that said it clears everything`));
      assert.ok(reloaded, 'the page kept running on state it had just deleted');
    });
```

- [ ] **Step 2: Run**

Run: `node tests/run.js controls`
Expected: PASS. If `location.reload` is not assignable on the sandbox's `location` object, add `reload: () => {}` to the `location` literal in `tests/harness.js` and reassign in the test.

- [ ] **Step 3: Commit**

```bash
git add tests/controls.test.js
git commit -m "Reset asks once and forgets it asked"
```

---

## Task 10: Translations, in the same commit as the strings

The catalogues sit at exactly 1.0 coverage over 556 strings, and `i18n · catalogues` asserts `meta.coverage` within 0.02 of the real ratio. Every new English string must arrive with its three translations.

**Files:**
- Modify: `i18n/es.json`, `i18n/fr.json`, `i18n/pt.json`

- [ ] **Step 1: List what is missing**

```bash
node -e "
const m=require('./tests/i18n.test.js'); m({suite:()=>{},test:()=>{},assert:{}});
const app=[...m.appStrings()];
for(const c of ['es','fr','pt']){
  const j=require('./i18n/'+c+'.json');
  const missing=app.filter(s=>!(s in j.strings));
  console.log('--',c,'missing',missing.length);
  missing.forEach(s=>console.log('   ',JSON.stringify(s)));
}"
```

Expected: the same list for all three — the panel's section names, its buttons, its notes, the reset copy and the three test-button log lines.

- [ ] **Step 2: Add every missing key to all three catalogues**

Keep each file's existing key order and formatting. Placeholders must survive verbatim: the suite compares `{...}` tokens on both sides and fails when one is lost.

- [ ] **Step 3: Leave `meta.coverage` at 1**

It is asserted against the real ratio, so it stays 1 only if nothing was skipped. Do not adjust it to fit a gap — fill the gap.

- [ ] **Step 4: Verify**

Run: `node tests/run.js i18n`
Expected: all green, including `reports its coverage honestly` and `placeholders survive translation`.

- [ ] **Step 5: Commit**

```bash
git add i18n/
git commit -m "The panel speaks four languages"
```

---

## Task 11: The pack

**Files:**
- Modify: `sw.js:9`, `android/app/build.gradle.kts:13-14`, `README.md`
- Delete: `android/AURA-AgriNet-1.0-debug.apk`

- [ ] **Step 1: Bump the cache**

`sw.js:9`:

```js
const CACHE_VERSION = 'aura-v25';
```

An installed copy serves the old cache until a new version activates. Without this the work ships nothing.

- [ ] **Step 2: Bump the package version**

`android/app/build.gradle.kts`:

```kotlin
        versionCode = 2
        versionName = "1.1"
```

- [ ] **Step 3: Verify the asset tests still hold**

Run: `node tests/run.js assets`
Expected: all green. `CACHE_VERSION` is asserted against `/^aura-v\d+$/`, and the precache list is checked entry by entry against files on disk.

- [ ] **Step 4: Rebuild the APK**

JDK 17 is at `C:/Users/danil/AppData/Local/Programs/Java/jdk-17.0.20+8` and the SDK at `C:/Users/danil/AppData/Local/Android/Sdk`; both are verified present, and `java` is not on PATH, so `JAVA_HOME` must be passed explicitly.

```bash
cd android && JAVA_HOME="C:/Users/danil/AppData/Local/Programs/Java/jdk-17.0.20+8" ./gradlew assembleDebug
```

Expected: `BUILD SUCCESSFUL`, and a final line `APK: …/AURA-AgriNet-1.1-debug.apk`. `syncWebAssets` runs first and copies the new `index.html`, `sw.js` and `i18n/` into the package.

- [ ] **Step 5: Remove the stale binary**

```bash
git rm android/AURA-AgriNet-1.0-debug.apk
```

A stale binary that looks current is worse than none — the same argument the gradle file already makes about buried outputs.

- [ ] **Step 6: Update the README**

Document the panel (how to open it: header button, FAB, Ctrl+K), the two alert tones and what each fires on, and the vibration switch. Find the existing section on the console and the alarm and extend it rather than starting a new one.

- [ ] **Step 7: Full suite, then commit**

Run: `node tests/run.js`
Expected: all green.

```bash
git add sw.js android/app/build.gradle.kts android/AURA-AgriNet-1.1-debug.apk README.md
git commit -m "Ship it: a new cache, a new package, and a note saying what changed"
```

---

## Self-Review

**Spec coverage:** §1.1 → Task 2; §1.2 → Task 3; §1.3 → Task 4; §1.4 → Task 1; §2.1 → Task 2; §2.2 → Task 5; §2.3 → Task 3; §2.4 → Task 2; §2.5 → Task 4; §3.1–3.3 → Tasks 7–8; §3.4 → Tasks 8–9; §3.5 → Task 6; §4 → Tasks 1–9 throughout; §5 → Task 11; §6 → Task 10 (i18n) and Task 7 Step 5 (real CSS, asserted).

**Type consistency:** `fire(sev)` returns one of `muted|silent|buzzed|coalesced|waking|played`, with `blocked` reachable only through `lastOutcome()` after an async rejection — used consistently in Tasks 2, 3, 5 and 8. `toneFor(msg)` returns a `TONES` key or `null`; `shouldFire` is defined in terms of it. `play(c, sev)` returns the end time or `0`. Panel methods `open/toggle/isOpen/render/armReset/resetAll` are used exactly as declared.

**Two things Task 8 must confirm rather than assume**, both flagged in place: the real `Telemetry` method names behind the pause and speed buttons, and whether `location.reload` is assignable on the harness sandbox.
