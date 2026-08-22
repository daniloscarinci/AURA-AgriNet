# UI/UX Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mission console with a per-role triage deck whose detail opens as a sheet on a phone and a pane above 1024 px, and move the console into Ops.

**Architecture:** A new `Triage` module classifies each agronomy call into *Needs you* / *Watching* / *Clear* by reading the `tone` each card already computes, and orders within a group by deadline. `Views` renders that classification as a deck; one `detailFor(id)` renderer feeds both the phone sheet and the desktop pane. Nothing about the agronomy arithmetic, routing, scoring or event engine changes.

**Tech Stack:** One HTML file, one prebuilt stylesheet, one service worker. No dependencies, no build step. Tests are `node tests/run.js` against a stub DOM in a `vm` context.

**Spec:** `docs/superpowers/specs/2026-08-21-ui-restructure-design.md`

---

## Ground rules that break this build if ignored

1. **`app.css` is prebuilt and there is no build step.** A Tailwind utility class not already in that file does nothing. `gap-5` shipped inert once. All new styling goes in the inline `<style>` block in `index.html`.
2. **Every user-facing string goes through `t()`.** Attributes need `data-i18n-attr="placeholder,aria-label"` — a DOM walk cannot see an attribute.
3. **Bump `CACHE_VERSION` in `sw.js`** at the end, or installed copies serve yesterday's shell.
4. **Run `node tests/run.js` after every task.** Baseline is 633 checks, 633 passing.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `index.html` `<style>` | modify | safe-area custom properties, deck and detail CSS |
| `index.html` `<head>` | modify | `viewport-fit=cover` |
| `index.html` markup | modify | deck hosts, detail sheet shell, Ops section |
| `index.html` Module 7c | **create** | `Triage` — classification and ordering |
| `index.html` Module 7 | modify | `Views.renderDeck`, `Views.openDetail`, `Views.detailFor` |
| `tests/triage.test.js` | **create** | classification, ordering, advisory override |
| `tests/controls.test.js` | modify | deck reachability |
| `tests/assets.test.js` | modify | safe-area assertions |
| `tests/i18n.test.js` | modify | `paneFarmer` reference at line 742 |
| `i18n/{es,fr,pt}.json` | modify | new keys |
| `sw.js` | modify | `CACHE_VERSION` |

---

### Task 1: Safe areas

The stylesheet already uses `env(safe-area-inset-*)` four times. All four resolve to zero because the viewport meta never opted in. Android pads the WebView itself (`MainActivity.java:122`), so this fixes the browser and the installed PWA and leaves the APK correct.

**Files:**
- Modify: `index.html:5` (viewport meta), `index.html:46` (`:root`), `index.html:495` (`.tabbar`), `index.html:970` (header)
- Test: `tests/assets.test.js`

- [ ] **Step 1: Write the failing test**

Append this suite to `tests/assets.test.js`, inside the exported function, beside the other suites:

```js
  /* ================================================= safe areas =========== */
  suite('assets · safe areas', () => {
    const { html, markup } = readSource();

    test('the viewport opts into the display cutout', () =>
      assert.includes(html, 'viewport-fit=cover',
        'env(safe-area-inset-*) resolves to zero without viewport-fit=cover'));

    test(':root resolves the insets into custom properties', () => {
      assert.includes(html, '--safe-t: env(safe-area-inset-top, 0px)');
      assert.includes(html, '--safe-b: env(safe-area-inset-bottom, 0px)');
    });

    test('the header clears the status bar', () =>
      assert.includes(html, 'padding-top:var(--safe-t)',
        'the header must not run under the status bar'));

    test('the tab bar clears the gesture bar', () =>
      assert.includes(html, 'padding-bottom:var(--safe-b)',
        'the tab bar must not run under the gesture bar'));

    test('the shell still declares a translucent iOS status bar', () =>
      assert.includes(markup, 'black-translucent',
        'dropping this changes the inset contract'));
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/run.js assets -v`
Expected: FAIL — `the viewport opts into the display cutout: expected to include "viewport-fit=cover"`

- [ ] **Step 3: Opt the viewport in**

`index.html:5` — replace:

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

with:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

- [ ] **Step 4: Resolve the insets once**

In `index.html`, inside `:root{` (just after `color-scheme: light;` at line 47), add:

```css
  /* The window's own furniture. Resolved once here so every surface that has to
     clear the status bar or the gesture bar reads a variable rather than
     repeating an env() call that is easy to forget. Zero on a desktop browser,
     zero in the Android wrapper — which pads the WebView itself — and non-zero
     on a phone in portrait, which is the case that was broken. */
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
```

- [ ] **Step 5: Pad the surfaces that touch an edge**

`index.html:970` — the header's inline style gains a top pad:

```html
<header class="sticky top-0 z-40" style="background:var(--header-bg);backdrop-filter:blur(12px);border-bottom:1px solid var(--hairline);padding-top:var(--safe-t)">
```

`index.html:501` — inside `.tabbar{`, replace `padding-bottom:env(safe-area-inset-bottom, 0px);` with:

```css
  padding-bottom:var(--safe-b);
```

`index.html:593` — inside `.sheet-panel{`, replace the padding line with:

```css
  padding:8px 14px calc(20px + var(--safe-b));
```

`index.html:573` — inside `.fab{`, replace the bottom line with:

```css
  bottom:calc(84px + var(--safe-b));
```

`index.html:911` — inside the `.manual-scroll` rule, replace its padding with:

```css
  .manual-scroll{ padding:4px 18px calc(48px + var(--safe-b)); }
```

- [ ] **Step 6: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 638 checks, 638 passed, 0 failed

- [ ] **Step 7: Commit**

```bash
git add index.html tests/assets.test.js
git commit -m "Insets the app already wrote, and never turned on"
```

---

### Task 2: The Triage module

Classification before markup. This task adds no UI at all.

**Files:**
- Modify: `index.html` — new Module 7c immediately before `/* ===================== MODULE 7b: MANUAL` (line 4306)
- Create: `tests/triage.test.js`
- Modify: `tests/run.js` — register the new file

- [ ] **Step 1: Write the failing test**

Create `tests/triage.test.js`:

