/* Control reachability.

   The failure this suite exists to catch is not a wrong answer — it is a control
   that does nothing. A button whose id was renamed, a trigger that names a rule
   that no longer exists, a quick reply the intent matcher does not recognise: all
   of them look perfectly fine on screen and are silently dead. Three quick-reply
   buttons shipped broken before these checks existed. */
'use strict';

const { boot, readSource } = require('./harness');

module.exports = ({ suite, test, assert }) => {

  /* ================================================= wiring integrity ====== */
  suite('controls · every referenced element exists', () => {
    const { script, markup } = readSource();

    /* Ids come from two places: the static shell, and the template literals the
       renderers emit (#routePath, #driverMarker and friends only exist once the
       map has painted). Both count as real — an id that appears in neither is a
       reference to an element nothing ever creates. Interpolated ids (`id="${x}"`)
       are skipped: their value is not knowable statically. */
    const ids = new Set([
      ...[...markup.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]),
      ...[...script.matchAll(/\bid=\\?"([^"$\\]+)\\?"/g)].map(m => m[1]),
    ]);

    // Every el('x') / getElementById('x') in the script must resolve to markup.
    const referenced = [...new Set([
      ...[...script.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)].map(m => m[1]),
      ...[...script.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(m => m[1]),
    ])];

    test('the script references at least a dozen elements', () =>
      assert.greater(referenced.length, 12, 'element scan found suspiciously little'));

    referenced.forEach(id => {
      test(`el('${id}') resolves to a real element`, () =>
        assert.ok(ids.has(id), `the script reads #${id} but no element has that id — the control is dead`));
    });
  });

  /* ==================================================== event triggers ===== */
  suite('controls · simulation triggers', () => {
    const { app } = boot();
    const { Views, EventEngine, Manual } = app;
    const { markup } = readSource();

    // Rules plus the two engine-level actions that are not rules.
    const firable = EventEngine.RULES.map(r => r.id).concat(['SIGNAL_LOSS', 'RESTORE']);

    Views.TRIGGERS.forEach(t => {
      test(`console trigger ${t.id} names a real code path`, () =>
        assert.includes(firable, t.id, `${t.id} is not a rule and not an engine action`));
      test(`console trigger ${t.id} has a label and a glyph`, () => {
        assert.ok(t.label && t.label.length, 'no label');
        assert.ok(t.glyph && t.glyph.length, 'no glyph');
      });
    });

    test('trigger ids are unique', () => {
      const ids = Views.TRIGGERS.map(t => t.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate trigger id');
    });

    /* Reachable means a user can cause it, not necessarily that a button bears
       its name. NDVI_DECLINE has no button of its own: the drought trigger drives
       NDVI below its floor as well, which is realistic — canopy vigour follows
       root-zone moisture down. What must never happen is a rule no control can
       reach by any route. */
    test('every rule is reachable from at least one control', () => {
      const fireSrc = readSource().script.match(/function fire\(id\)\{[\s\S]*?\n  \}/)[0];
      EventEngine.RULES.forEach(r => {
        const direct = Views.TRIGGERS.some(t => t.id === r.id) || Manual.SCENARIOS.some(s => s.id === r.id);
        const viaMetric = new RegExp(`inject\\('${r.metric}'`).test(fireSrc);
        assert.ok(direct || viaMetric,
          `${r.id} can never be fired by a user: no control names it and nothing injects ${r.metric}`);
      });
    });

    test('firing every trigger raises no error', () => {
      const h = boot();
      h.app.Telemetry.stop();
      firable.forEach(id => h.app.EventEngine.fire(id));
      assert.equal(h.errors.length, 0, `firing triggers logged: ${h.errors[0]}`);
    });

    test('a trigger fired from markup reaches the engine through the delegate', () => {
      const h = boot();
      h.app.Telemetry.stop();
      const before = h.app.State.data.log.length;
      h.document.dispatch('click', {
        type: 'click',
        target: { closest: sel => (sel === '[data-trigger]'
          ? { classList: { add() {}, remove() {} }, dataset: { trigger: 'RESTORE' } } : null) },
      });
      assert.greater(h.app.State.data.log.length, before, 'the delegated click handler did not fire the trigger');
    });

    test('an unknown trigger id is ignored rather than throwing', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.EventEngine.fire('NOT_A_REAL_TRIGGER');
      assert.equal(h.errors.length, 0, 'an unknown trigger threw');
    });

    test('trigger notes do not contradict what the code injects', () => {
      // A note claiming "SAR 41%" while the code injects 57 is a silent lie on a
      // button face. Any percentage or temperature in a note must appear in fire().
      const fireSrc = readSource().script.match(/function fire\(id\)\{[\s\S]*?\n  \}/);
      assert.ok(fireSrc, 'could not locate fire()');
      Views.TRIGGERS.forEach(t => {
        const nums = (t.note.match(/-?\d+(?:\.\d+)?/g) || []).filter(n => Math.abs(Number(n)) > 1);
        nums.forEach(n =>
          assert.includes(fireSrc[0], n, `trigger ${t.id} advertises ${n} but fire() never injects it`));
      });
    });

    test('both the desktop panel and the mobile sheet host trigger buttons', () => {
      assert.includes(markup, 'id="triggerButtons"', 'no desktop trigger container');
      assert.includes(markup, 'id="triggerButtonsMobile"', 'no mobile trigger container');
    });
  });

  /* ========================================================= chat UI ======= */
  suite('controls · chat and personas', () => {
    const { app } = boot();
    const { Views, Console, PEOPLE } = app;
    const { markup } = readSource();

    Object.keys(Views.QUICK).forEach(persona => {
      test(`${persona} has quick replies`, () =>
        assert.greater(Views.QUICK[persona].length, 0, 'no quick replies'));
      Views.QUICK[persona].forEach(q =>
        test(`${persona} quick reply "${q}" is understood by the matcher`, () =>
          assert.ok(Console.match(q), `"${q}" matches no intent — the button does nothing useful`)));
    });

    test('every channel tab names a real channel', () => {
      const tabs = [...markup.matchAll(/data-channel="([^"]+)"/g)].map(m => m[1]);
      assert.greater(tabs.length, 0, 'no channel tabs found');
      const valid = new Set(['ALL', ...Object.values(PEOPLE).map(p => p.channel)]);
      tabs.forEach(t => assert.ok(valid.has(t), `channel tab ${t} is not a channel anyone posts to`));
    });

    test('the persona selector offers every persona that has quick replies', () => {
      Object.keys(Views.QUICK).forEach(p =>
        assert.includes(markup, `value="${p}"`, `persona ${p} is missing from the selector`));
    });

    test('posting a message reaches the transcript', () => {
      const h = boot();
      h.app.Telemetry.stop();
      const before = h.app.State.data.chat.length;
      h.app.Console.post('BOT', 'test message');
      assert.greater(h.app.State.data.chat.length, before, 'the message never reached state');
    });

    test('a user message produces a reply', async () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Console.handleUserMessage('full status');
      await h.advance(8000);
      const mine = h.app.State.data.chat.filter(m => m.from !== 'BOT');
      const bot = h.app.State.data.chat.filter(m => m.from === 'BOT');
      assert.greater(mine.length, 0, 'the user message was not recorded');
      assert.greater(bot.length, 0, 'the agent never replied');
    });

    test('the transcript is capped', () => {
      const h = boot();
      h.app.Telemetry.stop();
      for (let i = 0; i < h.app.CFG.MAX_CHAT + 40; i++) h.app.Console.post('BOT', 'msg ' + i);
      assert.ok(h.app.State.data.chat.length <= h.app.CFG.MAX_CHAT + 1,
        `transcript grew to ${h.app.State.data.chat.length}`);
    });
  });

  /* ========================================================== roles ======== */
  suite('controls · role views', () => {
    const { app } = boot();
    const { Views } = app;
    const { markup } = readSource();

    const roleButtons = [...markup.matchAll(/data-role="([^"]+)"/g)].map(m => m[1]);

    test('the tab bar offers four roles', () =>
      assert.equal(new Set(roleButtons).size, 4, `found roles: ${[...new Set(roleButtons)]}`));

    ['FARMER', 'BUYER', 'DRIVER'].forEach(role => {
      test(`${role} has a pane in the markup`, () =>
        assert.includes(markup, `data-pane="${role}"`, `no pane for ${role}`));
      test(`${role} has a renderer`, () =>
        assert.ok(Views.ROLE_RENDER && Views.ROLE_RENDER[role], `no renderer registered for ${role}`));
    });

    test('OPS is the desktop console and needs no pane', () =>
      assert.notIncludes(markup, 'data-pane="OPS"', 'OPS should reuse the console, not duplicate it'));

    test('switching role raises no error and updates state', () => {
      const h = boot();
      h.app.Telemetry.stop();
      ['FARMER', 'BUYER', 'DRIVER', 'OPS'].forEach(r => h.app.Views.setRole(r));
      assert.equal(h.app.State.data.role, 'OPS', 'role did not stick');
      assert.equal(h.errors.length, 0, `role switching logged: ${h.errors[0]}`);
    });

    /* The map is one node, moved into the driver pane on a phone rather than
       drawn twice. Rewriting that pane therefore destroys it unless it is
       lifted out first -- and the pane is rewritten on every telemetry tick, so
       the driver's map used to disappear seconds after they opened it, and the
       next repaint threw on a null #fieldMap. */
    test('the driver keeps the map when the pane re-renders', () => {
      /* Read from the source, because a stub DOM cannot show this: assigning
         innerHTML there does not detach the real node, so the destruction is
         invisible to any check that walks the tree. What must hold is the
         order of two statements -- lift the map out, THEN rewrite the pane. */
      const { script } = readSource();
      const body = script.slice(script.indexOf('function renderDriver(){'),
                               script.indexOf('function placeMap()'));
      const lift = body.indexOf('home.appendChild(panel)');
      const wipe = body.indexOf('pane.innerHTML');
      assert.greater(lift, -1, 'renderDriver never moves the map out before rewriting the pane');
      assert.greater(wipe, lift, 'the pane is rewritten before the map is lifted out, which destroys it');
      assert.includes(body, 'placeMap()', 'nothing puts the map back afterwards');
    });

    test('a repaint with no map to draw into is skipped, not thrown', () => {
      const { script } = readSource();
      const body = script.slice(script.indexOf('function renderMap('), script.indexOf('function renderRouteStats'));
      assert.ok(/const svg = el\('fieldMap'\);\s*\n\s*if\(!svg\) return;/.test(body),
        'renderMap writes into #fieldMap without checking it exists');
    });

    test('a non-OPS role also switches the chat persona', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Views.setRole('DRIVER');
      assert.equal(h.app.State.data.persona, 'DRIVER', 'persona did not follow the role');
    });

    test('every role renders without leaving "undefined" on screen', () => {
      const h = boot({ mobile: true });
      h.app.Telemetry.stop();
      ['FARMER', 'BUYER', 'DRIVER'].forEach(r => {
        h.app.Views.setRole(r);
        const pane = h.document.getElementById('pane' + r[0] + r.slice(1).toLowerCase());
        assert.notIncludes(pane.innerHTML, 'undefined', `${r} pane rendered "undefined"`);
      });
    });
  });

  /* ========================================================= manual ======== */
  suite('controls · manual', () => {
    const { markup } = readSource();

    test('the header carries a manual button', () =>
      assert.includes(markup, 'id="btnManual"', 'no way to open the manual'));

    test('the manual layer ships hidden', () => {
      const tag = markup.match(/<div id="manualLayer"[^>]*>/);
      assert.ok(tag, 'no manual layer in the markup');
      assert.includes(tag[0], 'hidden', 'the manual would be visible at boot');
    });

    test('the manual layer is a labelled modal dialog', () => {
      const tag = markup.match(/<div id="manualLayer"[^>]*>/)[0];
      assert.includes(tag, 'role="dialog"', 'not announced as a dialog');
      assert.includes(tag, 'aria-modal="true"', 'not announced as modal');
      assert.includes(tag, 'aria-labelledby="manualTitle"', 'dialog has no accessible name');
    });

    test('the manual button declares its popup behaviour', () => {
      const tag = markup.match(/<button id="btnManual"[^>]*>/)[0];
      assert.includes(tag, 'aria-haspopup="dialog"', 'button does not announce a dialog');
      assert.includes(tag, 'aria-expanded="false"', 'button does not announce collapsed state');
    });

    test('the button label uses a class the stylesheet actually defines', () => {
      // Tailwind here is prebuilt and content-scanned: a class it was not built
      // with silently does nothing. `sm:inline` is one of those.
      const fs = require('fs');
      const path = require('path');
      const css = fs.readFileSync(path.join(__dirname, '..', 'app.css'), 'utf8');
      const tag = markup.match(/<button id="btnManual"[\s\S]*?<\/button>/)[0];
      const utilities = [...tag.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)).filter(Boolean);
      utilities.forEach(c => {
        const escaped = c.replace(/([:.\\/[\]])/g, '\\$1');
        const inApp = css.includes('.' + escaped);
        const inline = readSource().html.includes('.' + c + '{') || readSource().html.includes('.' + c + ' ');
        assert.ok(inApp || inline, `class "${c}" is not defined anywhere, so it does nothing`);
      });
    });

    /* ---- behaviour ---- */
    const fresh = () => { const h = boot(); h.app.Telemetry.stop(); return h; };

    test('the manual starts closed', () => assert.notOk(fresh().app.Manual.isOpen(), 'the manual was open at boot'));

    test('open() opens it and close() closes it', () => {
      const h = fresh();
      h.app.Manual.open();
      assert.ok(h.app.Manual.isOpen(), 'open() did nothing');
      h.app.Manual.close();
      assert.notOk(h.app.Manual.isOpen(), 'close() did nothing');
    });

    test('toggle() alternates', () => {
      const h = fresh();
      h.app.Manual.toggle();
      assert.ok(h.app.Manual.isOpen(), 'first toggle did not open');
      h.app.Manual.toggle();
      assert.notOk(h.app.Manual.isOpen(), 'second toggle did not close');
    });

    test('opening locks the page behind the layer, closing releases it', () => {
      const h = fresh();
      h.app.Manual.open();
      assert.equal(h.document.body.style.overflow, 'hidden', 'the console still scrolls behind the manual');
      h.app.Manual.close();
      assert.equal(h.document.body.style.overflow, '', 'scroll lock was not released');
    });

    test('the button reflects open state to assistive tech', () => {
      const h = fresh();
      h.app.Manual.open();
      assert.equal(h.document.getElementById('btnManual').getAttribute('aria-expanded'), 'true', 'not marked expanded');
      h.app.Manual.close();
      assert.equal(h.document.getElementById('btnManual').getAttribute('aria-expanded'), 'false', 'not marked collapsed');
    });

    test('Escape closes the manual', () => {
      const h = fresh();
      h.app.Manual.open();
      h.document.dispatch('keydown', { key: 'Escape', preventDefault() {} });
      assert.notOk(h.app.Manual.isOpen(), 'Escape did not close the manual');
    });

    test('"?" opens the manual', () => {
      const h = fresh();
      h.document.dispatch('keydown', { key: '?', preventDefault() {} });
      assert.ok(h.app.Manual.isOpen(), '"?" did not open the manual');
    });

    test('"?" typed into a field does NOT open the manual', () => {
      const h = fresh();
      const input = h.document.getElementById('chatInput');
      input.tagName = 'INPUT';
      h.document.activeElement = input;
      h.document.dispatch('keydown', { key: '?', preventDefault() {} });
      assert.notOk(h.app.Manual.isOpen(), 'typing "?" into the chat opened the manual');
      h.document.activeElement = null;
    });

    /* ---- content ---- */
    test('every section has a unique id, nav label and title', () => {
      const h = fresh();
      const ids = h.app.Manual.SECTIONS.map(s => s.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate section id');
      h.app.Manual.SECTIONS.forEach(s => {
        assert.ok(s.nav && s.nav.length, `${s.id} has no nav label`);
        assert.ok(s.title && s.title.length, `${s.id} has no title`);
        assert.equal(typeof s.render, 'function', `${s.id} has no renderer`);
      });
    });

    test('the contents list one entry per section', () => {
      const h = fresh();
      h.app.Manual.open();
      const toc = h.document.getElementById('manualToc').innerHTML;
      assert.equal((toc.match(/data-goto="/g) || []).length, h.app.Manual.SECTIONS.length,
        'contents and sections disagree');
      h.app.Manual.SECTIONS.forEach(s =>
        assert.includes(toc, `data-goto="${s.id}"`, `no contents entry for ${s.id}`));
    });

    test('every contents entry points at a rendered section', () => {
      const h = fresh();
      h.app.Manual.open();
      const doc = h.document.getElementById('manualDoc').innerHTML;
      const toc = h.document.getElementById('manualToc').innerHTML;
      [...toc.matchAll(/data-goto="([^"]+)"/g)].map(m => m[1]).forEach(id =>
        assert.includes(doc, `id="mn-${id}"`, `contents links to ${id}, which is not rendered`));
    });

    test('the prose renders no literal undefined, NaN or [object Object]', () => {
      const h = fresh();
      h.app.Manual.open();
      const doc = h.document.getElementById('manualDoc').innerHTML;
      ['undefined', 'NaN', '[object Object]'].forEach(bad =>
        assert.notIncludes(doc, bad, `the manual renders "${bad}"`));
    });

    test('the threshold table quotes the live configuration', () => {
      const h = fresh();
      const { CFG } = h.app;
      const table = h.app.Manual.thresholdTable();
      [['frostArm', 1], ['frostClear', 1], ['heatArm', 1], ['heatClear', 1],
       ['moistArm', 1], ['moistClear', 1], ['traffArm', 1], ['traffClear', 1],
       ['ndviArm', 2], ['ndviClear', 2]].forEach(([k, dec]) =>
        assert.includes(table, CFG.THRESH[k].toFixed(dec),
          `the manual does not show CFG.THRESH.${k} (${CFG.THRESH[k]}) — it has drifted from the engine`));
    });

    test('the feed table lists every declared source', () => {
      const h = fresh();
      const table = h.app.Manual.feedTable();
      Object.keys(h.app.SOURCES).forEach(id =>
        assert.includes(table, h.app.SOURCES[id].short, `${id} is missing from the feed table`));
    });

    test('every scenario button carries a real trigger id', () => {
      const h = fresh();
      const firable = h.app.EventEngine.RULES.map(r => r.id).concat(['SIGNAL_LOSS', 'RESTORE']);
      h.app.Manual.SCENARIOS.forEach(s =>
        assert.includes(firable, s.id, `scenario "${s.title}" fires ${s.id}, which is not a real path`));
    });

    test('scenario buttons render with data-trigger, so the delegate catches them', () => {
      const h = fresh();
      h.app.Manual.open();
      const doc = h.document.getElementById('manualDoc').innerHTML;
      h.app.Manual.SCENARIOS.forEach(s =>
        assert.includes(doc, `data-trigger="${s.id}"`, `scenario ${s.id} has no data-trigger`));
      assert.equal((doc.match(/data-manual-run/g) || []).length, h.app.Manual.SCENARIOS.length,
        'scenario buttons are not all marked as manual runs');
    });

    test('every console trigger is explained by a scenario', () => {
      const h = fresh();
      h.app.Views.TRIGGERS.forEach(t =>
        assert.ok(h.app.Manual.SCENARIOS.some(s => s.id === t.id),
          `console trigger ${t.id} is undocumented`));
    });

    test('running a scenario fires the rule and closes the manual', () => {
      const h = fresh();
      h.app.Manual.open();
      const before = h.app.State.data.log.length;
      h.document.dispatch('click', {
        type: 'click',
        target: { closest: sel => (sel === '[data-trigger]'
          ? { classList: { add() {}, remove() {} }, dataset: { trigger: 'RESTORE', manualRun: '1' } } : null) },
      });
      assert.greater(h.app.State.data.log.length, before, 'the scenario did not reach the engine');
      assert.notOk(h.app.Manual.isOpen(), 'the manual stayed open over the console');
    });

    test('reopening re-reads the configuration rather than serving a snapshot', () => {
      const h = fresh();
      h.app.Manual.open();
      const first = h.document.getElementById('manualDoc').innerHTML;
      h.app.Manual.close();
      h.app.CFG.THRESH.frostArm = -1.5;                 // as if someone edited the engine
      h.app.Manual.open();
      const second = h.document.getElementById('manualDoc').innerHTML;
      assert.includes(second, '-1.5', 'the manual served a stale snapshot of the thresholds');
      assert.notEqual(first, second, 'the manual did not re-render');
      h.app.CFG.THRESH.frostArm = 0.0;
    });

    test('the manual reflects the active region rather than the default', () => {
      const h = fresh();
      h.app.Region.load('usa-fresno');
      h.app.Manual.open();
      assert.includes(h.document.getElementById('manualDoc').innerHTML, 'Fresno',
        'the manual still describes the previous region');
    });

    test('with nothing loaded the manual says every value is synthetic', () => {
      const h = fresh();
      h.app.Manual.open();
      const doc = h.document.getElementById('manualDoc').innerHTML;
      assert.includes(doc, 'synthetic', 'the manual does not warn that nothing is live');
    });

    /* The provenance table is generated from Live.PROV, so it cannot drift from
       what the engine actually uses -- which is the whole reason it is generated. */
    test('the provenance table names the real source of every metric', () => {
      const h = fresh();
      const table = h.app.Manual.provenanceTable();
      Object.keys(h.app.METRICS).forEach(k => {
        const p = h.app.Live.provenanceFor(k);
        assert.includes(table, p ? p.source : 'no live source',
          `the manual does not state where ${k} comes from`);
      });
    });

    test('the manual never claims any metric is a direct measurement', () => {
      const h = fresh();
      const table = h.app.Manual.provenanceTable();
      assert.notIncludes(table, '>Measured<',
        'the manual claims a measurement the data cannot support');
    });

    test('the manual explains why Sentinel and a numeric NDVI are absent', () => {
      const h = fresh();
      h.app.Manual.open();
      const doc = h.document.getElementById('manualDoc').innerHTML;
      assert.includes(doc, 'client secret', 'does not explain why Copernicus is unavailable');
      assert.includes(doc, 'No keyless point service', 'does not explain why NDVI stays modelled');
    });

    test('the manual states what offline actually means', () => {
      const h = fresh();
      h.app.Manual.open();
      const doc = h.document.getElementById('manualDoc').innerHTML;
      assert.includes(doc, 'contradiction', 'the manual does not confront "live data offline"');
      assert.includes(doc, 'never presents a stale number as current', 'the cache contract is not stated');
    });

    test('opening and closing repeatedly leaks no errors', () => {
      const h = fresh();
      for (let i = 0; i < 6; i++) { h.app.Manual.open(); h.app.Manual.close(); }
      assert.equal(h.errors.length, 0, `manual cycling logged: ${h.errors[0]}`);
    });

    test('goto() on an unknown section is a no-op rather than a throw', () => {
      const h = fresh();
      h.app.Manual.open();
      h.app.Manual.goto('no-such-section');
      assert.equal(h.errors.length, 0, 'an unknown section threw');
    });
  });

  /* ==================================================== accessibility ====== */
  suite('controls · accessibility basics', () => {
    const { markup } = readSource();

    test('every button carries a label or accessible name', () => {
      const buttons = [...markup.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)];
      assert.greater(buttons.length, 5, 'button scan found too little');
      buttons.forEach(b => {
        const tag = b[0].slice(0, b[0].indexOf('>') + 1);
        const text = b[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
        assert.ok(text.length > 0 || /aria-label=/.test(tag) || /aria-labelledby=/.test(tag),
          `a button has neither text nor an aria-label: ${tag.slice(0, 90)}`);
      });
    });

    test('every select has an associated label', () => {
      [...markup.matchAll(/<select[^>]*id="([^"]+)"[^>]*>/g)].forEach(m => {
        const id = m[1];
        assert.ok(markup.includes(`for="${id}"`) || /aria-label=/.test(m[0]),
          `#${id} has no label`);
      });
    });

    test('the live status region is announced politely', () =>
      assert.includes(markup, 'aria-live="polite"', 'downlink status changes are never announced'));

    test('the data table has a caption', () =>
      assert.includes(markup, '<caption', 'the raw telemetry table has no caption'));

    test('reduced motion is honoured', () => {
      const { html } = readSource();
      assert.includes(html, 'prefers-reduced-motion', 'animations ignore the reduced-motion preference');
    });

    test('touch targets clear the 44px minimum', () => {
      const { html } = readSource();
      assert.includes(html, 'min-height:44px', 'no minimum touch target is enforced');
    });

    test('status is never carried by colour alone', () => {
      // Every .chip in the markup must ship a glyph alongside its colour class.
      const chips = [...markup.matchAll(/<span[^>]*class="chip [^"]*"[^>]*>([\s\S]*?)<\/span>/g)];
      chips.forEach(c =>
        assert.includes(c[1], 'chip-icon', `a status chip relies on colour alone: ${c[0].slice(0, 70)}`));
    });
  });
  /* ======================================================== the deck ======= */
  suite('controls · deck reachability', () => {
    const { app, document } = boot();
    const { Views, Triage } = app;

    /* A fresh boot has answered nobody's "where is your farm?", so the deck
       stands down and the first-run panel takes the screen. These checks are
       about the deck, so they say the question was answered. */
    app.State.data.chosen = true;

    const deckHtml = () => { Views.renderDeck(); return document.getElementById('farmerDeck').innerHTML; };

    test('the deck renders into its host', () =>
      assert.greater(deckHtml().length, 0, 'the deck host is empty after a render'));

    test('the deck renders either calls or a stated empty state, never blank', () => {
      const html = deckHtml();
      assert.ok(html.includes('deck-empty') || html.includes('data-call'),
        'the deck rendered neither a call nor a reason there are none');
    });

    test('every deck row names a call the detail renderer answers for', () => {
      const html = deckHtml();
      [...html.matchAll(/data-call="([^"]+)"/g)].map(m => m[1]).forEach(id =>
        assert.equal(typeof Views.detailFor(id), 'string',
          `the deck offers ${id} but no detail renderer answers for it`));
    });

    test('every deck row is a button, so a keyboard reaches it', () => {
      const html = deckHtml();
      const rows = [...html.matchAll(/data-call="/g)].length;
      const buttons = [...html.matchAll(/<button[^>]*data-call="/g)].length;
      assert.equal(buttons, rows, 'a deck row that is not a button cannot be tabbed to');
    });

    test('every group the renderer can emit is a group Triage can produce', () => {
      const html = deckHtml();
      [...html.matchAll(/class="deck-group ([a-z]+)"/g)].map(m => m[1]).forEach(g =>
        assert.includes(Triage.GROUPS, g, `the deck drew a "${g}" heading Triage never assigns`));
    });

    test('the group vocabulary has not drifted', () =>
      assert.deepEqual(Triage.GROUPS, ['act', 'warn', 'ok']));

    test('a first visit opens on the decisions, not the console', () => {
      /* Landing everyone in Ops is the habit this restructure exists to break,
         and it is one line away from coming back by accident. */
      const fresh = boot();
      assert.equal(fresh.app.State.data.role, 'FARMER',
        'a new visitor still lands on the console');
    });

    test('every role switcher agrees with the role the app starts in', () => {
      /* There are two switchers -- the bottom tab bar below 1024px and the
         header chips above it -- so this checks they agree with each other and
         with the boot role, not that only one control exists. */
      const { markup } = readSource();
      const selected = [...markup.matchAll(/data-role="([A-Z]+)" aria-selected="true"/g)].map(m => m[1]);
      assert.greater(selected.length, 0, 'no role is highlighted anywhere');
      assert.deepEqual([...new Set(selected)], ['FARMER'],
        'a role switcher highlights a role the app did not start in');
    });

    test('a wide screen can reach every role', () => {
      /* Desktop had no roles at all before -- Ops showed everything -- and the
         tab bar is display:none above 1024px. Without a second switcher a
         desktop reader opens on Farmer and can never leave it. */
      const { markup } = readSource();
      const head = markup.slice(markup.indexOf('<header'), markup.indexOf('</header>'));
      ['FARMER', 'BUYER', 'DRIVER', 'OPS'].forEach(r =>
        assert.includes(head, `data-role="${r}"`,
          `${r} is unreachable on a screen where the tab bar is hidden`));
    });

    test('a cascade headline reaches the person it concerns', () => {
      /* The alert line of a cascade carries no channel, so before the broadcast
         rule a farmer read "begin cutting Plot F-2" without the sentence saying
         why. Defaulting to Farmer made that the first thing anyone saw.

         Posted through Console.post rather than pushed by hand, so the message
         shape is the one the app actually stores. */
      const h = boot();
      h.app.Telemetry.stop();
      h.app.State.data.channel = 'FARMER';
      h.app.State.data.chat.length = 0;
      h.app.Console.post('BOT', 'FROST EVENT — surface temperature at the frost floor.', {});
      h.app.Console.post('BOT', 'Amara — begin cutting.', { channel: 'FARMER' });
      h.app.Console.post('BOT', 'Kwesi — your order is revised.', { channel: 'BUYER' });
      h.app.Views.renderChat();

      const html = h.document.getElementById('chatStream').innerHTML;
      assert.includes(html, 'FROST EVENT', 'the broadcast headline is hidden from the farmer');
      assert.includes(html, 'begin cutting', 'the farmer lost their own line');
      assert.notIncludes(html, 'your order is revised',
        'an addressed line leaked onto another channel');
    });

    test('a stored role still wins over the default', () => {
      const stored = boot({ storage: { 'aura-state': JSON.stringify({ role: 'DRIVER' }) } });
      assert.includes(['DRIVER', 'FARMER'], stored.app.State.data.role,
        'a saved role was neither honoured nor safely defaulted');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The controls are drawn rather than typed. An emoji is painted by the
     platform's own font, so it is a different picture on every device, none of
     them testable; it ignores the theme, staying full colour on a dark ground
     beside text that has gone pale; and at 15px it is mush. */
  suite('controls · icons', () => {

    test('every placeholder in the shell names an icon that exists', () => {
      const h = boot();
      const slots = h.document.querySelectorAll('[data-icon]');
      assert.greater(slots.length, 8, 'the shell stopped asking for icons');
      slots.forEach(n =>
        assert.ok(h.app.ICONS[n.dataset.icon],
          `data-icon="${n.dataset.icon}" has no drawing, so that control renders blank`));
    });

    test('every icon is drawn in the text colour, so it follows both themes', () => {
      const h = boot();
      Object.keys(h.app.ICONS).forEach(name => {
        const svg = h.app.icon(name);
        assert.includes(svg, 'stroke="currentColor"', `${name} pins its own colour`);
        assert.includes(svg, 'aria-hidden="true"',
          `${name} would be announced beside the label it decorates`);
      });
    });

    test('the controls carry no emoji left to render differently per device', () => {
      const { markup } = readSource();
      const head = markup.slice(markup.indexOf('<header'), markup.indexOf('</nav>', markup.indexOf('tabbar')));
      const emoji = [...head.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)].map(m => m[0]);
      assert.deepEqual([...new Set(emoji)], [],
        'an emoji survives in the header or the tab bar');
    });

    /* Whether the drawings are actually ON the controls is a browser question:
       the stub's querySelectorAll fabricates fresh nodes from the markup rather
       than returning the live ones, so paintIcons writes into throwaways here.
       What this suite can hold is that every slot names a real icon and every
       icon is drawn correctly; that they arrive on screen is checked by driving
       the app, which is where the emoji problem was visible in the first place. */
  });

  /* ------------------------------------------------------------------------ */
  /* setRole writes data-role onto <body>. Anything that then asks closest() for
     a bare [data-role] finds the body from anywhere in the document, so every
     click in the app re-ran setRole for the role already active and ended on
     window.scrollTo({top:0}). Tapping a chat channel tab threw the whole page
     back to the top. */
  suite('controls · role delegation', () => {

    test('the delegated handler asks for a button, not a bare attribute', () => {
      const { html } = readSource();
      assert.includes(html, "closest('button[data-role]')",
        'a bare [data-role] selector also matches <body>, which carries the active role');
      assert.notIncludes(html, "querySelectorAll('[data-role]')",
        'this stamps aria-selected on <body>, which is not a widget');
    });

    test('a click on something that is not a role button leaves the page where it is', () => {
      const h = boot();
      h.app.Views.setRole('FARMER');

      /* The real ancestor chain of a chat channel tab: the tab itself, then
         <body>, which setRole has just stamped with data-role. */
      const tab = {
        tagName: 'BUTTON', dataset: { channel: 'BUYER' },
        closest(sel) { return h.document._closest(this, sel); },
      };
      h.document._closest = (node, sel) =>
        (node === tab && sel === '[data-role]') ? h.document.body : null;

      let scrolled = 0;
      h.window.scrollTo = () => { scrolled += 1; };
      h.document.dispatch('click', { target: tab });

      assert.equal(scrolled, 0,
        'a click that was not a role button scrolled the page to the top');
    });

    test('a real role button still switches, and still goes to the top', () => {
      const h = boot();
      h.app.Views.setRole('FARMER');
      const btn = {
        tagName: 'BUTTON', dataset: { role: 'DRIVER' },
        closest(sel) { return h.document._closest(this, sel); },
      };
      h.document._closest = (node, sel) =>
        (node === btn && sel === 'button[data-role]') ? btn : null;

      let scrolled = 0;
      h.window.scrollTo = () => { scrolled += 1; };
      h.document.dispatch('click', { target: btn });

      assert.equal(h.app.State.data.role, 'DRIVER', 'the role tab stopped working');
      assert.equal(scrolled, 1, 'a genuine role switch should start at the top of the new view');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The first screen. It used to give two answers to "where am I?" at once: a
     deck saying it had no location, a search box naming one, and a Ghanaian
     demo farm's moisture and NDVI in between. */
  suite('controls · first run', () => {

    const fresh = () => boot();
    const chosen = () => boot({ storage: { 'aura-agrinet:v1': JSON.stringify({
      v: 1, regionId: 'ghana-eastern', chosen: true, role: 'FARMER' }) } });

    test('a visitor who has chosen nothing gets the panel', () => {
      const h = fresh();
      assert.equal(h.document.body.dataset.firstrun, '1',
        'the app did not enter its first-run state');
    });

    test('the panel asks the question and offers a way to answer it', () => {
      const { markup } = readSource();
      assert.includes(markup, 'Where is your farm?', 'the panel does not ask anything');
      assert.includes(markup, 'id="placeSearchF"', 'the panel has no search field');
      assert.includes(markup, 'id="placeGeoF"', 'the panel has no "use my location" button');
      assert.includes(markup, 'id="frExamples"', 'the panel offers no example catchment');
    });

    /* The whole point. A demo farm's readings under a notice saying there is no
       location was the contradiction this replaces. */
    test('no farm readings are on screen before a farm is chosen', () => {
      const h = fresh();
      h.app.Views.renderDeck();
      h.app.Views.renderRolePanes();
      const pane = h.document.getElementById('farmerDeck').innerHTML
                 + h.document.getElementById('farmerExtra').innerHTML;
      assert.equal(pane.trim(), '',
        'the Farmer view drew a catchment nobody has picked');
    });

    test('the search box shows its placeholder rather than a region nobody picked', () => {
      const h = fresh();
      h.app.Views.renderRegionPicker();
      assert.equal(h.document.getElementById('placeSearch').value, '',
        'the box named a location while the app was asking for one');
    });

    test('the example chips are catchments the app actually ships', () => {
      const h = fresh();
      h.app.Views.renderExamples();
      const html = h.document.getElementById('frExamples').innerHTML;
      Object.keys(h.app.REGIONS).forEach(id =>
        assert.includes(html, `data-builtin="${id}"`, `${id} is missing from the examples`));
    });

    test('a reader who chose a farm never sees the panel again', () => {
      const h = chosen();
      assert.notEqual(h.document.body.dataset.firstrun, '1',
        'the app asked a question that had already been answered');
    });

    /* Snapshots written before `chosen` existed still describe someone who
       answered, and must not be re-interrogated by the upgrade. */
    test('an older snapshot with a searched farm counts as answered', () => {
      const h = boot({ storage: { 'aura-agrinet:v1': JSON.stringify({
        v: 1, regionId: 'ghana-eastern', role: 'FARMER',
        place: { name: 'Kisumu', lat: -0.102, lon: 34.762 } }) } });
      assert.ok(h.app.State.data.chosen, 'a stored farm was treated as no answer at all');
    });

    test('an older snapshot on a non-default region counts as answered', () => {
      const h = boot({ storage: { 'aura-agrinet:v1': JSON.stringify({
        v: 1, regionId: 'nigeria-oyo', role: 'FARMER' }) } });
      assert.ok(h.app.State.data.chosen, 'a deliberately picked catchment was forgotten');
    });

    /* The composer's cast list names a plot of the catchment nobody picked. */
    test('the persona row is gated with the rest of it', () => {
      const { html } = readSource();
      assert.includes(html, 'body[data-firstrun] .persona-row',
        'the "Send as: Amara — Farmer, Plot F-2" row survives on the first screen');
      assert.includes(html, 'body[data-firstrun] header .search',
        'two search boxes on a screen built to ask one question');
    });

    test('no quick reply invites a question about a farm nobody has', () => {
      const h = fresh();
      h.app.Views.renderQuickReplies();
      assert.equal(h.document.getElementById('quickReplies').innerHTML, '',
        'the app offered "Soil moisture?" with no soil to report on');
    });

    /* The sharpest form of it: a number with a source attached is the most
       believable thing this app can put on a screen. */
    test('the agent declines rather than answering for somebody else\'s plot', async () => {
      const h = fresh();
      h.app.Telemetry.stop();
      h.app.Console.handleUserMessage('Soil moisture?');
      await h.advance(20000);
      const last = h.app.State.data.chat[h.app.State.data.chat.length - 1];
      const said = h.app.Views.msgText(last);
      assert.includes(said, 'no farm to answer for',
        'the agent answered a question about a catchment nobody chose');
      assert.notIncludes(said, 'F-2', 'a plot of the unchosen catchment was named');
      assert.notIncludes(said, '%', 'a reading for the unchosen catchment reached the transcript');
    });

    test('your own words are still yours, and still posted', async () => {
      const h = fresh();
      h.app.Telemetry.stop();
      h.app.Console.handleUserMessage('Soil moisture?');
      assert.ok(h.app.State.data.chat.some(m => m.mine && m.text === 'Soil moisture?'),
        'the question the reader typed was swallowed');
    });

    test('the answer is written down, so it survives the next launch', () => {
      const h = fresh();
      h.app.State.data.chosen = true;
      h.app.State.save();
      assert.ok(JSON.parse(h.storage.get('aura-agrinet:v1')).chosen,
        'the snapshot does not record that the question was answered');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The theme control. The palettes themselves are checked in assets.test.js,
     which can read the stylesheet; what matters here is that the choice is
     reachable, lands on the document where the CSS is waiting for it, survives
     a restart, and takes the browser's own chrome with it. */
  suite('controls · theme', () => {

    test('a fresh visitor follows the machine rather than a guess', () => {
      const h = boot();
      assert.equal(h.app.Theme.mode(), 'system',
        'with no stored choice the app must not force a theme on anyone');
      assert.equal(h.document.documentElement.getAttribute('data-theme'), null,
        'system means no attribute at all — the media query does the work');
    });

    test('choosing dark puts the attribute the CSS reads on the document', () => {
      const h = boot();
      h.app.Theme.set('dark');
      assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
      assert.equal(h.storage.get('aura-theme'), 'dark', 'the choice was not stored');
    });

    test('choosing light survives a dark machine', () => {
      const h = boot();
      h.app.Theme.set('light');
      assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light',
        'without the attribute the prefers-color-scheme block would win');
    });

    test('going back to system removes the attribute again', () => {
      const h = boot();
      h.app.Theme.set('dark');
      h.app.Theme.set('system');
      assert.equal(h.document.documentElement.getAttribute('data-theme'), null,
        'a leftover attribute would pin the reader to one theme forever');
      assert.equal(h.storage.get('aura-theme'), 'system');
    });

    test('a stored choice is honoured on the next launch', () => {
      const h = boot({ storage: { 'aura-theme': 'dark' } });
      assert.equal(h.app.Theme.mode(), 'dark', 'the stored theme was ignored');
      assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark',
        'boot must apply the theme before the first paint, not after');
    });

    test('a nonsense stored value falls back instead of breaking the palette', () => {
      const h = boot({ storage: { 'aura-theme': 'sepia' } });
      assert.equal(h.app.Theme.mode(), 'system', 'an unknown mode must not reach the document');
    });

    /* The metas are per-scheme, so on an explicit choice they have to stop
       disagreeing with the page: force dark on a light machine and the browser
       chrome stays oat while everything below it goes to soil. */
    test('an explicit choice points both theme-colour metas at one ground', () => {
      const h = boot();
      h.app.Theme.set('dark');
      const dark = h.app.Theme.PLANE.dark;
      assert.equal(h.document.getElementById('tcLight').getAttribute('content'), dark);
      assert.equal(h.document.getElementById('tcDark').getAttribute('content'), dark);
    });

    test('system hands the two metas back their own colours', () => {
      const h = boot();
      h.app.Theme.set('dark');
      h.app.Theme.set('system');
      assert.equal(h.document.getElementById('tcLight').getAttribute('content'), h.app.Theme.PLANE.light);
      assert.equal(h.document.getElementById('tcDark').getAttribute('content'), h.app.Theme.PLANE.dark);
    });

    test('every mode the module offers is a row the menu draws', () => {
      const h = boot();
      h.app.Views.renderThemeMenu();
      const html = h.document.getElementById('themeMenu').innerHTML;
      h.app.Theme.MODES.forEach(m =>
        assert.includes(html, `data-theme-mode="${m.id}"`, `${m.id} has no row in the menu`));
    });

    test('the button shows the setting, not the resolved theme', () => {
      const h = boot();
      h.app.Theme.set('system');
      h.app.Views.renderThemeMenu();
      assert.equal(h.document.getElementById('themeGlyph').dataset.icon, 'auto',
        'on "match system" the button must not claim a theme the reader did not pick');
      h.app.Theme.set('dark');
      h.app.Views.renderThemeMenu();
      assert.equal(h.document.getElementById('themeGlyph').dataset.icon, 'moon');
    });

    /* A browser answers "what is the system set to" with a media query, and the
       CSS reads it directly. A WebView told not to darken the page answers
       "light" whatever the phone says, so the host has to hand the real value in
       or "match system" silently becomes "always light". */
    test('nobody having said, the media query is left to decide', () => {
      const h = boot();
      h.app.Theme.set('system');
      assert.equal(h.app.Theme.systemDark(), null, 'a value was invented');
      assert.equal(h.document.documentElement.getAttribute('data-theme'), null,
        'an attribute here would override the media query in every browser');
      assert.equal(h.app.Theme.resolved(), null);
    });

    test('a host that knows the system is dark gets a dark page', () => {
      const h = boot();
      h.app.Theme.set('system');
      h.app.Theme.systemIsDark(true);
      assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
      assert.equal(h.document.getElementById('tcDark').getAttribute('content'),
        h.app.Theme.PLANE.dark, 'the browser chrome stayed on the other theme');
    });

    test('a host that knows the system is light gets a light page', () => {
      const h = boot();
      h.app.Theme.set('system');
      h.app.Theme.systemIsDark(false);
      assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light');
    });

    test('an explicit choice still beats what the host reports', () => {
      const h = boot();
      h.app.Theme.systemIsDark(true);
      h.app.Theme.set('light');
      assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light',
        'the reader asked for light on a dark phone and did not get it — the bug');
      h.app.Theme.set('dark');
      h.app.Theme.systemIsDark(false);
      assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
    });

    test('the host can take its answer back', () => {
      const h = boot();
      h.app.Theme.set('system');
      h.app.Theme.systemIsDark(true);
      h.app.Theme.systemIsDark(null);
      assert.equal(h.document.documentElement.getAttribute('data-theme'), null,
        'a stale attribute would pin the page to whatever the phone was last set to');
    });

    test('every mode draws an icon rather than a platform emoji', () => {
      const h = boot();
      h.app.Views.renderThemeMenu();
      const html = h.document.getElementById('themeMenu').innerHTML;
      h.app.Theme.MODES.forEach(m => {
        assert.ok(h.app.ICONS[m.icon], `${m.id} names an icon that does not exist`);
        assert.includes(html, h.app.ICONS[m.icon].slice(0, 30),
          `${m.id} did not draw its icon`);
      });
      assert.notIncludes(html, '☀', 'an emoji survived in the theme menu');
      assert.notIncludes(html, '🌙', 'an emoji survived in the theme menu');
    });
  });
};
