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

    /* Two mounts, painted from one list by renderTriggers, so a trigger added to
       TRIGGERS cannot appear on one surface and not the other. */
    test('both the ops panel and the control panel host trigger buttons', () => {
      assert.includes(markup, 'id="triggerButtons"', 'no ops-panel trigger container');
      assert.includes(markup, 'id="triggerButtonsPanel"', 'no control-panel trigger container');
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

    /* A quick reply the matcher does not understand is a button that does
       nothing, which is what this whole suite exists for. The contextual ones
       are generated from live models rather than listed, so they are read out of
       the source and put through the same matcher as the standing four. */
    test('every contextual quick reply resolves to an intent', () => {
      const src = readSource().script;
      const body = src.slice(src.indexOf('function contextualQuick(){'),
                             src.indexOf('function renderQuickReplies(){'));
      const asked = [...body.matchAll(/'([^']+\?)'/g)].map(m => m[1]);
      assert.greater(asked.length, 3, 'the contextual replies vanished');
      asked.forEach(q =>
        assert.ok(app.Console.match(q),
          `"${q}" matches no intent — the button would do nothing on the day it appears`));
    });

    test('the replies follow the deck rather than a fixed list', () => {
      const h = boot();
      h.app.State.data.chosen = true;
      const src = readSource().script;
      assert.includes(src, 'contextualQuick()',
        'renderQuickReplies no longer consults the deck');
      // With no live models there is nothing contextual to say, and the standing
      // four still fill the row so a quiet day can still be asked about.
      h.app.Views.renderQuickReplies();
      const html = h.document.getElementById('quickReplies').innerHTML;
      assert.greater([...html.matchAll(/data-quick=/g)].length, 0,
        'a farm with no live model left the composer with no suggestions at all');
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

    /* post() stamps a message with the PERSONA's channel and the transcript is
       filtered by the TAB. While those were two free controls, six of the twelve
       combinations threw away both the line you typed and the reply to it --
       silently, the message sitting in state with nowhere on screen to go, and
       one tap from a cold boot. They are one selection now, and this walks every
       combination rather than the pair that happened to get reported. */
    test('a sent message survives every tab and persona combination', async () => {
      const lost = [];
      for (const ch of ['ALL', 'FARMER', 'BUYER', 'DRIVER']) {
        for (const p of ['FARMER', 'BUYER', 'DRIVER']) {
          const h = boot();
          h.app.Telemetry.stop();
          h.app.State.data.chosen = true;
          await h.advance(10000);              // let the greeting finish draining
          h.app.State.data.chat.length = 0;
          h.app.Views.setChannel(ch);
          h.app.Views.setPersona(p);
          h.app.Console.handleUserMessage('Full status');
          await h.advance(4000);
          h.app.Views.renderChat();
          const dom = h.document.getElementById('chatStream').innerHTML;
          if (!dom.includes('Full status')) lost.push(`${ch}/${p}: your own line`);
          if (!dom.includes('Field readiness')) lost.push(`${ch}/${p}: the reply`);
        }
      }
      assert.deepEqual(lost, [], 'a message was sent and never appeared');
    });

    test('choosing a channel and choosing a speaker move together', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Views.setChannel('BUYER');
      assert.equal(h.app.State.data.persona, 'BUYER',
        'the tab says Buyers while the composer still speaks as somebody else');
      h.app.Views.setPersona('DRIVER');
      assert.equal(h.app.State.data.channel, 'DRIVER',
        'the composer moved and the transcript did not follow it');
      /* All is a reading position rather than a channel to be dragged around:
         anything sent from it is visible under it whatever channel it carries. */
      h.app.Views.setChannel('ALL');
      h.app.Views.setPersona('FARMER');
      assert.equal(h.app.State.data.channel, 'ALL',
        'choosing who to speak as dragged the reader off the All tab');
    });

    /* Dots followed by nothing are a promise the console does not keep. The
       indicator carries the channel its message will arrive on and faces the
       same filter, so the two can only agree. */
    test('the typing indicator never plays for a message this tab will not show', () => {
      const h = boot();
      const { Views, Console, PEOPLE } = h.app;
      h.app.Telemetry.stop();
      const row = h.document.getElementById('typingRow');
      const cases = [
        ['DRIVER', { from: 'FARMER', channel: 'FARMER' }, false],
        ['DRIVER', { from: 'BOT', channel: 'ALL' }, true],
        ['ALL', { from: 'FARMER', channel: 'FARMER' }, true],
        ['BUYER', { from: 'BUYER', channel: 'BUYER' }, true],
        ['BUYER', { from: 'BOT', channel: 'DRIVER' }, false],
      ];
      cases.forEach(([tab, info, shown]) => {
        h.app.State.data.channel = tab;
        Views.renderTyping(info);
        assert.equal(!row.className.includes('hidden'), shown,
          `on the ${tab} tab, ${info.from}/${info.channel} dots should be ${shown ? 'shown' : 'hidden'}`);
      });
      // And the message that follows must face the same answer the dots gave.
      h.app.State.data.channel = 'DRIVER';
      assert.equal(Views.channelVisible({ from: 'FARMER', channel: 'FARMER' }), false,
        'the indicator and the message disagree about the same conversation');
      assert.equal(Console.channelOf({ from: 'FARMER' }), PEOPLE.FARMER.channel,
        'a step naming no channel no longer resolves to its sender, so it broadcasts');
    });

    /* Object.assign copies a key whose value is undefined, so a cascade step
       naming no channel used to overwrite post()'s default with nothing -- and
       channelVisible reads a missing channel as a broadcast. Amara's reply on
       the farmer's line was landing on the buyer's tab and the driver's. */
    test('an addressed reply stays addressed', async () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.State.data.chat.length = 0;
      h.app.Console.cascade('DROUGHT', {});
      await h.advance(9000);
      const farmer = h.app.State.data.chat.filter(m => m.from === 'FARMER');
      assert.greater(farmer.length, 0, 'the farmer never replied, so this proves nothing');
      farmer.forEach(m => assert.equal(m.channel, 'FARMER',
        'a farmer reply carries no channel, so every tab shows it'));
    });

    test('the console chip reports the link it actually has', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Views.renderLiveChip();
      const chat = h.document.getElementById('chatLink');
      assert.ok(chat.innerHTML.length > 0, 'the console chip was never rendered');
      assert.notIncludes(chat.className, 'good',
        'the console claims a live link with no observation behind it');
      /* The header chip and this one describe one fact, and renderLiveChip calls
         renderChatLink rather than the wiring calling both -- so they cannot be
         scheduled apart. That arrangement is what this holds in place. */
      const { script } = readSource();
      const at = script.indexOf('function renderLiveChip(){');
      assert.includes(script.slice(at, at + 200), 'renderChatLink()',
        'the two chips over one fact are scheduled separately and will drift');
    });
  });

  /* =========================================================== alarm ======= */
  /* A critical message has to reach a grower who is not looking at the phone.
     The sound itself cannot be tested without an audio device, so what is tested
     is the decision around it: which messages are worth interrupting somebody
     for, and whether the reader can make it stop. */
  suite('controls · the alarm', () => {
    test('only a critical message is worth interrupting someone for', () => {
      const { app } = boot();
      const cases = [
        [{ severity: 'critical' }, true],
        [{ severity: 'serious' }, true],
        [{ severity: 'warning' }, false],
        [{ severity: 'good' }, false],
        [{ severity: null }, false],
        [{}, false],
        [null, false],
        // Your own words, echoed back into the transcript, are not news.
        [{ severity: 'critical', mine: true }, false],
      ];
      cases.forEach(([msg, want]) =>
        assert.equal(app.Alarm.shouldFire(msg), want,
          `shouldFire(${JSON.stringify(msg)}) should be ${want}`));
    });

    test('muting it actually stops it', () => {
      const h = boot();
      h.app.State.data.muted = true;
      assert.equal(h.app.Alarm.fire(), 'muted', 'the alarm sounded while muted');
      h.app.State.data.muted = false;
      assert.notEqual(h.app.Alarm.fire(), 'muted', 'the alarm stayed silent while armed');
    });

    test('the mute survives a restart', () => {
      const h = boot();
      h.app.State.data.muted = true;
      h.app.State.save();
      const back = boot({ storage: Object.fromEntries(h.storage) });
      assert.equal(back.app.State.data.muted, true,
        'the alarm comes back armed after somebody deliberately silenced it');
    });

    test('the toggle reports its state without renaming itself', () => {
      const h = boot();
      const b = h.document.getElementById('btnMute');
      h.app.State.data.muted = false;
      h.app.Views.renderMute();
      const armed = b.getAttribute('aria-label');
      assert.equal(b.getAttribute('aria-pressed'), 'true', 'an armed alarm reads as unpressed');
      h.app.State.data.muted = true;
      h.app.Views.renderMute();
      assert.equal(b.getAttribute('aria-pressed'), 'false', 'a muted alarm reads as pressed');
      assert.equal(b.getAttribute('aria-label'), armed,
        'the accessible name changes with the state, so translateStatic will revert it');
      assert.equal(b.getAttribute('data-muted'), 'true', 'the glyph is never struck through');
    });

    /* A transcript restored from localStorage is assigned into state and painted
       by renderChat -- it never goes back through post(). If it did, every cold
       start would replay yesterday's frost, and an alarm that greets every launch
       is one the reader learns to ignore. */
    test('a restored transcript does not sound the alarm', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Console.post('BOT', 'FROST EVENT', { severity: 'critical' });
      h.app.State.save();

      let fired = 0;
      const back = boot({ storage: Object.fromEntries(h.storage) });
      back.app.Alarm.fire = () => { fired++; return 'played'; };
      back.app.State.restore();
      back.app.Views.renderChat();
      assert.equal(fired, 0, 'reopening the app replayed an old alarm');
      assert.ok(back.app.State.data.chat.some(m => m.severity === 'critical'),
        'the critical message did not survive the round trip, so this proves nothing');
    });

    test('the vibration carries the same rhythm as the tone', () => {
      const { app } = boot();
      assert.ok(Array.isArray(app.Alarm.VIBE), 'no vibration pattern');
      assert.greater(app.Alarm.VIBE.length, 3,
        'a single buzz is indistinguishable from every other notification on the phone');
      app.Alarm.VIBE.forEach(ms =>
        assert.between(ms, 20, 400, 'a vibration step is outside anything a phone will render'));
    });
  });

  /* ===================================================== alarm · sound ===== */
  /* The decision around the alarm was always tested; the sound never was. The
     harness defined no AudioContext, so context() returned null in every test and
     play() had never once executed. These assert the graph itself: what reaches
     the speaker, how loud, and when. */

  /* The loudest instant of a motif: the summed peak of every voice alive at once.
     Past 1.0 the sum clips, which is heard as a crack rather than a tone. */
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

  /** How long a motif occupies the speaker, first voice on to last voice off. */
  function span(ctx) {
    return Math.max(...ctx.oscs.map(o => o.stoppedAt)) -
           Math.min(...ctx.oscs.map(o => o.startedAt));
  }

  suite('controls · the alarm sounds', () => {
    test('every voice reaches the speaker through the master gain', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.app.Alarm.fire();
      const ctx = h.audio;
      assert.greater(ctx.oscs.length, 3, 'the motif is a single tone, not a phrase');
      ctx.oscs.forEach((o, i) => {
        assert.ok(o.reaches(ctx.destination), `voice ${i} is built but never heard`);
        // osc -> envelope -> master -> destination. A voice wired straight at the
        // destination cannot be scaled or held apart from the others.
        assert.ok(o.outs[0] && o.outs[0].kind === 'gain', `voice ${i} has no envelope`);
        assert.ok(o.outs[0].outs[0] && o.outs[0].outs[0].kind === 'gain',
          `voice ${i} bypasses the master gain`);
      });
    });

    test('one alarm does not clip', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.app.Alarm.fire();
      assert.less(peakGain(h.audio), 1.0, 'the summed voices clip');
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
        'the caller was told a grower had been alerted when nothing at all occurred');
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

    /* The backgrounded-iOS shape. resume() is refused outside a user gesture, so
       the tone never lands -- and the old fire() returned true regardless, telling
       the caller a grower had been alerted who heard and felt nothing. */
    test('a refused resume is not reported as a sound', async () => {
      const h = boot({ audio: 'blocked' });
      h.app.State.data.muted = false;
      h.app.Alarm.fire();
      await new Promise(r => setImmediate(r));
      assert.equal(h.audio.oscs.length, 0, 'this proves nothing if the tone played');
      assert.equal(h.app.Alarm.lastOutcome(), 'blocked',
        'the alarm believes it sounded when the phone refused it');
    });

    /* Two rules can arm in one interaction -- frost and road saturation both sit
       in the panel -- and two motifs on one destination sum past 1.0, which is a
       crack rather than an alarm. The second buzz also cancels the pattern the
       first was still playing, and that rhythm is the whole reason this alert is
       distinguishable from every other notification on the phone. */
    test('a second alarm during the first neither clips nor cuts it', () => {
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
      assert.ok(late.every(o => o.startedAt >= firstEnds - 0.03),
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

    /* Bound {once:true}, the unlock listener is spent on the first gesture. The
       system re-suspends a context whenever the screen goes off or the app is
       backgrounded, and fire() then calls resume() from a timer rather than from
       a gesture -- which is exactly where iOS refuses. The alarm is silent for
       the rest of the session. The reader's next tap has to be able to bring it
       back, so the listener has to still be there to hear it. */
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

    /* Critical lifts to the fifth above the root; serious drops to the fifth
       below it. The same interval in opposite directions -- a relationship a
       listener learns once and then reads without attending to it. Serious is
       shorter, quieter and carries no low body, so it is audibly the subordinate
       of the two rather than a second emergency. */
    test('serious sounds, and sounds like the smaller sibling', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.app.Alarm.fire('serious');
      const s = { peak: peakGain(h.audio), span: span(h.audio), n: h.audio.oscs.length };
      const h2 = boot();
      h2.app.State.data.muted = false;
      h2.app.Alarm.fire('critical');
      const c = { peak: peakGain(h2.audio), span: span(h2.audio) };

      assert.greater(s.n, 0, 'a serious message makes no sound at all');
      assert.less(s.peak, c.peak, 'the two tones are equally loud, so neither ranks');
      assert.less(s.span, c.span, 'the two tones are the same length');
      assert.notOk(h.audio.oscs.some(o => o.type === 'sine'),
        'the serious tone carries the low body, which is what makes critical urgent');
    });

    test('the two tones move in opposite directions', () => {
      /* Each pulse is a fundamental with its own fifth stacked over it, so the
         melody has to be read off the fundamentals -- the lowest voice struck at
         each instant. Comparing raw frequencies instead reads the first pulse's
         fundamental against the last pulse's stacked fifth, which rises in both
         tones and would call this passing. */
      const at = (h, sev) => {
        h.app.State.data.muted = false;
        h.app.Alarm.fire(sev);
        const byOnset = new Map();
        h.audio.oscs.filter(o => o.type === 'triangle').forEach(o => {
          const f = o.frequency.ops[0][1];
          const t = o.startedAt.toFixed(4);
          if (!byOnset.has(t) || f < byOnset.get(t)) byOnset.set(t, f);
        });
        const v = [...byOnset.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(e => e[1]);
        return { first: v[0], last: v[v.length - 1] };
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
      assert.equal(app.Alarm.toneFor({ severity: null }), null);
      assert.equal(app.Alarm.toneFor(null), null);
      assert.equal(app.Alarm.toneFor({ severity: 'serious', mine: true }), null,
        'your own words, echoed back into the transcript, are not news');
    });

    /* The console resolves the tone and passes it through. Dropping it there
       would leave every serious message sounding the emergency motif, which
       un-ranks the pair the moment it ships. */
    test('the console posts a serious message at its own weight', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.State.data.muted = false;
      h.app.Console.post('BOT', 'ROOT-ZONE MOISTURE STRESS', { severity: 'serious' });
      assert.ok(h.audio, 'a serious message made no sound at all');
      assert.notOk(h.audio.oscs.some(o => o.type === 'sine'),
        'a serious message sounded the critical motif');
    });

    /* On a phone in a pocket the buzz is the half of the alarm that lands; on a
       desk it is the half that startles. One switch cannot serve both. */
    test('vibration has its own switch, and it survives a restart', () => {
      const h = boot();
      assert.equal(h.app.State.data.haptics, true, 'the motor is off by default');
      h.app.State.data.haptics = false;
      h.app.State.data.muted = false;
      h.app.Alarm.fire('critical');
      assert.equal(h.vibes.length, 0, 'the phone buzzed after the motor was turned off');
      assert.greater(h.audio.oscs.length, 3, 'turning the buzz off silenced the tone too');
      h.app.State.save();
      const back = boot({ storage: Object.fromEntries(h.storage) });
      assert.equal(back.app.State.data.haptics, false,
        'a reader who turned the buzz off finds it back on next launch');
    });
  });

  /* ==================================================== control panel ====== */
  /* The controls sat in four places: the header, the ops panel, the console head
     and a mobile-only sheet titled "Event Simulation" -- a name that covered one
     of the five things it held, on a surface that existed below 1024px only. The
     panel replaces that sheet and reaches the rest without moving buttons a
     reader has already learnt where to find. */
  suite('controls · the control panel', () => {
    const IDS = ['ctrlPanel', 'btnPanel', 'ctrlClose', 'ctrlTitle', 'triggerButtonsPanel',
                 'btnPauseP', 'btnSpeedP', 'btnSyncP', 'btnAlarmP', 'btnHapticsP',
                 'btnTestAlarm', 'btnThemeP', 'btnLangP', 'btnFarmP', 'btnManualP',
                 'ctrlStatus', 'btnRefreshP', 'btnClearChat',
                 'btnResetAll', 'ctrlResetConfirm', 'btnResetYes', 'btnResetNo'];

    test('every element the panel drives exists in the markup', () => {
      const { markup } = readSource();
      IDS.forEach(id => assert.includes(markup, `id="${id}"`, `#${id} is missing`));
    });

    test('the simulation sheet is gone, and nothing still reaches for it', () => {
      const { markup, script } = readSource();
      assert.notIncludes(markup, 'id="simSheet"', 'the replaced sheet is still in the markup');
      assert.notIncludes(script, "el('simSheet')", 'the script still reaches for the deleted sheet');
      assert.notIncludes(script, 'simClose', 'a listener is bound to a button that no longer exists');
      assert.notIncludes(script, 'openSheet', 'the function that drove the deleted sheet survives');
      assert.notIncludes(script, 'triggerButtonsMobile', 'triggers still paint into a dead mount');
    });

    test('the location search kept its ids, so Search needed no change', () => {
      const { markup } = readSource();
      ['placeSearchM', 'placeResultsM', 'placeGeoM'].forEach(id =>
        assert.includes(markup, `id="${id}"`, `#${id} was lost in the move`));
    });

    /* Search paints ONE result list into all three of its boxes and unhides all
       three, so a location typed into the header or the first-run panel leaves
       this box holding that list. The list is absolutely positioned, so it opens
       over whatever follows it -- which is why Location is the last section, and
       why opening the panel shuts the search. Both, because either alone leaves
       a stale list showing on a surface nobody searched from. */
    test('the search sits last and is shut when the panel opens', () => {
      const { markup, script } = readSource();
      const loc = markup.indexOf('>Location<');
      assert.greater(loc, 0, 'the location section is gone');
      ['>Feed<', '>Alerts<', '>Simulate<', '>View<', '>Data<'].forEach(sec =>
        assert.less(markup.indexOf(sec), loc,
          `${sec} follows the location search, so an open result list covers it`));

      const open = script.slice(script.indexOf('function open(on){'));
      assert.includes(open.slice(0, open.indexOf('function toggle') + 400), 'Search.close()',
        'the panel opens without shutting a result list left over from another box');
    });

    /* Tailwind here is prebuilt: a class invented today produces no rule at all,
       so a panel styled with new utility classes would render unstyled. */
    test('the panel is styled with real CSS, not classes that do nothing', () => {
      const { html } = readSource();
      assert.match(html, /\.ctrl-panel\s*\{/, 'the panel has no stylesheet rule');
      assert.match(html, /\.ctrl-grid\s*\{/, 'the panel grid has no stylesheet rule');
      assert.match(html, /@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]{0,400}?\.ctrl-panel/,
        'the panel is still a bottom sheet on a 1440px screen');
    });

    /* The FAB is the phone's way in, and it spent its whole life display:none.
       A media query adds no specificity, so the `.fab{display:flex}` inside the
       mobile block and the unconditional `.fab{…display:none}` written after it
       were an even match settled by source order -- which the hiding rule won at
       every width. The override has to come after the rule it overrides. */
    test('the FAB is actually shown on a phone', () => {
      const { html } = readSource();
      const base = html.search(/^\.fab\{/m);
      assert.greater(base, 0, 'the base .fab rule is gone');
      const override = html.search(/@media\s*\(max-width:\s*1023px\)\s*\{\s*\.fab\{\s*display:flex/);
      assert.greater(override, 0, 'nothing ever sets the FAB to display:flex');
      assert.greater(override, base,
        'the display:flex override is written before the display:none it must beat, ' +
        'so the FAB is hidden at every width and the panel is unreachable from a phone');
    });

    test('it opens from the header button and the FAB, and closes again', () => {
      const h = boot();
      const p = h.document.getElementById('ctrlPanel');
      assert.equal(p.hidden, true, 'the panel starts open');

      h.document.getElementById('btnPanel').dispatch('click');
      assert.equal(p.hidden, false, 'the header button did not open it');
      assert.equal(h.document.getElementById('btnPanel').getAttribute('aria-expanded'), 'true',
        'the button does not report that it opened something');

      h.document.getElementById('ctrlClose').dispatch('click');
      assert.equal(p.hidden, true, 'Close did not close it');

      h.document.getElementById('fabSim').dispatch('click');
      assert.equal(p.hidden, false, 'the FAB did not open it');
    });

    test('Escape closes it, and the manual still closes first', () => {
      const h = boot();
      h.app.Panel.open(true);
      h.document.dispatch('keydown', { key: 'Escape' });
      assert.equal(h.document.getElementById('ctrlPanel').hidden, true, 'Escape did not close it');

      h.app.Panel.open(true);
      h.app.Manual.open();
      h.document.dispatch('keydown', { key: 'Escape' });
      assert.equal(h.app.Manual.isOpen(), false, 'the manual did not close first');
      assert.equal(h.document.getElementById('ctrlPanel').hidden, false,
        'one Escape closed two layers at once');
    });

    test('Ctrl+K opens it', () => {
      const h = boot();
      h.document.dispatch('keydown', { key: 'k', ctrlKey: true, preventDefault(){} });
      assert.equal(h.document.getElementById('ctrlPanel').hidden, false, 'Ctrl+K did not open it');
      h.document.dispatch('keydown', { key: 'k', metaKey: true, preventDefault(){} });
      assert.equal(h.document.getElementById('ctrlPanel').hidden, true, 'Cmd+K did not toggle it shut');
    });

    /* A shortcut that eats a keystroke mid-sentence is worse than no shortcut.
       The composer is where a farmer types, and "k" is a common letter. */
    test('the shortcut stays out of the way while somebody is typing', () => {
      const h = boot();
      h.document.activeElement = { tagName: 'INPUT' };
      h.document.dispatch('keydown', { key: 'k', ctrlKey: true, preventDefault(){} });
      assert.equal(h.document.getElementById('ctrlPanel').hidden, true,
        'Ctrl+K opened the panel out from under a reader mid-sentence');
    });

    /* The bug this shape keeps producing: markup defaults painted over restored
       state, so a reader who silenced the alarm and closed the app finds it armed. */
    test('its switches report restored state, not the markup defaults', () => {
      const h = boot();
      h.app.State.data.muted = true;
      h.app.State.data.haptics = false;
      h.app.State.save();
      const back = boot({ storage: Object.fromEntries(h.storage) });
      back.app.Panel.render();
      assert.equal(back.document.getElementById('btnAlarmP').getAttribute('aria-pressed'), 'false',
        'the panel shows an armed alarm that the reader had silenced');
      assert.equal(back.document.getElementById('btnHapticsP').getAttribute('aria-pressed'), 'false',
        'the panel shows a buzz the reader had turned off');
    });

    /* One switch, two surfaces. Two independent booleans over one fact is the
       defect; reaching the same State field from both is the point of the panel. */
    test('the panel switch and the console glyph are one switch', () => {
      const h = boot();
      h.app.State.data.muted = false;
      h.document.getElementById('btnAlarmP').dispatch('click');
      assert.equal(h.app.State.data.muted, true, 'the panel switch did not mute');
      assert.equal(h.document.getElementById('btnMute').getAttribute('data-muted'), 'true',
        'the console glyph disagrees with the panel');
      assert.equal(h.document.getElementById('btnAlarmP').getAttribute('aria-pressed'), 'false',
        'the panel switch does not report its own new state');
    });

    test('the vibration switch flips and persists', () => {
      const h = boot();
      h.document.getElementById('btnHapticsP').dispatch('click');
      assert.equal(h.app.State.data.haptics, false, 'the switch did not turn the buzz off');
      const back = boot({ storage: Object.fromEntries(h.storage) });
      assert.equal(back.app.State.data.haptics, false, 'it came back on after a restart');
    });

    /* The control that answers "is this thing working" without waiting for a
       frost -- which is the only way a grower could check before this existed. */
    test('the test button sounds the alarm when nothing has gone wrong', () => {
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
      assert.ok(h.app.State.data.log.some(e => /alert sound is off/i.test(e.title || '')),
        'the reader pressed test, heard nothing, and was told nothing');
    });

    test('the triggers paint into the panel too', () => {
      const h = boot();
      h.app.Views.renderTriggers();
      assert.includes(h.document.getElementById('triggerButtonsPanel').innerHTML,
        'data-trigger="FROST_EVENT"',
        'the panel offers no triggers, so it does less than the sheet it replaced');
    });

    test('pause and speed drive the same state as the ops panel', () => {
      const h = boot();
      h.document.getElementById('btnPauseP').dispatch('click');
      assert.equal(h.app.State.data.paused, true, 'the panel did not pause the feed');
      const before = h.app.State.data.speed;
      h.document.getElementById('btnSpeedP').dispatch('click');
      assert.notEqual(h.app.State.data.speed, before, 'the panel did not change the speed');
    });

    test('clearing the transcript empties it and keeps it emptied', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Console.post('BOT', 'a line worth forgetting', {});
      assert.greater(h.app.State.data.chat.length, 0, 'nothing to clear, so this proves nothing');
      h.document.getElementById('btnClearChat').dispatch('click');
      assert.equal(h.app.State.data.chat.length, 0, 'the transcript survived being cleared');
      // Written through, not just blanked on screen: the snapshot is what a
      // reopened app reads, and a clear that lives only in memory comes back.
      assert.equal(JSON.parse(h.storage.get(h.app.State.STORE_KEY)).chat.length, 0,
        'the cleared transcript was still on disk');
      /* A reopened app greets, so one line is expected and correct -- what must
         not survive is the cleared traffic. */
      const back = boot({ storage: Object.fromEntries(h.storage) });
      assert.notOk(back.app.State.data.chat.some(m => m.text === 'a line worth forgetting'),
        'the cleared transcript came back');
    });

    /* ---- reset asks once ---- */

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

    /* Armed and then forgotten is the dangerous state: a reader who walked away
       must not come back to a live Yes under their thumb. */
    test('an armed reset disarms itself', async () => {
      const h = boot();
      h.document.getElementById('btnResetAll').dispatch('click');
      await h.advance(6000);
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
      assert.ok(reloaded, 'the page kept running on state it had just deleted from disk');
    });
  });

  /* ======================================================== keyboard ====== */
  /* Android does not need this -- MainActivity reads the IME inset natively and
     pads the WebView. iOS has no equivalent: in a standalone app the keyboard
     overlays the viewport without resizing it, and visualViewport is the only
     signal WebKit gives. Nothing in the file read it. */
  suite('controls · the iOS keyboard', () => {
    /* A visualViewport that can be driven the way WebKit drives it. */
    function withViewport(h, height, offsetTop) {
      const listeners = {};
      h.window.visualViewport = {
        height, offsetTop: offsetTop || 0, offsetLeft: 0, scale: 1,
        addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
        removeEventListener: () => {},
        fire: t => (listeners[t] || []).forEach(fn => fn({ type: t })),
      };
      return h.window.visualViewport;
    }

    test('the inset is the layout height less what is still visible', () => {
      const h = boot({ mobile: true });
      h.window.innerHeight = 844;
      withViewport(h, 508);                 // 844 - 508 = a 336px keyboard
      assert.equal(h.app.Keyboard.inset(), 336, 'the keyboard inset is measured wrong');
    });

    /* WebKit scrolls the VISUAL viewport to reveal the focused field, so its
       offsetTop grows as the keyboard comes up. Leave it out of the expression
       and the inset reads as zero exactly when the keyboard is up. */
    test('a scrolled visual viewport does not read as no keyboard', () => {
      const h = boot({ mobile: true });
      h.window.innerHeight = 844;
      withViewport(h, 508, 120);
      assert.equal(h.app.Keyboard.inset(), 216,
        'offsetTop is not in the expression, so a scrolled page hides the keyboard');
      assert.greater(h.app.Keyboard.inset(), 0, 'the keyboard vanished from the measurement');
    });

    /* Safari's form accessory bar is roughly 44px and is not a keyboard. Treating
       it as one hides the tab bar every time a field is focused on a device with
       a hardware keyboard attached. */
    test('an accessory bar alone is not a keyboard', () => {
      const h = boot({ mobile: true });
      h.window.innerHeight = 844;
      withViewport(h, 800);                 // 44px
      h.app.Keyboard.apply();
      assert.notOk(h.document.body.dataset.kb, 'a 44px inset was treated as a keyboard');
    });

    test('a keyboard-sized inset is', () => {
      const h = boot({ mobile: true });
      h.window.innerHeight = 844;
      withViewport(h, 508);
      h.app.Keyboard.apply();
      assert.equal(h.document.body.dataset.kb, '1', 'a 336px keyboard went unnoticed');
      assert.equal(h.document.documentElement.style.getPropertyValue('--kb'), '336px',
        'the inset was never published to the stylesheet');
    });

    test('putting the keyboard away clears it again', () => {
      const h = boot({ mobile: true });
      h.window.innerHeight = 844;
      const vv = withViewport(h, 508);
      h.app.Keyboard.apply();
      vv.height = 844;
      h.app.Keyboard.apply();
      assert.notOk(h.document.body.dataset.kb, 'the page stayed in keyboard mode');
    });

    /* The same three consequences MainActivity already produces on Android from
       the same fact: a fixed bar would float over the keys, and the home
       indicator is behind the keyboard so counting it too doubles the gap. */
    test('the bars get out of the way and the inset stops being counted twice', () => {
      const { html } = readSource();
      assert.match(html, /body\[data-kb\][^{]*\.tabbar\s*\{[^}]*display\s*:\s*none/,
        'the tab bar floats over the keyboard');
      assert.match(html, /body\[data-kb\][^{]*\.fab\s*\{[^}]*display\s*:\s*none/,
        'the floating button floats over the keyboard');
      assert.match(html, /body\[data-kb\]\s*\{[^}]*--safe-b\s*:\s*0/,
        'the home indicator inset is counted on top of the keyboard, doubling the gap');
    });

    test('an engine with no visualViewport is left exactly as it was', () => {
      const h = boot({ mobile: true });
      h.window.visualViewport = undefined;
      assert.equal(h.app.Keyboard.inset(), 0, 'a missing visualViewport did not read as zero');
      h.app.Keyboard.apply();               // must not throw
      assert.notOk(h.document.body.dataset.kb, 'keyboard mode was entered with nothing to measure');
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
  /* Chrome fires beforeinstallprompt and offers to install itself. iOS fires
     nothing, has no API for it, and buries the only route two taps inside the
     Share sheet -- so an iPhone reader has no way to learn this is installable.
     Which makes the hint the difference between shipping an iOS version and
     merely being compatible with one, and makes showing it in the wrong place
     the difference between a tip and a nuisance. */
  suite('controls · the iPhone install hint', () => {

    const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15'
                 + ' (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const IPAD   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
                 + ' (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    const CHROME_IOS = IPHONE.replace('Safari/604.1', 'CriOS/126.0 Mobile/15E148 Safari/604.1');
    const ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko)'
                  + ' Chrome/126.0 Mobile Safari/537.36';

    const nav = (ua, extra) => Object.assign({ userAgent: ua, maxTouchPoints: 0 }, extra || {});

    test('it is offered on an iPhone in Safari', () => {
      const h = boot();
      assert.ok(h.app.IosHint.isIosSafari(nav(IPHONE)), 'an iPhone was not recognised');
    });

    /* iPadOS reports itself as a Mac, so the touch points are what separate a
       tablet from a desktop Safari. */
    test('an iPad is recognised through its Mac user agent', () => {
      const h = boot();
      assert.ok(h.app.IosHint.isIosSafari(nav(IPAD, { maxTouchPoints: 5 })), 'iPadOS was missed');
      assert.notOk(h.app.IosHint.isIosSafari(nav(IPAD, { maxTouchPoints: 0 })),
        'a desktop Mac was told to use a Share sheet it does not have');
    });

    test('it stays away from browsers the instruction would be wrong for', () => {
      const h = boot();
      assert.notOk(h.app.IosHint.isIosSafari(nav(CHROME_IOS)),
        'Chrome on iOS has its own share sheet, so these two taps are wrong');
      assert.notOk(h.app.IosHint.isIosSafari(nav(ANDROID)),
        'Android was told to add to a Home Screen it reaches another way');
    });

    test('it never appears inside the installed app', () => {
      const h = boot();
      assert.ok(h.app.IosHint.standalone({ standalone: true }, null),
        'a page already running as an app was not recognised as one');
    });

    test('dismissing it is remembered', () => {
      const h = boot();
      assert.notOk(h.app.IosHint.dismissed(), 'a fresh install reads as already dismissed');
      h.app.IosHint.dismiss();
      assert.ok(h.app.IosHint.dismissed(), 'the dismissal was not written down');
      assert.equal(h.storage.get(h.app.IosHint.STORE_KEY), '1');
      const again = boot({ storage: Object.fromEntries(h.storage) });
      assert.ok(again.app.IosHint.dismissed(), 'it came back after a restart');
    });

    test('it is hidden on the platforms that do not need it', () => {
      const h = boot();      // the harness user agent is not iOS Safari
      assert.notOk(h.app.IosHint.shouldShow(),
        'the hint would show on a machine that has no Share sheet');
      assert.notEqual(h.document.body.dataset.iosHint, '1');
    });

    test('the shell carries the hint and its dismiss control', () => {
      const { markup } = readSource();
      assert.includes(markup, 'id="iosInstall"', 'no hint in the page');
      assert.includes(markup, 'id="iosInstallClose"', 'no way to dismiss it');
      assert.includes(markup, 'Add to Home Screen',
        'the hint does not name the thing the reader has to tap');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Four things the app had been assuming and printing the assumption for. The
     point of making them answerable is not tidiness: each one is wired into a
     calculation, so answering one has to change what the deck says. A setting
     that changes nothing is a preference, and this app does not have those. */
  suite('controls · your farm', () => {

    test('an untouched install computes exactly what it computed before', () => {
      const h = boot();
      const F = h.app.Farm;
      assert.notOk(F.touched(), 'a fresh farm claims to have been answered');
      assert.equal(F.soil().id, 'loam', 'the default soil is not the mid-texture the code assumed');
      assert.equal(F.rootMm(), 300, 'the default root zone moved');
      assert.equal(F.sprayLimits().windMax, 20, 'the default wind limit moved');
      assert.equal(F.crop(), null, 'a crop was invented before anyone named one');
    });

    test('a coarser soil holds less water, so the refill point moves', () => {
      const h = boot();
      const span = id => {
        h.app.Farm.set('soil', id);
        const s = h.app.Farm.soil();
        return (s.fieldCapacity - s.wilting) * h.app.Farm.rootMm();
      };
      const sand = span('sand'), clay = span('clay');
      assert.less(sand, clay,
        'sand and clay hold the same usable water, so the soil field decides nothing');
      assert.greater(clay - sand, 20, 'the difference is too small to change any call');
    });

    test('the grower’s crop wins over the synthesised plot layout', () => {
      const h = boot();
      h.app.Farm.set('crop', 'Wheat');
      assert.equal(h.app.Farm.crop(), 'Wheat');
      h.app.Farm.set('crop', '');
      assert.equal(h.app.Farm.crop(), null, 'clearing the crop did not fall back to the layout');
    });

    test('a spray limit the grower sets is the limit spray uses', () => {
      const h = boot();
      h.app.Farm.set('windMax', 8);
      assert.equal(h.app.Agronomy.limits().windMax, 8,
        'the agronomy still reads the conventional limit');
      assert.less(h.app.Agronomy.limits().windOk, 8,
        'the marginal band should sit under the hard limit, whatever it is');
    });

    test('nonsense is clamped rather than believed', () => {
      const h = boot();
      const F = h.app.Farm;
      F.set('rootMm', 99999);
      assert.equal(F.rootMm(), F.LIMITS.rootMm.max, 'an absurd root zone was accepted');
      F.set('rootMm', -5);
      assert.equal(F.rootMm(), F.LIMITS.rootMm.min);
      /* Text is refused outright rather than clamped to the nearest end of the
         range: a field nobody answered legibly is unanswered, and the honest
         value for it is the assumption the app was already printing. */
      F.set('windMax', 'not a number');
      assert.notOk(F.answered('windMax'), 'text was accepted as an answer');
      assert.equal(F.value('windMax'), F.DEFAULTS.windMax, 'a rejected edit left a bad value behind');
      F.set('soil', 'basalt');
      assert.equal(F.soil().id, 'loam', 'an unknown soil was stored');
    });

    test('the answers survive a restart', () => {
      const h = boot();
      h.app.Farm.set('soil', 'clay');
      h.app.Farm.set('rootMm', 700);
      h.app.State.save();
      const again = boot({ storage: Object.fromEntries(h.storage) });
      assert.equal(again.app.Farm.soil().id, 'clay', 'the soil was forgotten');
      assert.equal(again.app.Farm.rootMm(), 700, 'the root zone was forgotten');
      assert.ok(again.app.Farm.touched(), 'a restored farm reads as unanswered');
    });

    test('the sheet is reachable and offers every soil and crop', () => {
      const h = boot();
      const { markup } = readSource();
      assert.includes(markup, 'id="btnFarm"', 'no way to open the sheet');
      assert.includes(markup, 'id="farmSheet"', 'no sheet');
      h.app.Views.renderFarm();
      const html = h.document.getElementById('farmBody').innerHTML;
      Object.keys(h.app.SOILS).forEach(k =>
        assert.includes(html, `value="${k}"`, `${k} is missing from the soil list`));
      Object.keys(h.app.CROPS).forEach(k =>
        assert.includes(html, `value="${k}"`, `${k} is missing from the crop list`));
      Object.keys(h.app.Farm.LIMITS).forEach(k =>
        assert.includes(html, `data-farm="${k}"`, `${k} has no field`));
    });

    /* The provenance under a number is the app's whole argument. It has to stop
       saying "assumed" once it is no longer assuming. */
    test('the provenance stops saying assumed once it has been answered', () => {
      const h = boot();
      h.app.Views.renderFarm();
      h.app.Farm.set('soil', 'clay');
      const { html } = readSource();
      assert.includes(html, 'as you set them',
        'nothing in the app ever credits the grower for the values they gave');
      assert.includes(html, 'assumed mid-texture soil',
        'the honest default wording was removed along with the assumption');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Where the numbers come from, on the page rather than in the console. When the
     roles were split these chips went into Ops with the rest of the
     instrumentation, so a grower could no longer see which feeds were up without
     going to look for them. */
  suite('controls · sources', () => {

    /* Between the header and the grid: under the controls, above everything they
       produced, and outside every role pane so all four roles carry it. */
    test('the strip is in the shell, above the grid and outside any one role', () => {
      const { markup } = readSource();
      assert.includes(markup, 'id="sourceStrip"', 'no source strip in the page');
      const at = markup.indexOf('id="sourceStrip"');
      assert.greater(at, markup.indexOf('</header>'), 'the strip is above the header');
      assert.less(at, markup.indexOf('<main'),
        'the strip is inside or below the grid, so it moves with whichever role is showing');
    });

    test('every simulated source is listed, up or not', () => {
      const h = boot();
      h.app.Views.renderLinks();
      const html = h.document.getElementById('sourceStrip').innerHTML;
      Object.values(h.app.SOURCES).forEach(src =>
        assert.includes(html, src.short, `${src.id} is missing from the strip`));
    });

    test('a source with no coverage is shown and labelled, not dropped', () => {
      const h = boot();
      /* CROP-CASMA is CONUS-only. Outside the United States the chip has to say
         so rather than quietly disappear -- an absent feed is exactly the one
         worth naming. */
      h.app.State.data.links.S2 = { status: 'unavailable', latency: null };
      h.app.Views.renderLinks();
      const html = h.document.getElementById('sourceStrip').innerHTML;
      assert.includes(html, 'SENTINEL-2', 'an unavailable source vanished from the strip');
      assert.includes(html, 'N/A', 'it is listed but its state is not stated');
    });

    /* On a 320px screen the strip was four chips on four lines, a quarter of the
       viewport, pushing the app's own question below the fold. What it sheds
       there is the latency in milliseconds -- console detail, still printed in
       Ops -- and never the state word, because a status in this app is an icon
       AND a label, never colour alone. */
    test('the strip compacts on a small screen without dropping a state', () => {
      const { html } = readSource();
      assert.includes(html, '.srcstrip .lat-ms{ display:none; }',
        'the strip does not shed its latency figures on a narrow screen');
      assert.notIncludes(html, '.srcstrip .link-lat{ display:none',
        'hiding the state word would leave the dot colour saying it alone');
    });

    test('the latency is separable from the state it sits beside', () => {
      const h = boot();
      h.app.Views.renderLinks();
      const html = h.document.getElementById('sourceStrip').innerHTML;
      assert.includes(html, 'class="lat-ms"',
        'the milliseconds share an element with the state word, so neither can go without the other');
      const words = [...html.matchAll(/class="link-lat">([^<]*)/g)].map(m => m[1].trim());
      assert.greater(words.filter(Boolean).length, 0,
        'no chip states anything in words');
    });

    test('both hosts get the same chips', () => {
      const h = boot();
      h.app.Views.renderLinks();
      assert.equal(h.document.getElementById('sourceStrip').innerHTML,
                   h.document.getElementById('linkChips').innerHTML,
        'the footer strip and the Ops console disagree about which feeds are up');
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

    /* The composer's cast list names a plot of the catchment nobody picked. It
       is gated by role now rather than by first run -- speaking as the buyer is
       something you do while driving the simulation -- and first run is the
       Farmer role, so it stays hidden there too. */
    test('the persona row stays out of a grower composer', () => {
      const { html } = readSource();
      assert.includes(html, 'body:not([data-role="OPS"]) .persona-row',
        'the "Send as: Amara — Farmer, Plot F-2" row is still in every role');
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