```js
/* Triage classification.

   The deck's whole claim is that it ranks correctly. A card in the wrong group
   is worse than no ranking at all: "Clear" is a promise, and a frost sorted
   under it is a lie the user has no reason to check. */
'use strict';

const { boot } = require('./harness');

module.exports = ({ suite, test, assert }) => {

  suite('triage · tone maps to a group', () => {
    const { app } = boot();
    const { Triage } = app;

    test('act is Needs you', () => assert.equal(Triage.groupOf('act'), 'act'));
    test('warn is Watching',  () => assert.equal(Triage.groupOf('warn'), 'warn'));
    test('ok is Clear',       () => assert.equal(Triage.groupOf('ok'), 'ok'));
    test('an unknown tone falls to Clear rather than vanishing', () =>
      assert.equal(Triage.groupOf('nonsense'), 'ok'));
  });

  suite('triage · each call lands in the right group', () => {
    const { app } = boot();
    const { Triage } = app;

    const cases = [
      ['water',   { call:'irrigate' },              'act'],
      ['water',   { call:'monitor' },               'warn'],
      ['water',   { call:'hold' },                  'ok'],
      ['thermal', { verdict:'frost' },              'act'],
      ['thermal', { verdict:'heat' },               'warn'],
      ['thermal', { verdict:'marginal' },           'warn'],
      ['thermal', { verdict:'clear' },              'ok'],
      ['spray',   { nextWindow:null },              'act'],
      ['spray',   { nextWindow:{ start:6, len:5 } },'warn'],
      ['spray',   { nextWindow:{ start:0, len:5 } },'ok'],
      ['traffic', { call:'blocked' },               'act'],
      ['traffic', { call:'degrading' },             'warn'],
      ['traffic', { call:'clear' },                 'ok'],
      ['gdd',     { rate:14.2 },                    'ok'],
    ];

    cases.forEach(([id, model, want]) => {
      test(`${id} ${JSON.stringify(model)} is ${want}`, () =>
        assert.equal(Triage.toneOf(id, model), want));
    });
  });

  suite('triage · an armed advisory outranks its card', () => {
    const { app } = boot();
    const { Triage } = app;

    test('a critical alert pins its card to Needs you', () => {
      const alerts = new Map([['FROST_EVENT', { id:'FROST_EVENT', severity:'critical' }]]);
      assert.equal(Triage.toneOf('thermal', { verdict:'clear' }, alerts), 'act');
    });

    test('a warning alert lifts its card to Watching', () => {
      const alerts = new Map([['SOIL_STRESS', { id:'SOIL_STRESS', severity:'warning' }]]);
      assert.equal(Triage.toneOf('water', { call:'hold' }, alerts), 'warn');
    });

    test('an alert never demotes a card', () => {
      const alerts = new Map([['SOIL_STRESS', { id:'SOIL_STRESS', severity:'warning' }]]);
      assert.equal(Triage.toneOf('water', { call:'irrigate' }, alerts), 'act');
    });

    test('an alert for another card leaves this one alone', () => {
      const alerts = new Map([['FLOOD_SATURATION', { id:'FLOOD_SATURATION', severity:'critical' }]]);
      assert.equal(Triage.toneOf('water', { call:'hold' }, alerts), 'ok');
    });
  });

  suite('triage · ordering', () => {
    const { app } = boot();
    const { Triage } = app;

    test('groups come out act, then warn, then ok', () => {
      const items = Triage.order([
        { id:'gdd',     tone:'ok',   deadline: 700 },
        { id:'spray',   tone:'act',  deadline: 0 },
        { id:'traffic', tone:'warn', deadline: 24 },
      ]);
      assert.deepEqual(items.map(i => i.id), ['spray', 'traffic', 'gdd']);
    });

    test('inside a group the soonest deadline sorts first', () => {
      const items = Triage.order([
        { id:'water',   tone:'act', deadline: 48 },
        { id:'spray',   tone:'act', deadline: 0 },
        { id:'thermal', tone:'act', deadline: 12 },
      ]);
      assert.deepEqual(items.map(i => i.id), ['spray', 'thermal', 'water']);
    });

    test('ordering is stable when deadlines tie', () => {
      const items = Triage.order([
        { id:'water', tone:'ok', deadline: 72 },
        { id:'gdd',   tone:'ok', deadline: 72 },
      ]);
      assert.deepEqual(items.map(i => i.id), ['water', 'gdd']);
    });
  });

  suite('triage · counts', () => {
    const { app } = boot();
    const { Triage } = app;

    test('counts report each group', () => {
      const c = Triage.counts([
        { tone:'act' }, { tone:'warn' }, { tone:'ok' }, { tone:'ok' },
      ]);
      assert.equal(c.act, 1);
      assert.equal(c.warn, 1);
      assert.equal(c.ok, 2);
    });

    test('an empty deck counts zero everywhere', () => {
      const c = Triage.counts([]);
      assert.equal(c.act, 0);
      assert.equal(c.warn, 0);
      assert.equal(c.ok, 0);
    });
  });
};
```

- [ ] **Step 2: Register the file**

In `tests/run.js`, find the array of test files and add `'triage.test.js'` after `'logic.test.js'`.

- [ ] **Step 3: Run it and watch it fail**

Run: `node tests/run.js triage -v`
Expected: FAIL — `Cannot read properties of undefined (reading 'groupOf')`

- [ ] **Step 4: Write the module**

In `index.html`, immediately before the line `/* ===================== MODULE 7b: MANUAL =====================`, insert:

```js
/* ===================== MODULE 7c: TRIAGE =====================

   What the deck ranks by. Each agronomy card already resolves itself to a tone
   of act / warn / ok for its headline colour; this reads that same field rather
   than inventing a second severity vocabulary that could disagree with the one
   on screen.

   Two rules sit on top of the tone:

     - An ARMED ADVISORY OUTRANKS ITS CARD. The rule engine and the deck must
       never contradict each other, so a critical alert pins its card to "Needs
       you" whatever the tone says. An alert only ever promotes.

     - TIES BREAK BY DEADLINE. Within a group the call that bites soonest sorts
       first, in hours from now.

   Nothing here reads the DOM, which is what makes it testable on its own. */

const Triage = (() => {

  /* Which armed advisory belongs to which call. An alert no card claims is not
     dropped -- Views turns it into a card of its own, so an armed rule can never
     be invisible. */
  const CLAIMS = {
    water:   ['SOIL_STRESS'],
    thermal: ['FROST_EVENT', 'HEATWAVE'],
    traffic: ['FLOOD_SATURATION'],
    spray:   [],
    gdd:     []
  };

  const GROUPS = ['act', 'warn', 'ok'];
  const RANK   = { act: 0, warn: 1, ok: 2 };

  /* Severity is the rule engine's vocabulary; tone is the deck's. Only these
     two severities promote -- a 'good' entry is a release, not an alarm. */
  const SEV_TONE = { critical: 'act', serious: 'act', warning: 'warn' };

  function groupOf(tone){ return RANK[tone] === undefined ? 'ok' : tone; }

  /** The stronger of two tones, act being strongest. */
  function strongest(a, b){
    return RANK[groupOf(a)] <= RANK[groupOf(b)] ? groupOf(a) : groupOf(b);
  }

  /** Tone from the card's own model, before advisories are considered. */
  function baseTone(id, m){
    if(!m) return 'ok';
    switch(id){
      case 'water':   return m.call === 'irrigate' ? 'act' : m.call === 'monitor' ? 'warn' : 'ok';
      case 'thermal': return m.verdict === 'frost' ? 'act'
                           : (m.verdict === 'heat' || m.verdict === 'marginal') ? 'warn' : 'ok';
      case 'spray':   return !m.nextWindow ? 'act' : m.nextWindow.start === 0 ? 'ok' : 'warn';
      case 'traffic': return m.call === 'blocked' ? 'act' : m.call === 'degrading' ? 'warn' : 'ok';
      case 'gdd':     return 'ok';
      default:        return 'ok';
    }
  }

  /** Tone with any armed advisory this card claims folded in. */
  function toneOf(id, model, alerts){
    let tone = baseTone(id, model);
    if(!alerts || !alerts.size) return tone;
    (CLAIMS[id] || []).forEach(ruleId => {
      const a = alerts.get(ruleId);
      if(a && SEV_TONE[a.severity]) tone = strongest(tone, SEV_TONE[a.severity]);
    });
    return tone;
  }

  /** Hours from now until the call bites, for tie-breaking inside a group. */
  function deadlineOf(id, m){
    if(!m) return 999;
    switch(id){
      case 'water':   return m.call === 'irrigate' ? 0 : m.call === 'monitor' ? 24 : 72;
      case 'thermal': return m.firstFrostIn !== null && m.firstFrostIn !== undefined ? m.firstFrostIn
                           : m.firstHeatIn !== null && m.firstHeatIn !== undefined ? m.firstHeatIn : 72;
      case 'spray':   return m.nextWindow ? m.nextWindow.start : 0;
      case 'traffic': return m.call === 'blocked' ? 0 : m.call === 'degrading' ? 24 : 72;
      case 'gdd':     return m.daysAtRate ? m.daysAtRate * 24 : 999;
      default:        return 999;
    }
  }

  /** Group first, then soonest deadline. Array.prototype.sort is stable in
      every engine this runs on, so equal keys keep their input order. */
  function order(items){
    return items.slice().sort((a, b) =>
      (RANK[groupOf(a.tone)] - RANK[groupOf(b.tone)]) || (a.deadline - b.deadline));
  }

  function counts(items){
    const c = { act: 0, warn: 0, ok: 0 };
    items.forEach(i => { c[groupOf(i.tone)]++; });
    return c;
  }

  return { CLAIMS, GROUPS, groupOf, baseTone, toneOf, deadlineOf, order, counts };
})();
```

- [ ] **Step 5: Export it to the harness**

Find the `__AURA__` export near the end of the bootstrap module and add `Triage` to the exported object, beside `Views`.

Run: `grep -n "__AURA__" index.html` to locate it.

- [ ] **Step 6: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 665 checks, 665 passed, 0 failed

- [ ] **Step 7: Commit**

```bash
git add index.html tests/triage.test.js tests/run.js
git commit -m "What needs you, what is worth watching, and what is fine"
```

---

### Task 3: A trafficability model the deck can rank

Trafficability is a tile and a route chip today, which buries the one reading that decides whether the crop can leave the farm. Task 2's `Triage` already expects a `traffic` model shaped `{ traff, blocked, degraded, call }`; this task produces it.

**Files:**
- Modify: `index.html` — `Dispatch` module, beside `blockedEdges` (line 2168)
- Modify: `tests/triage.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/triage.test.js`, inside the exported function:

```js
  suite('triage · trafficability model', () => {
    const { app, advance } = boot();
    const { Dispatch, State } = app;

    test('a healthy network reads clear', () => {
      State.data.latest.traff = 92;
      Dispatch.refreshEdges();
      const m = Dispatch.trafficModel();
      assert.equal(m.call, 'clear');
      assert.equal(m.blocked, 0);
    });

    test('a degrading network reads degrading', () => {
      State.data.latest.traff = 57;
      Dispatch.refreshEdges();
      const m = Dispatch.trafficModel();
      assert.includes(['degrading', 'blocked'], m.call);
      assert.greater(m.degraded, 0);
    });

    test('a blocked segment reads blocked', () => {
      State.data.latest.traff = 20;
      Dispatch.refreshEdges();
      const m = Dispatch.trafficModel();
      assert.equal(m.call, 'blocked');
      assert.greater(m.blocked, 0);
    });

    test('no reading yields no model rather than a wrong one', () => {
      State.data.latest.traff = null;
      assert.equal(Dispatch.trafficModel(), null);
    });
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/run.js triage -v`
Expected: FAIL — `Dispatch.trafficModel is not a function`

- [ ] **Step 3: Write the model**

In `index.html`, immediately after the `blockedEdges()` function (around line 2170), add:

```js
  /** Trafficability as a call rather than a percentage, so the deck can rank it
      beside the agronomy. "Blocked" means at least one segment is under the
      passability floor -- not that the route is impossible, which the router
      decides -- and "degrading" means the mean has fallen past the arming
      threshold or some segment already has. */
  function trafficModel(){
    const v = State.data.latest.traff;
    if(v === null || v === undefined) return null;
    const edges = State.data.edgeState || {};
    const list = Object.keys(edges).map(k => edges[k]);
    const blocked  = list.filter(e => !e.passable).length;
    const degraded = list.filter(e => e.degraded).length;
    const call = blocked ? 'blocked'
               : (v <= CFG.THRESH.traffArm || degraded) ? 'degrading' : 'clear';
    return { traff: v, blocked, degraded, call };
  }
```

- [ ] **Step 4: Export it**

Find the `Dispatch` module's `return {` and add `trafficModel` beside `blockedEdges`.

Run: `grep -n "blockedEdges," index.html` to locate the export list.

- [ ] **Step 5: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 669 checks, 669 passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add index.html tests/triage.test.js
git commit -m "Trafficability answers a question instead of reporting a percentage"
```

---

### Task 4: Deck markup and CSS

**Files:**
- Modify: `index.html` `<style>` — after the `.agro` rules
- Modify: `index.html` markup — `#paneFarmer` becomes the deck host

- [ ] **Step 1: Add the deck stylesheet**

In `index.html`, after the `.agro-grid` rules in the inline `<style>`, add:

```css
/* ==========================================================================
   THE DECK

   One column of calls, grouped by whether they need you. A collapsed row states
   its verdict and nothing else; the card that needs you keeps its chart. The
   same markup is a phone column and a desktop rail -- only the width changes,
   which is why none of these rules mention a breakpoint.
   ========================================================================== */
.deck{ display:flex; flex-direction:column; gap:8px; }

.deck-group{
  display:flex; align-items:center; gap:6px;
  padding:10px 2px 4px; font-size:9px; font-weight:750;
  letter-spacing:.14em; text-transform:uppercase;
}
.deck-group .rule{ flex:1; height:1px; background:var(--hairline); }
.deck-group .count{ font-size:9px; font-weight:600; color:var(--text-muted); }
.deck-group.act  { color:var(--warning-ink); }
.deck-group.warn { color:var(--serious-ink); }
.deck-group.ok   { color:var(--good-ink); }

.deck-row{
  display:flex; align-items:center; gap:9px; width:100%; text-align:left;
  background:var(--surface-1); border:1px solid var(--hairline);
  border-radius:12px; padding:10px 12px; cursor:pointer;
  font-family:inherit; color:inherit; min-height:44px;
}
.deck-row:hover{ border-color:var(--hairline-2); }
.deck-row[aria-expanded="true"]{ border-color:var(--series-1); }
.deck-row .dot{ flex:none; width:7px; height:7px; border-radius:50%; }
.deck-row .txt{ flex:1; min-width:0; }
.deck-row .name{ display:block; font-size:12px; font-weight:650; }
.deck-row .sub{ display:block; font-size:10px; color:var(--text-muted); margin-top:1px; }
.deck-row .verdict{ font-size:11.5px; font-weight:700; white-space:nowrap; }
.deck-row .chev{ font-size:12px; color:var(--axis); flex:none; }

.deck-card{
  background:var(--surface-1); border:1px solid var(--hairline);
  border-radius:14px; padding:12px 13px; border-left-width:3px;
}
.deck-card.act { border-left-color:var(--warning); }
.deck-card.warn{ border-left-color:var(--serious); }
.deck-card.ok  { border-left-color:var(--good); }
.deck-card .head{ display:flex; align-items:center; gap:6px; }
.deck-card .name{
  flex:1; font-size:9px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--text-muted); font-weight:650;
}
.deck-call{
  font-size:21px; font-weight:700; letter-spacing:-.025em;
  line-height:1.08; margin:6px 0 3px;
}
.deck-call.act { color:var(--warning-ink); }
.deck-call.warn{ color:var(--serious-ink); }
.deck-call.ok  { color:var(--good-ink); }
.deck-why{ font-size:11px; line-height:1.45; color:var(--text-secondary); }

.deck-empty{
  background:var(--surface-1); border:1px solid var(--hairline);
  border-radius:14px; padding:18px 14px; text-align:center;
  font-size:12px; color:var(--text-secondary); line-height:1.5;
}

/* Sparkline inside a collapsed row: small enough that it reads as texture, not
   as a chart you are meant to measure. */
.deck-spark{ flex:none; width:46px; height:18px; display:block; }
```

- [ ] **Step 2: Give the deck a host**

`index.html:1044` — replace the three role pane sections:

```html
  <section class="rolepane lg:col-span-12" data-pane="FARMER" id="paneFarmer"></section>
  <section class="rolepane lg:col-span-12" data-pane="BUYER"  id="paneBuyer"></section>
  <section class="rolepane lg:col-span-12" data-pane="DRIVER" id="paneDriver"></section>
```

with:

```html
  <!-- ─────────── ROLE PANES ───────────
       The Farmer pane is the triage deck. Buyer and Driver keep their existing
       renderers until Task 8 gives them decks of their own. -->
  <section class="rolepane lg:col-span-12" data-pane="FARMER" id="paneFarmer">
    <div id="farmerDeck" class="deck" role="list"></div>
  </section>
  <section class="rolepane lg:col-span-12" data-pane="BUYER"  id="paneBuyer"></section>
  <section class="rolepane lg:col-span-12" data-pane="DRIVER" id="paneDriver"></section>
```

- [ ] **Step 3: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 669 checks, 669 passed, 0 failed. (Nothing renders into `#farmerDeck` yet; this step only proves the markup did not break anything.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "A column that can hold a ranked day"
```

---

### Task 5: Render the deck

**Files:**
- Modify: `index.html` — `Views`, beside `renderAgronomy` (line 3972)
- Modify: `tests/controls.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/controls.test.js`, inside the exported function:

```js
  /* ====================================================== the deck ========= */
  suite('controls · deck reachability', () => {
    const { app, document } = boot();
    const { Views, Triage } = app;

    test('the deck renders into its host', () => {
      Views.renderDeck();
      assert.ok(document.getElementById('farmerDeck').innerHTML.length > 0,
        'the deck host is empty after a render');
    });

    test('every deck row names a card the detail renderer knows', () => {
      Views.renderDeck();
      const html = document.getElementById('farmerDeck').innerHTML;
      const ids = [...html.matchAll(/data-call="([^"]+)"/g)].map(m => m[1]);
      ids.forEach(id =>
        assert.ok(Views.detailFor(id) !== null && Views.detailFor(id) !== undefined,
          `the deck offers ${id} but no detail renderer answers for it`));
    });

    test('every deck row is a button, so a keyboard reaches it', () => {
      Views.renderDeck();
      const html = document.getElementById('farmerDeck').innerHTML;
      const rows = [...html.matchAll(/data-call="/g)].length;
      const buttons = [...html.matchAll(/<button[^>]*class="deck-row/g)].length
                    + [...html.matchAll(/<button[^>]*class="deck-card/g)].length;
      assert.equal(buttons, rows, 'a deck row that is not a button cannot be tabbed to');
    });

    test('a deck with no live location says so rather than rendering blank', () => {
      Views.renderDeck();
      const html = document.getElementById('farmerDeck').innerHTML;
      assert.ok(html.includes('deck-empty') || html.includes('data-call'),
        'the deck rendered neither calls nor an empty state');
    });

    test('the group headings cover every tone', () => {
      assert.deepEqual(Triage.GROUPS, ['act', 'warn', 'ok']);
    });
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/run.js controls -v`
Expected: FAIL — `Views.renderDeck is not a function`

- [ ] **Step 3: Write the renderer**

In `index.html`, immediately after `renderAgronomy()` ends (line 3988), add:

```js
  /* ---------- the deck ----------

     Views owns the models; Triage owns the ranking. Keeping them apart is what
     lets the ordering be tested without a DOM.

     An armed advisory that no card claims becomes a card of its own, so a rule
     the engine fired can never be missing from the screen that claims to list
     everything needing you. */

  const DECK_NAME = {
    water:   'Water balance',
    spray:   'Spray & fieldwork',
    thermal: 'Next 72 hours',
    traffic: 'Trafficability',
    gdd:     'Heat units'
  };

  const GROUP_LABEL = { act:'Needs you', warn:'Watching', ok:'Clear' };
  const TONE_COLOUR = { act:'var(--warning)', warn:'var(--serious)', ok:'var(--good)' };

  /** Every model the deck ranks, gathered once per paint. */
  function deckModels(){
    if(!Live.ready()) return null;
    const now  = State.data.clock;
    const crop = Region.cropOf(ROUTE_ORIGIN) || Region.cropOf('F1');
    return {
      water:   Agronomy.water(now),
      spray:   Agronomy.spray(now),
      thermal: Agronomy.thermal(now),
      traffic: Dispatch.trafficModel(),
      gdd:     Agronomy.heatUnits(crop)
    };
  }

  /** The one-line verdict a collapsed row shows. */
  function deckVerdict(id, m){
    if(!m) return '—';
    switch(id){
      case 'water':   return m.call === 'irrigate' ? t('Irrigate · {mm} mm', { mm: fmt(m.applyMm, 0) })
                           : m.call === 'monitor'  ? t('Monitor') : t('Hold');
      case 'spray':   return !m.nextWindow ? t('No window in 48 h')
                           : m.nextWindow.start === 0 ? t('Spray now · {len} h', { len: m.nextWindow.len })
                           : t('Wait {start} h · {len} h window', { start: m.nextWindow.start, len: m.nextWindow.len });
      case 'thermal': return m.verdict === 'frost' ? t('Frost in {h} h', { h: m.firstFrostIn })
                           : m.verdict === 'heat'  ? t('Heat in {h} h', { h: m.firstHeatIn })
                           : m.verdict === 'marginal' ? t('Marginal night') : t('Clear 72 h');
      case 'traffic': return m.call === 'blocked' ? t('{n} segment blocked', { n: m.blocked })
                           : m.call === 'degrading' ? t('Degrading') : t('Passable');
      case 'gdd':     return t('{n} GDD/day', { n: fmt(m.rate, 1) });
      default:        return '—';
    }
  }

  /** The subtitle under a collapsed row: the number the verdict rests on. */
  function deckSub(id, m){
    if(!m) return '';
    switch(id){
      case 'water':   return t('{pct}% depleted', { pct: fmt(m.taw > 0 ? m.depletion / m.taw * 100 : 0, 0) });
      case 'spray':   return t('wind {wind} km/h', { wind: fmt(m.blocks[0] ? m.blocks[0].wind : 0, 0) });
      case 'thermal': return t('low {temp} °C', { temp: fmt(m.minC, 1) });
      case 'traffic': return t('{pct}% mean', { pct: fmt(m.traff, 0) });
      case 'gdd':     return m.daysAtRate ? t('~{n} days to maturity', { n: m.daysAtRate }) : t(m.crop);
      default:        return '';
    }
  }

  /** Advisories no card claims, so nothing armed is ever off screen. */
  function orphanAlerts(){
    const claimed = new Set();
    Object.keys(Triage.CLAIMS).forEach(k => Triage.CLAIMS[k].forEach(r => claimed.add(r)));
    return [...State.data.alerts.values()].filter(a => !claimed.has(a.id));
  }

  function deckItems(){
    const models = deckModels();
    if(!models) return null;
    const alerts = State.data.alerts;
    const items = Object.keys(DECK_NAME)
      .filter(id => models[id])
      .map(id => ({
        id,
        model:    models[id],
        tone:     Triage.toneOf(id, models[id], alerts),
        deadline: Triage.deadlineOf(id, models[id])
      }));

    orphanAlerts().forEach(a => items.push({
      id: 'alert:' + a.id, alert: a, model: a,
      tone: a.severity === 'warning' ? 'warn' : 'act', deadline: 0
    }));

    return Triage.order(items);
  }

  function deckRow(item){
    const tone = Triage.groupOf(item.tone);
    const name = item.alert ? t(item.alert.label) : t(DECK_NAME[item.id]);
    const verdict = item.alert ? t(SEV[item.alert.severity].word) : deckVerdict(item.id, item.model);
    const sub = item.alert ? clockStr(item.alert.since) + ' UTC' : deckSub(item.id, item.model);
    const colour = tone === 'act' ? 'var(--warning-ink)' : tone === 'warn' ? 'var(--serious-ink)' : 'var(--good-ink)';
    return `<button type="button" class="deck-row" data-call="${esc(item.id)}"
              aria-expanded="false" aria-label="${esc(name + ' — ' + verdict)}">
      <span class="dot" style="background:${TONE_COLOUR[tone]}"></span>
      <span class="txt"><span class="name">${esc(name)}</span><span class="sub">${esc(sub)}</span></span>
      <span class="verdict" style="color:${colour}">${esc(verdict)}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>`;
  }

  /** The one card that stays open: whatever sorts first in "Needs you". */
  function deckCard(item){
    const tone = Triage.groupOf(item.tone);
    const name = item.alert ? t(item.alert.label) : t(DECK_NAME[item.id]);
    const verdict = item.alert ? t(SEV[item.alert.severity].word) : deckVerdict(item.id, item.model);
    const why = item.alert ? t(item.alert.detailKey, item.alert.vars) : deckWhy(item.id, item.model);
    return `<button type="button" class="deck-card ${tone}" data-call="${esc(item.id)}"
              style="display:block;width:100%;text-align:left;font-family:inherit;color:inherit;cursor:pointer"
              aria-label="${esc(name + ' — ' + verdict)}">
      <span class="head"><span class="name">${esc(name)}</span>${chipHtml(
        tone === 'act' ? 'warning' : tone === 'warn' ? 'serious' : 'good',
        t(GROUP_LABEL[tone]))}</span>
      <span class="deck-call ${tone}" style="display:block">${esc(verdict)}</span>
      <span class="deck-why" style="display:block">${esc(why)}</span>
      ${deckChart(item.id, item.model)}
    </button>`;
  }

  function deckWhy(id, m){
    if(!m) return '';
    switch(id){
      case 'water':   return m.why;
      case 'spray':   return t('Wind, gusts, humidity and rain probability over the next 48 hours.');
      case 'thermal': return t('{total} hours at or below freezing in the next 72.', { total: m.frostHours });
      case 'traffic': return t('Derived from soil water, recent rain and river discharge.');
      case 'gdd':     return t('{total} growing-degree days accumulated over the last {days} days above a {base}°C base.',
                          { total: fmt(m.total, 0), days: m.windowDays, base: m.baseTempC });
      default:        return '';
    }
  }

  function renderDeck(){
    const host = el('farmerDeck');
    if(!host) return;
    const items = deckItems();
    if(!items || !items.length){
      host.innerHTML = `<div class="deck-empty">${esc(t(
        'The deck needs a real location. Search for one above — these calls are computed from live forecast data and are not simulated.'))}</div>`;
      return;
    }

    const counts = Triage.counts(items);
    let html = '', shown = null, group = null;

    items.forEach(item => {
      const g = Triage.groupOf(item.tone);
      if(g !== group){
        group = g;
        html += `<div class="deck-group ${g}"><b>${esc(t(GROUP_LABEL[g]))}</b>
          <span class="count">${counts[g]}</span><span class="rule"></span></div>`;
      }
      /* The first "Needs you" call stays open. Everything else is a row, which
         is the whole point of grouping: a quiet day should look quiet. */
      if(g === 'act' && shown === null){ shown = item.id; html += deckCard(item); }
      else html += deckRow(item);
    });

    host.innerHTML = html;
  }
```

- [ ] **Step 4: Add the chart helper**

Immediately after `renderDeck`, add:

```js
  /* The evidence for the open card, inline. Kept to one shape per call so a
     reader learns each chart once. */
  function deckChart(id, m){
    if(!m) return '';
    if(id === 'water'){
      const pct = m.taw > 0 ? Math.min(100, m.depletion / m.taw * 100) : 0;
      const mark = m.taw > 0 ? Math.min(100, m.trigger / m.taw * 100) : 0;
      return `<span class="wbar ${m.call === 'irrigate' ? 'act' : m.call === 'monitor' ? 'warn' : 'ok'}"
                style="display:block;margin-top:9px" role="img"
                aria-label="${esc(t('Soil water depletion {pct} percent of available water; refill point at {mark} percent',
                  { pct: fmt(Math.round(pct)), mark: fmt(Math.round(mark)) }))}">
        <i style="width:${pct.toFixed(1)}%"></i><span class="wbar-mark" style="left:${mark.toFixed(1)}%"></span></span>`;
    }
    if(id === 'spray'){
      const cells = m.blocks.map(b => `<i class="${b.rating}"></i>`).join('');
      return `<span class="strip" style="display:flex;margin-top:9px" role="img"
                aria-label="${esc(t('Spray suitability for the next 48 hours, hour by hour.'))}">${cells}</span>
        <span class="strip-axis" style="display:flex"><span>${esc(t('now'))}</span><span>+24 h</span><span>+48 h</span></span>`;
    }
    if(id === 'thermal'){
      const cells = m.hours.map(p => {
        const cls = p.t <= CFG.THRESH.frostArm ? 'frost'
                  : p.t >= CFG.THRESH.heatArm  ? 'heat'
                  : p.t <= CFG.THRESH.frostClear ? 'marginal' : 'mild';
        return `<i class="${cls}"></i>`;
      }).join('');
      return `<span class="strip" style="display:flex;margin-top:9px" role="img"
                aria-label="${esc(t('Hourly air temperature for 72 hours. Minimum {min} degrees, maximum {max} degrees, {frost} hours at or below freezing.',
                  { min: fmt(m.minC,1), max: fmt(m.maxC,1), frost: fmt(m.frostHours) }))}">${cells}</span>
        <span class="strip-axis" style="display:flex"><span>${esc(t('now'))}</span><span>+36 h</span><span>+72 h</span></span>`;
    }
    return '';
  }
```

- [ ] **Step 5: Export the new functions**

In the `Views` `return {` block (line 4295), add `renderDeck, detailFor, openDetail` to the exported list. `detailFor` and `openDetail` arrive in Task 6 — add a stub now so the export does not throw:

```js
  function detailFor(){ return ''; }
  function openDetail(){}
```

Place the stubs immediately before the `return {`.

- [ ] **Step 6: Call it on every paint**

In `renderRolePanes()`, add `renderDeck();` as the first statement.

Run: `grep -n "function renderRolePanes" index.html` to locate it.

- [ ] **Step 7: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 674 checks, 674 passed, 0 failed

- [ ] **Step 8: Commit**

```bash
git add index.html tests/controls.test.js
git commit -m "The day, ranked, with only the part that needs you left open"
```

---

### Task 6: The detail sheet

One renderer feeds the phone sheet and, in Task 7, the desktop pane.

**Files:**
- Modify: `index.html` — markup (after `#simSheet`), `<style>`, `Views`
- Modify: `tests/controls.test.js`, `tests/assets.test.js` (Android back button ids)

- [ ] **Step 1: Write the failing test**

Append to `tests/controls.test.js`:

```js
  suite('controls · detail sheet', () => {
    const { app, document } = boot();
    const { Views } = app;

    test('the sheet shell exists', () =>
      assert.ok(document.getElementById('detailSheet'), 'no #detailSheet in the markup'));

    test('every card renders a detail body', () => {
      ['water', 'spray', 'thermal', 'traffic', 'gdd'].forEach(id => {
        const html = Views.detailFor(id);
        assert.ok(typeof html === 'string', `${id} returned no string`);
      });
    });

    test('a detail body states where the number came from', () => {
      Views.openDetail('water');
      const html = document.getElementById('detailBody').innerHTML;
      assert.includes(html, 'prov-block',
        'a detail screen without provenance breaks the app\'s central claim');
    });

    test('opening a detail unhides the sheet', () => {
      Views.openDetail('water');
      assert.notOk(document.getElementById('detailSheet').hidden);
    });

    test('closing it hides the sheet again', () => {
      Views.openDetail('water');
      Views.openDetail(null);
      assert.ok(document.getElementById('detailSheet').hidden);
    });

    test('an unknown card closes rather than rendering nothing', () => {
      Views.openDetail('nonsense');
      assert.ok(document.getElementById('detailSheet').hidden);
    });
  });
```

And to `tests/assets.test.js`, extend the existing Android back button suite with:

```js
    test('the back button knows about the detail sheet', () => {
      const java = fs.readFileSync(
        path.join(ROOT, 'android/app/src/main/java/earth/aura/agrinet/MainActivity.java'), 'utf8');
      assert.includes(java, 'detailSheet',
        'Back would quit the app with a detail sheet open');
    });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node tests/run.js controls -v`
Expected: FAIL — `no #detailSheet in the markup`

- [ ] **Step 3: Add the sheet shell**

In `index.html`, immediately after the closing `</div>` of `#simSheet` (line 1286), add:

```html
<!-- ══════════════════════ DETAIL SHEET ══════════════════════
     One call, at full depth: the verdict, the chart that justifies it, the
     inputs and where every number came from. The body is rendered by
     Views.detailFor, which also fills the desktop pane -- the same markup in
     both places, so a change cannot fix one and miss the other. -->
<div id="detailSheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="detailTitle" hidden>
  <div class="sheet-panel">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="flex items-center gap-2 mb-3">
      <span id="detailTitle" class="panel-title"></span>
      <div class="flex-1"></div>
      <button id="detailClose" class="toggle" aria-label="Close" data-i18n-attr="aria-label" data-i18n>Close</button>
    </div>
    <div id="detailBody"></div>
  </div>
</div>
```

- [ ] **Step 4: Add the detail stylesheet**

After the deck rules added in Task 4, add:

```css
/* ==========================================================================
   DETAIL

   The body of a call: verdict, evidence, inputs, provenance. Used by the phone
   sheet and by the desktop pane without a second rule, which is the point --
   one renderer, one stylesheet, two hosts.
   ========================================================================== */
.detail{ display:flex; flex-direction:column; gap:12px; }
.detail-call{ font-size:27px; font-weight:700; letter-spacing:-.03em; line-height:1.05; }
.detail-call.act { color:var(--warning-ink); }
.detail-call.warn{ color:var(--serious-ink); }
.detail-call.ok  { color:var(--good-ink); }
.detail-why{ font-size:12.5px; line-height:1.5; color:var(--text-secondary); margin-top:5px; }
.detail-sect{ display:flex; flex-direction:column; gap:5px; }
.detail-sect > .label{
  font-size:9px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--text-muted); font-weight:700;
}

/* Where this came from. The app's central claim, given a fixed place on every
   detail screen rather than a grey line under a tile. */
.prov-block{
  background:var(--series1-wash); border:1px solid var(--info-line);
  border-radius:12px; padding:10px 12px;
}
.prov-block .label{
  font-size:9px; letter-spacing:.13em; text-transform:uppercase;
  color:var(--info-ink); font-weight:750; margin-bottom:5px;
}
.prov-block p{ font-size:11px; line-height:1.55; color:var(--text-secondary); margin:0 0 5px; }
.prov-block p:last-of-type{ margin-bottom:0; }
.prov-tags{ display:flex; gap:5px; flex-wrap:wrap; margin-top:7px; }
.prov-tag{
  font-size:8.5px; letter-spacing:.08em; text-transform:uppercase; font-weight:700;
  padding:3px 7px; border-radius:99px;
  background:var(--surface-1); border:1px solid var(--info-line); color:var(--info-ink);
}
.prov-tag.warn{ border-color:var(--serious-line); color:var(--serious-ink); }
```

- [ ] **Step 5: Write the detail renderer**

Replace the two stubs added in Task 5 with:

```js
  /* ---------- detail ----------

     Every detail body has the same skeleton -- verdict, evidence, inputs,
     provenance -- and a middle that changes completely with the subject. The
     skeleton is here; the middle is a per-call function. */

  function provBlock(paras, tags){
    return `<div class="prov-block">
      <div class="label">${esc(t('Where this came from'))}</div>
      ${paras.map(p => `<p>${p}</p>`).join('')}
      <div class="prov-tags">${tags.map(g =>
        `<span class="prov-tag${g.warn ? ' warn' : ''}">${esc(g.text)}</span>`).join('')}</div>
    </div>`;
  }

  function rowsBlock(pairs){
    return `<dl class="agro-rows">${pairs.map(([k, v]) =>
      `<div class="agro-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
  }

  const DETAIL = {
    water(m){
      return `<div class="detail-call ok">${esc(deckVerdict('water', m))}</div>
        <div class="detail-why">${esc(m.why)}</div>
        <div class="detail-sect"><span class="label">${esc(t('Depletion against the refill point'))}</span>
          ${deckChart('water', m)}</div>
        ${rowsBlock([
          [t('Depletion'), `${fmt(m.depletion,0)} / ${fmt(m.taw,0)} mm`],
          [t('Rain, 7 d'), m.rain7 === null ? '—' : fmt(m.rain7,1) + ' mm'],
          [t('ET₀, 7 d'),  m.et7  === null ? '—' : fmt(m.et7,1)  + ' mm'],
          [t('Balance'),   m.balance7 === null ? '—' : (m.balance7 > 0 ? '+' : '') + fmt(m.balance7,1) + ' mm'],
          [t('Rain, next 48 h'), m.rain48 === null ? '—' : fmt(m.rain48,1) + ' mm']
        ])}
        ${provBlock(
          [esc(t('Derived · FAO-56 over a {mm} mm root zone, assumed mid-texture soil', { mm: Agronomy.ROOT_DEPTH_MM })),
           esc(t('Its inputs are modelled, not measured: soil moisture and ET₀ from ECMWF IFS / DWD ICON at roughly 11 km. One model cell covers this whole holding.'))],
          [{ text: t('Derived') }, { text: t('Modelled input') }, { text: '~11 km' }])}`;
    },
    spray(m){
      return `<div class="detail-call ${!m.nextWindow ? 'act' : m.nextWindow.start === 0 ? 'ok' : 'warn'}">${esc(deckVerdict('spray', m))}</div>
        <div class="detail-why">${esc(t('Wind, gusts, humidity and rain probability over the next 48 hours.'))}</div>
        <div class="detail-sect"><span class="label">${esc(t('Hour by hour'))}</span>${deckChart('spray', m)}</div>
        ${rowsBlock([
          [t('Good hours'), `${m.blocks.filter(b => b.rating === 'good').length} / 48`],
          [t('Wind limit'), `${Agronomy.SPRAY.windMax} km/h`],
          [t('Humidity floor'), `${Agronomy.SPRAY.rhMin}%`]
        ])}
        ${provBlock(
          [esc(t('Conventional limits, not a regulation · wind, gusts, humidity and rain probability'))],
          [{ text: t('Derived') }, { text: t('Our thresholds') }])}`;
    },
    thermal(m){
      return `<div class="detail-call ${m.verdict === 'frost' ? 'act' : m.verdict === 'clear' ? 'ok' : 'warn'}">${esc(deckVerdict('thermal', m))}</div>
        <div class="detail-why">${esc(deckWhy('thermal', m))}</div>
        <div class="detail-sect"><span class="label">${esc(t('Next 72 hours'))}</span>${deckChart('thermal', m)}</div>
        ${rowsBlock([
          [t('Minimum'), `${fmt(m.minC,1)} °C`],
          [t('Maximum'), `${fmt(m.maxC,1)} °C`],
          [`Hours ≤ ${fmt(CFG.THRESH.frostArm,1)}°C`, String(m.frostHours)]
        ])}
        ${provBlock(
          [esc(t('2 m air temperature · ECMWF IFS / DWD ICON forecast'))],
          [{ text: t('Modelled') }, { text: '~11 km' }])}`;
    },
    traffic(m){
      return `<div class="detail-call ${m.call === 'blocked' ? 'act' : m.call === 'clear' ? 'ok' : 'warn'}">${esc(deckVerdict('traffic', m))}</div>
        <div class="detail-why">${esc(deckWhy('traffic', m))}</div>
        ${rowsBlock([
          [t('Mean'), `${fmt(m.traff,0)} %`],
          [t('Blocked segments'), String(m.blocked)],
          [t('Degraded segments'), String(m.degraded)]
        ])}
        ${provBlock(
          [esc(t('Derived — ours. Soil water, 24 and 72 hour rain, and river percentile. This index is our formula, not a published product.')),
           esc(t('River discharge is Copernicus GloFAS via Open-Meteo, modelled at roughly 5 km. Farm tracks are synthesised from the coordinates — no open dataset publishes plot roads.'))],
          [{ text: t('Derived · ours') }, { text: '~5 km' }, { text: t('Synthesised layout'), warn: true }])}`;
    },
    gdd(m){
      return `<div class="detail-call ok">${esc(deckVerdict('gdd', m))}</div>
        <div class="detail-why">${esc(deckWhy('gdd', m))}</div>
        ${rowsBlock([
          [t('To maturity'), m.toMaturity ? fmt(m.toMaturity,0) + ' GDD' : '—'],
          [t('At this rate'), m.daysAtRate ? '~' + m.daysAtRate + ' ' + t('days') : '—']
        ])}
        ${provBlock(
          [esc(t('Assumes a textbook accumulation for the crop; cultivar varies'))],
          [{ text: t('Derived') }])}`;
    }
  };

  /** The detail body for one call, or '' if nothing can be said about it. */
  function detailFor(id){
    if(!id) return '';
    if(id.indexOf('alert:') === 0){
      const a = State.data.alerts.get(id.slice(6));
      if(!a) return '';
      return `<div class="detail"><div class="detail-call ${a.severity === 'warning' ? 'warn' : 'act'}">${esc(t(a.label))}</div>
        <div class="detail-why">${esc(t(a.detailKey, a.vars))}</div></div>`;
    }
    const models = deckModels();
    const m = models && models[id];
    if(!m || !DETAIL[id]) return '';
    return `<div class="detail">${DETAIL[id](m)}</div>`;
  }

  /** Open the sheet on a call, or pass a falsy id to close it. */
  function openDetail(id){
    const sheet = el('detailSheet'), body = el('detailBody'), title = el('detailTitle');
    if(!sheet || !body) return;
    const html = detailFor(id);
    if(!html){ sheet.hidden = true; State.data.openCall = null; return; }
    const name = id.indexOf('alert:') === 0
      ? t((State.data.alerts.get(id.slice(6)) || {}).label || '')
      : t(DECK_NAME[id] || '');
    if(title) title.textContent = name;
    body.innerHTML = html;
    sheet.hidden = false;
    State.data.openCall = id;
  }
```

- [ ] **Step 6: Wire the events**

In the bootstrap module, beside the `simSheet` listener at line 6321, add:

```js
  /* Deck rows open the sheet. Delegated, because the deck is re-rendered on
     every downlink and a bound listener would die with the node that held it. */
  document.addEventListener('click', e => {
    const row = e.target.closest && e.target.closest('[data-call]');
    if(row) Views.openDetail(row.dataset.call);
  });
  el('detailClose').addEventListener('click', () => Views.openDetail(null));
  el('detailSheet').addEventListener('click', e => {
    if(e.target.id === 'detailSheet') Views.openDetail(null);
  });
```

- [ ] **Step 7: Teach the Android back button**

`android/app/src/main/java/earth/aura/agrinet/MainActivity.java:57` — change:

```java
            "(function(){var ids=['manualLayer','simSheet'];"
```

to:

```java
            "(function(){var ids=['manualLayer','simSheet','detailSheet'];"
```

- [ ] **Step 8: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 681 checks, 681 passed, 0 failed

- [ ] **Step 9: Commit**

```bash
git add index.html android tests/
git commit -m "A call at full depth, and a fixed place for where it came from"
```

---

### Task 7: Desktop rail and pane

**Files:**
- Modify: `index.html` `<style>` — a `@media (min-width:1024px)` block
- Modify: `index.html` markup — `#opsColumn` gains a deck rail and a detail pane
- Modify: `Views.openDetail`

- [ ] **Step 1: Add the desktop markup**

`index.html:1048` — replace the opening of `#opsColumn`:

```html
  <section id="opsColumn" class="lg:col-span-7 xl:col-span-8 flex flex-col gap-4">
```

with:

```html
  <!-- ─────────── DESKTOP: DECK RAIL + DETAIL PANE ───────────
       Above 1024px the deck becomes a rail and the sheet's body becomes the
       pane beside it. Same renderer, same markup, different host: nothing waits
       behind a tap on a screen with room to spare. -->
  <section id="deckRail" class="hidden lg:block lg:col-span-3 xl:col-span-3">
    <div class="panel" style="padding:10px 11px">
      <div id="railDeck" class="deck" role="list"></div>
    </div>
  </section>

  <section id="detailPane" class="hidden lg:block lg:col-span-4 xl:col-span-5">
    <div class="panel" style="padding:14px 16px">
      <div id="paneTitle" class="panel-title" style="display:block;margin-bottom:9px"></div>
      <div id="paneBody"></div>
    </div>
  </section>

  <section id="opsColumn" class="lg:col-span-7 xl:col-span-8 flex flex-col gap-4">
```

- [ ] **Step 2: Show the rail only in the right roles**

Add to the `<style>` block:

```css
/* The rail and the pane belong to the decision roles. Ops is the console and
   uses the full width it already had; Driver's pane is the map, which Task 8
   moves in. */
@media (min-width:1024px){
  body[data-role="OPS"] #deckRail,
  body[data-role="OPS"] #detailPane{ display:none !important; }
  body:not([data-role="OPS"]) #opsColumn{ display:none; }
  body:not([data-role="OPS"]) #chatColumn{ grid-column: span 5 / span 5; }
}
```

- [ ] **Step 3: Render into both hosts**

In `renderDeck()`, replace the single host lookup with a loop:

```js
  function renderDeck(){
    const hosts = [el('farmerDeck'), el('railDeck')].filter(Boolean);
    if(!hosts.length) return;
    const items = deckItems();
    if(!items || !items.length){
      const empty = `<div class="deck-empty">${esc(t(
        'The deck needs a real location. Search for one above — these calls are computed from live forecast data and are not simulated.'))}</div>`;
      hosts.forEach(h => { h.innerHTML = empty; });
      return;
    }

    const counts = Triage.counts(items);
    let html = '', shown = null, group = null;

    items.forEach(item => {
      const g = Triage.groupOf(item.tone);
      if(g !== group){
        group = g;
        html += `<div class="deck-group ${g}"><b>${esc(t(GROUP_LABEL[g]))}</b>
          <span class="count">${counts[g]}</span><span class="rule"></span></div>`;
      }
      if(g === 'act' && shown === null){ shown = item.id; html += deckCard(item); }
      else html += deckRow(item);
    });

    hosts.forEach(h => { h.innerHTML = html; });

    /* The pane always shows something: the call the user picked, or the first
       one that needs them. An empty pane beside a full rail reads as broken. */
    if(el('paneBody')) openDetail(State.data.openCall || items[0].id);
  }
```

- [ ] **Step 4: Fill the pane as well as the sheet**

In `openDetail`, after the sheet is filled, add:

```js
    const paneBody = el('paneBody'), paneTitle = el('paneTitle');
    if(paneBody){
      paneBody.innerHTML = html || '';
      if(paneTitle) paneTitle.textContent = name || '';
    }
```

And guard the sheet so a desktop click does not raise it — replace `sheet.hidden = false;` with:

```js
    /* Below 1024px the sheet is the detail. Above it the pane already shows the
       same body, so raising a sheet over it would be a second copy of what the
       reader is looking at. */
    sheet.hidden = window.matchMedia('(min-width:1024px)').matches;
```

- [ ] **Step 5: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 681 checks, 681 passed, 0 failed

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "The width buys the reader something"
```

---

### Task 8: Ops absorbs the console

**Files:**
- Modify: `index.html` — header, `#opsColumn`, `.rolepane` CSS

- [ ] **Step 1: Move the clock and the downlink chips into Ops**

Cut the mission clock block (`index.html:995-999`) and `#linkChips` (`index.html:1036`) out of the header, and paste them into a new panel at the top of `#opsColumn`:

```html
    <!-- The console, kept rather than deleted. A grower never meets it; anyone
         who wants a mission clock and a downlink table finds it here. -->
    <div class="panel">
      <div class="panel-head">
        <span class="panel-title" data-i18n>Downlink</span>
        <div class="flex-1"></div>
        <span class="text-[9px] tracking-[.12em] uppercase" style="color:var(--text-muted)" data-i18n>Mission Clock</span>
        <span id="missionClock" class="mono tnum text-[13px] font-semibold">--:--:--</span>
        <span class="text-[9px]" style="color:var(--text-muted)">UTC</span>
      </div>
      <div class="p-3">
        <div id="linkChips" class="flex items-center gap-2 flex-wrap" role="status" aria-live="polite"
             aria-label="Satellite downlink status" data-i18n-attr="aria-label"></div>
      </div>
    </div>
```

- [ ] **Step 2: Show the Ops column in the Ops role on mobile too**

In the `@media (max-width:1023px)` block, the rule `body:not([data-role="OPS"]) #opsColumn{ display:none; }` already does this. Verify it still reads that way after the edits.

- [ ] **Step 3: Run the suite**

Run: `node tests/run.js`
Expected: PASS — 681 checks. The control-reachability suite scans for `el('missionClock')` and `el('linkChips')` and finds them in their new home; no test edit is needed.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "The console keeps its home, and stops being everyone's front door"
```

---

### Task 9: Catalogues

**Files:**
- Modify: `i18n/es.json`, `i18n/fr.json`, `i18n/pt.json`

- [ ] **Step 1: List every new key**

Run:

```bash
node -e "
const fs=require('fs');
const html=fs.readFileSync('index.html','utf8');
const keys=new Set();
for(const m of html.matchAll(/\bt\(\s*'((?:[^'\\\\]|\\\\.)*)'/g)) keys.add(m[1].replace(/\\\\'/g,\"'\"));
for(const m of html.matchAll(/data-i18n>([^<]+)</g)) keys.add(m[1].trim());
const es=JSON.parse(fs.readFileSync('i18n/es.json','utf8')).strings;
const missing=[...keys].filter(k=>k&&!(k in es)).sort();
console.log(missing.length+' new keys');
missing.forEach(k=>console.log(JSON.stringify(k)));
"
```

- [ ] **Step 2: Translate each key into the three catalogues**

Add every key from Step 1 to the `strings` object of `i18n/es.json`, `i18n/fr.json` and `i18n/pt.json`, keeping the files sorted by key. Placeholders in `{braces}` must appear unchanged in the translation — a test enforces this.

Leave `meta.reviewed` at `false`. These remain machine translations.

- [ ] **Step 3: Run the i18n suite**

Run: `node tests/run.js i18n -v`
Expected: PASS — every catalogue covers every key, every placeholder survives, and the DOM walk in each language reports zero English survivors.

- [ ] **Step 4: Commit**

```bash
git add i18n/
git commit -m "The deck speaks four languages, like everything else here"
```

---

### Task 10: Cache version and the browser pass

**Files:**
- Modify: `sw.js:9`

- [ ] **Step 1: Bump the cache version**

`sw.js:9` — change `const CACHE_VERSION = 'aura-v13';` to `'aura-v14'`.

- [ ] **Step 2: Run the whole suite**

Run: `node tests/run.js`
Expected: PASS — 681 checks, 681 passed, 0 failed

- [ ] **Step 3: Look at it in a browser**

The suite drives a stub DOM. Layout, the service worker and anything needing a rendering engine fall outside it — which is how `gap-5` shipped inert and how a driver's map was destroyed by its own pane's re-render.

Run `serve.cmd`, open `http://localhost:8080`, and check:

- the header clears the status bar and the tab bar clears the gesture bar, in portrait;
- the deck at 360, 414, 768, 1024, 1280 and 1440 px;
- all four languages, where Portuguese labels are longest and break first;
- a field in trouble, so *Needs you* has something in it — fire `FROST_EVENT` from the simulation sheet;
- the detail sheet opens, dismisses by scrim and by Close, and does not raise itself over the desktop pane.

- [ ] **Step 4: Commit**

```bash
git add sw.js
git commit -m "Bump the shell, or testers review yesterday"
```

---

## Self-review

**Spec coverage.** Triage rules → Task 2. Trafficability as the fifth card → Task 3. Deck → Tasks 4–5. Detail sheet and provenance block → Task 6. Desktop rail and pane → Task 7. Ops absorbs the console → Task 8. Safe areas → Task 1. Charts → Task 5 (`deckChart`) and Task 6 (`DETAIL`). i18n → Task 9. Tests → every task. `CACHE_VERSION` → Task 10.

**Two spec items are deliberately deferred**, and the spec's staging note should be read as covering them: Buyer and Driver decks (stage 5) keep their existing renderers here, because the Farmer deck has to prove the pattern before it is copied twice, and the Driver map-as-pane needs the pane from Task 7 to exist first. Both are follow-on work, not part of this plan.

**Type consistency.** `Triage.toneOf(id, model, alerts)`, `Triage.deadlineOf(id, model)`, `Triage.order(items)`, `Triage.counts(items)`, `Triage.groupOf(tone)` are used exactly as defined. `Dispatch.trafficModel()` returns `{ traff, blocked, degraded, call }`, which is what `Triage.baseTone('traffic', …)` reads. `Views.detailFor(id)` returns a string and `Views.openDetail(id)` accepts the same ids the deck emits in `data-call`.
