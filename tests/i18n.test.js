/* Internationalisation.

   The failures worth catching here are quiet ones: a placeholder dropped in
   translation so a number never reaches the screen, a catalogue key that no
   longer matches any string in the app, or a local variable shadowing the
   translator so every call returns undefined — which shipped once, and is why
   that last suite exists. */
'use strict';

const fs = require('fs');
const path = require('path');
const { boot, readSource, ROOT } = require('./harness');

module.exports = ({ suite, test, assert }) => {

  const catalogues = () => fs.readdirSync(path.join(ROOT, 'i18n'))
    .filter(f => f.endsWith('.json'))
    .map(f => ({ code: f.replace('.json', ''),
                 json: JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', f), 'utf8')) }));

  /* Every string the app can ask for: literal t() arguments, data-i18n markup,
     and the data tables that are translated at their render site. */
  function appStrings() {
    const { script, markup } = readSource();
    const set = new Set();
    for (const m of script.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) set.add(m[1].replace(/\\'/g, "'"));
    for (const m of markup.matchAll(/data-i18n[^>]*>([^<]+)</g)) set.add(m[1].trim());
    const tables = [/label:'([^']+)',\s+unit/g, /word:'([^']+)'/g, /label:'([^']+)',\s+glyph/g,
                    /note:'([^']+)'/g, /label:'([^']+)', severity/g, /product:'([^']+)'/g,
                    /nav:'([^']+)', title:'([^']+)'/g, /title:'([^']+)',\s*$/gm,
                    /name:'([A-Z][a-z]+)',\s+endonym/g,
                    /label:'([^']+)', product:'([^']+)'/g,    // satellite layers
                    /^\s{2}(\w+):\s+\{ frostSensitivity/gm]; // crop names, shown via t(n.crop)
    for (const re of tables) for (const m of script.matchAll(re)) {
      if (m[1]) set.add(m[1]);
      if (m[2]) set.add(m[2]);
    }

    /* Two blocks hold user-facing text that no generic pattern can isolate
       without also swallowing surrounding code, so each is read from its own
       body rather than from the whole script. */
    const block = (start, end) => {
      const a = script.indexOf(start);
      if (a < 0) return '';
      const b = script.indexOf(end, a);
      return script.slice(a, b < 0 ? a + 2000 : b);
    };
    for (const m of block('function statusWord(key, sev){', 'if(words[key]')
      .matchAll(/(?:good|warning|serious|critical):'([^']+)'/g)) set.add(m[1]);
    for (const m of block('const QUICK = {', '};').matchAll(/'([^']+)'/g)) set.add(m[1]);

    /* Log entries and advisory details are stored as English SOURCE and
       translated at paint time, so they appear as bare literals rather than
       inside t(). Both shapes must be scanned or the coverage figure lies.
       Split-and-slice rather than one big regex: the call spans lines and the
       arguments include ternaries, which a single pattern reads badly. */
    script.split('Log.add(').slice(1).forEach(chunk => {
      const head = chunk.slice(0, chunk.indexOf(');') + 1 || 400);
      for (const lit of head.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
        const v = lit[1].replace(/\\'/g, "'");
        if (/^(info|good|warning|serious|critical|cache|network|none)$/.test(v)) continue;  // code values, not UI text
        set.add(v);
      }
    });
    for (const m of script.matchAll(/role:'([^']+)'/g)) set.add(m[1]);   // PEOPLE roles, shown via t(p.role)
    for (const m of script.matchAll(/detailKey:\s*'((?:[^'\\]|\\.)*)'/g)) set.add(m[1].replace(/\\'/g, "'"));

    // Same filter the catalogue builder applies, so both sides agree on the set.
    return new Set([...set].map(x => x.trim()).filter(x => x && x.length > 1));
  }

  module.exports.appStrings = appStrings;

  /* ------------------------------------------------------------- engine --- */
  suite('i18n · engine', () => {
    const h = boot();
    const { I18n } = h.app;

    test('English is the default and needs no catalogue', () => {
      assert.equal(I18n.lang(), 'en', 'did not start in English');
      assert.equal(I18n.t('Soil moisture'), 'Soil moisture', 'English did not pass through');
    });

    test('an unknown string returns itself, not a blank or a raw key', () =>
      assert.equal(I18n.t('A sentence nobody translated'), 'A sentence nobody translated',
        'a missing string would render as something other than correct English'));

    test('null and undefined translate to an empty string', () => {
      assert.equal(I18n.t(null), '', 'null leaked');
      assert.equal(I18n.t(undefined), '', 'undefined leaked');
    });

    test('placeholders are filled', () =>
      assert.equal(I18n.t('Irrigate · {mm} mm', { mm: 36 }), 'Irrigate · 36 mm', 'interpolation failed'));

    test('an unsupplied placeholder stays visible rather than printing undefined', () =>
      assert.includes(I18n.t('Irrigate · {mm} mm', {}), '{mm}',
        'a missing variable must be obvious, never rendered as "undefined"'));

    test('every declared language has a code, locale, direction and endonym', () =>
      I18n.LANGS.forEach(l => {
        assert.ok(/^[a-z]{2}$/.test(l.code), `bad code ${l.code}`);
        assert.ok(l.locale && l.name && l.endonym, `${l.code} is missing metadata`);
        assert.includes(['ltr', 'rtl'], l.dir, `${l.code} has no direction`);
      }));

    test('language codes are unique', () => {
      const c = I18n.LANGS.map(l => l.code);
      assert.equal(new Set(c).size, c.length, 'duplicate language code');
    });

    /* No right-to-left language ships today, but the engine, the stylesheet rules
       and this contract all remain so one can be added back as a catalogue file
       alone. What must hold is that `dir` is always a valid direction. */
    test('every language declares a usable direction', () =>
      I18n.LANGS.forEach(l => assert.includes(['ltr', 'rtl'], l.dir, `${l.code} has no direction`)));

    test('the RTL path still works if a language declares it', () => {
      const h2 = boot();
      const fake = { code:'xx', locale:'xx', dir:'rtl', name:'Test', endonym:'Test' };
      assert.equal(fake.dir, 'rtl', 'sanity');
      assert.includes(readSource().html, '[dir="rtl"]',
        'the right-to-left rules were removed, so re-adding Arabic would need CSS work too');
    });

    test('an unknown language falls back to English rather than breaking', () =>
      assert.equal(I18n.langFor('xx').code, 'en', 'unknown code did not fall back'));

    test('numbers are formatted for the locale', () => {
      assert.equal(I18n.num(1234.5, 1), '1,234.5', 'English grouping wrong');
      assert.equal(I18n.num(null), '—', 'null should render as a dash, not NaN');
      assert.equal(I18n.num(Infinity), '—', 'infinity should render as a dash');
    });

    test('the starting language is never inferred from the searched location', () => {
      // Where a field is has nothing to do with what its owner reads.
      const src = readSource().script;
      const fn = src.slice(src.indexOf('function initial()'), src.indexOf('const coverage ='));
      assert.notIncludes(fn, 'Region', 'language is being inferred from geography');
      assert.notIncludes(fn, 'countryCode', 'language is being inferred from country');
    });

    test('a stored choice wins over the browser default', () => {
      const h2 = boot({ storage: { 'aura-lang': 'pt' } });
      assert.equal(h2.app.I18n.initial(), 'pt', 'the saved language was ignored');
    });

    test('a stored language that no longer exists falls back', () => {
      const h2 = boot({ storage: { 'aura-lang': 'xx' } });
      assert.equal(h2.app.I18n.initial(), 'en', 'a removed language would leave a broken UI');
    });
  });

  /* --------------------------------------------------------- catalogues --- */
  suite('i18n · catalogues', () => {
    const cats = catalogues();
    const strings = appStrings();
    const h = boot();
    const declared = h.app.I18n.LANGS.filter(l => l.code !== 'en').map(l => l.code);

    test('a catalogue exists for every language in the picker', () =>
      declared.forEach(c =>
        assert.ok(cats.some(x => x.code === c), `${c} is offered but has no i18n/${c}.json`)));

    test('no catalogue exists for a language not offered', () =>
      cats.forEach(c =>
        assert.ok(declared.includes(c.code), `i18n/${c.code}.json is not offered in the picker`)));

    cats.forEach(({ code, json }) => {
      test(`${code}: declares its metadata`, () => {
        assert.ok(json.meta, 'no meta block');
        assert.equal(json.meta.code, code, 'meta code disagrees with the filename');
        assert.between(json.meta.coverage, 0, 1, 'coverage out of range');
        assert.equal(typeof json.meta.reviewed, 'boolean', 'no reviewed flag');
      });

      test(`${code}: does not claim to be reviewed`, () =>
        assert.equal(json.meta.reviewed, false,
          'a machine translation must not claim native-speaker review'));

      test(`${code}: every key matches a string the app uses`, () => {
        const stale = Object.keys(json.strings).filter(k => !strings.has(k));
        assert.deepEqual(stale.slice(0, 5), [], 'stale keys — a UI string changed or was removed');
      });

      /* Partial coverage is a supported state, not a failure — the app falls back
         to English per string and badges the language. What must never happen is
         a catalogue that MISREPORTS how complete it is, or one so sparse that the
         result is a scrambled half-English screen rather than a translation. */
      test(`${code}: reports its coverage honestly`, () => {
        const actual = Object.keys(json.strings).length / strings.size;
        assert.close(json.meta.coverage, actual, 0.02,
          'the badge would report a coverage the file does not have');
      });

      test(`${code}: is complete enough to be worth offering`, () => {
        const actual = Object.keys(json.strings).length / strings.size;
        assert.ok(actual >= 0.5,
          `only ${Math.round(actual * 100)}% translated — below this a mixed screen is worse than English`);
      });

      test(`${code}: anything below full coverage is badged`, () => {
        const h2 = boot();
        if (json.meta.coverage >= 1 && json.meta.reviewed) return;   // nothing to badge
        assert.includes(h2.app.Views.translationBadge.toString(), 'coverage',
          'partial or unreviewed translations must be visibly marked');
      });

      test(`${code}: is not a bulk copy of the English`, () => {
        // A few legitimately match (proper nouns, unit symbols); a quarter does not.
        const same = Object.entries(json.strings).filter(([k, v]) => k === v);
        assert.less(same.length / Math.max(1, Object.keys(json.strings).length), 0.25,
          `${same.length} entries are identical to the English source`);
      });

      test(`${code}: placeholders survive translation`, () =>
        Object.entries(json.strings).forEach(([k, v]) => {
          const want = (k.match(/\{\w+\}/g) || []).sort().join(',');
          const got  = (v.match(/\{\w+\}/g) || []).sort().join(',');
          assert.equal(got, want, `"${k}" lost or gained a placeholder — a number would vanish`);
        }));

      /* Without these a farmer typing in their own language gets the fallback
         reply every time — the buttons work only because they send English. */
      test(`${code}: supplies intent keywords`, () => {
        const VALID = ['backhaul','order','help','status','moisture','frost','ndvi','route'];
        assert.ok(json.intents, 'no intents block');
        const unknown = Object.keys(json.intents).filter(k => !VALID.includes(k));
        assert.deepEqual(unknown, [], 'keyword list for an intent the matcher does not have');
        const empty = VALID.filter(k => !(json.intents[k] || []).length);
        assert.deepEqual(empty, [], 'intents with no keywords are unreachable by typing');
      });

      test(`${code}: keywords are lowercase and non-trivial`, () =>
        Object.entries(json.intents || {}).forEach(([id, list]) =>
          list.forEach(w => {
            assert.equal(w, w.toLowerCase(), `${id} keyword "${w}" is not lowercase — matching is case-folded`);
            /* One character is a whole word in a logographic script — 箱 is
               "crate" — but a lone latin letter would match almost anything. */
            const cjk = /[㐀-鿿぀-ヿ]/.test(w);
            const min = cjk ? 1 : 2;
            assert.ok(w.trim().length >= min, `${id} keyword "${w}" is too short and would match noise`);
          })));

      test(`${code}: contains no markup`, () =>
        Object.entries(json.strings).forEach(([k, v]) =>
          assert.notIncludes(v, '<', `"${k}" contains HTML, which is escaped and shown literally`)));
    });
  });

  /* -------------------------------------------------------------- prose --- */
  suite('i18n · prose blocks', () => {
    const { script } = readSource();
    /* Two shapes name a prose block: tp('manual.x', …) for the manual sections,
       and pkey:'chat.x' on a stored chat step. Both are real keys. */
    const keys = [...new Set([
      ...[...script.matchAll(/tp\('([a-zA-Z.]+)'/g)].map(m => m[1]),
      ...[...script.matchAll(/pkey:\s*'([a-zA-Z.]+)'/g)].map(m => m[1]),
    ])];

    /* The English block each tp() call falls back to, pulled from the source so
       the tests compare against exactly what ships. */
    function englishBlocks() {
      const out = {};
      // Manual sections: tp('manual.x', `…`, {vars})
      for (const m of script.matchAll(/tp\('([a-zA-Z.]+)',\s*`([\s\S]*?)`/g)) out[m[1]] = m[2];
      /* Chat lines: a stored step keeps the English in `text:` and names its
         block in the `pkey:` that follows, so the source sits before the key
         rather than inside a tp() call. */
      for (const m of script.matchAll(/text:\s*('(?:[^'\\]|\\.)*')\s*,\s*pkey:\s*'([a-zA-Z.]+)'/g))
        out[m[2]] = m[1].slice(1, -1).replace(/\\'/g, "'");
      return out;
    }
    const EN = englishBlocks();

    const proseFiles = () => {
      const dir = path.join(ROOT, 'i18n', 'prose');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
        .map(f => ({ code: f.replace('.json', ''),
                     json: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
    };

    test('every tp() key is unique', () =>
      assert.equal(new Set(keys).size, keys.length, 'a duplicate key would make one block unreachable'));

    test('every tp() call supplies an English fallback', () =>
      keys.forEach(k => assert.ok(EN[k] !== undefined,
        `${k} has no readable English block — a missing catalogue would render nothing`)));

    test('the manual has a block per section', () => {
      const h = boot();
      h.app.Manual.SECTIONS.forEach(sec =>
        assert.includes(keys, `manual.${sec.id}`, `section ${sec.id} is not translatable`));
    });

    test('English renders with no catalogue and no leftover placeholders', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Manual.open();
      const doc = h.document.getElementById('manualDoc').innerHTML;
      assert.notIncludes(doc, 'undefined', 'the manual rendered undefined');
      assert.deepEqual((doc.match(/\{[a-zA-Z]+\}/g) || []), [],
        'an unsubstituted placeholder reached the screen');
    });

    proseFiles().forEach(({ code, json }) => {
      test(`prose/${code}: declares metadata and does not claim review`, () => {
        assert.ok(json.meta, 'no meta block');
        assert.equal(json.meta.code, code, 'meta code disagrees with the filename');
        assert.equal(json.meta.reviewed, false, 'machine translation must not claim review');
      });

      test(`prose/${code}: every key matches a tp() call in the app`, () => {
        const stale = Object.keys(json.blocks).filter(k => !keys.includes(k));
        assert.deepEqual(stale.slice(0, 5), [], 'stale prose keys');
      });

      test(`prose/${code}: placeholders survive translation`, () =>
        Object.entries(json.blocks).forEach(([k, v]) => {
          const want = [...new Set((EN[k] || '').match(/\{\w+\}/g) || [])].sort().join(',');
          const got  = [...new Set(v.match(/\{\w+\}/g) || [])].sort().join(',');
          assert.equal(got, want, `${k} lost or gained a placeholder — a value would vanish or a table would not render`);
        }));

      /* A dropped </strong> or an invented <div> breaks the manual's layout in a
         way no amount of reading the prose would reveal. */
      test(`prose/${code}: HTML tag structure matches the English`, () =>
        Object.entries(json.blocks).forEach(([k, v]) => {
          const tags = str => (str.match(/<\/?[a-z][a-z0-9]*/gi) || []).map(x => x.toLowerCase()).sort().join(',');
          assert.equal(tags(v), tags(EN[k] || ''), `${k} has a different tag structure from the English`);
        }));

      test(`prose/${code}: is not a bulk copy of the English`, () => {
        const same = Object.entries(json.blocks).filter(([k, v]) => v === EN[k]);
        assert.less(same.length / Math.max(1, Object.keys(json.blocks).length), 0.2,
          `${same.length} blocks are identical to the English source`);
      });
    });

    test('prose is fetched on demand, not precached', () => {
      // The whole point of the split: a low-bandwidth install must not carry
      // prose for eleven languages it will never open.
      const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
      assert.notIncludes(sw, 'i18n/prose/', 'prose in PRECACHE would quadruple the install');
    });

    /* A briefing step carries its prose key and variables; the queue drainer must
       forward both to post(). It once forwarded only severity/channel/kv, which
       left four lines stuck in English with an unfilled {farmer} placeholder —
       invisible to every other check because the block itself was translated. */
    test('the chat queue forwards prose keys and variables to the message', () => {
      const drain = script.slice(script.indexOf('function drain(){'),
                                script.indexOf('function cascade('));
      assert.includes(drain, 'pkey:', 'a briefing line would lose its prose key and never retranslate');
      assert.includes(drain, 'vars:', 'a briefing line would render with its placeholders unfilled');
    });

    test('every stored briefing step declares both a key and its English', () => {
      const cascade = script.slice(script.indexOf('function cascade(kind, ctx){'),
                                   script.indexOf('const INTENTS = ['));
      const keyed = [...cascade.matchAll(/pkey:\s*'([a-zA-Z.]+)'/g)].length;
      const pushes = [...cascade.matchAll(/steps\.push\(/g)].length;
      assert.equal(keyed, pushes,
        `${pushes - keyed} briefing step(s) have no prose key and can never be translated`);
    });

    test('the manual and the chat both trigger a prose load', () => {
      assert.includes(script, 'I18n.loadProse()', 'nothing ever fetches the prose');
      const manualOpen = script.slice(script.indexOf('function open(){'), script.indexOf('function close(){'));
      assert.includes(manualOpen, 'loadProse', 'opening the manual does not fetch its translation');
    });
  });

  /* ------------------------------------------------------------ shadowing - */
  suite('i18n · the translator is never shadowed', () => {
    /* This shipped once: Manual declared `const t = k => CFG.THRESH[k]`, so every
       t('…') inside it returned undefined and rendered as "undefined" on screen.
       No other check would have caught it. */
    const { script } = readSource();

    test('no module declares a local named t', () => {
      // The translator's own declaration is the one legitimate `const t`.
      const decls = script.split('\n')
        .map(line => line.match(/^\s*(?:const|let|var)\s+t\s*=.*$/))
        .filter(Boolean)
        .map(m => m[0].trim())
        .filter(d => !d.startsWith('const t = (s, vars) => I18n.t('));
      assert.deepEqual(decls, [], 'a local `t` shadows the translator');
    });

    test('no function takes a parameter named t', () =>
      assert.deepEqual([...script.matchAll(/function\s+\w+\s*\(\s*t\s*[,)]/g)].map(m => m[0]), [],
        'a parameter named `t` shadows the translator'));

    test('no array callback takes a bare t parameter', () =>
      assert.deepEqual(
        [...script.matchAll(/\.\s*(?:map|forEach|filter|find|some|every)\(\s*t\s*=>/g)].map(m => m[0]), [],
        'a callback parameter named `t` shadows the translator'));

    /* The declaration guard missed a real one: a rename left `t.length` behind in
       Live.indexFor, so the clamp silently used the translator's arity (2) and
       every hourly lookup collapsed to the first two hours. Declarations are only
       half the hazard — uses are the other half. */
    test('the translator is never indexed or measured like data', () => {
      const uses = [...script.matchAll(/t\.(length|slice|map|forEach|filter|push|join|indexOf)/g)]
        .map(m => m[0]);
      assert.deepEqual(uses, [], 'the translator function is being used as if it were an array or string');
    });

    test('the translator is never subscripted', () => {
      const subs = [...script.matchAll(/t\[[^\]]+\]/g)].map(m => m[0]);
      assert.deepEqual(subs, [], 'the translator function is being indexed');
    });

    test('the manual renders no undefined, which is what shadowing looks like', () => {
      const h = boot();
      h.app.Telemetry.stop();
      h.app.Manual.open();
      assert.notIncludes(h.document.getElementById('manualDoc').innerHTML, 'undefined',
        'a shadowed translator is rendering undefined');
    });
  });

  /* ------------------------------------------------------------ document -- */
  suite('i18n · document and layout', () => {
    test('the shell hardcodes no direction', () => {
      const { html } = readSource();
      assert.notIncludes(html.slice(0, 300), 'dir="rtl"', 'direction must come from the active language');
    });

    test('apply() sets both language and direction on the document', () => {
      const h = boot();
      h.app.I18n.apply();
      assert.equal(h.document.documentElement.getAttribute('dir'), 'ltr', 'direction not applied');
      assert.ok(h.document.documentElement.getAttribute('lang'), 'lang not applied');
    });

    test('right-to-left rules exist for the physically-placed controls', () => {
      const { html } = readSource();
      ['.search-icon', '.search-geo', '.fab', '.manual-toc'].forEach(sel =>
        assert.includes(html, `[dir="rtl"] ${sel}`, `${sel} is placed physically but has no RTL rule`));
    });

    test('geography and monospace readouts are isolated from RTL', () => {
      // A map is not mirrored, and a clock that reorders its digits is unreadable.
      const { html } = readSource();
      assert.includes(html, '[dir="rtl"] #fieldMap', 'the map would be mirrored in Arabic');
      assert.includes(html, '[dir="rtl"] #missionClock', 'the clock would reorder its digits');
    });

    test('the picker offers every declared language', () => {
      const h = boot();
      h.app.Views.renderLangMenu();
      const menu = h.document.getElementById('langMenu').innerHTML;
      h.app.I18n.LANGS.forEach(l =>
        assert.includes(menu, `data-lang="${l.code}"`, `${l.code} is missing from the picker`));
    });

    /* Each option is stamped with its own script direction so an endonym renders
       correctly inside the menu regardless of the page direction. All four
       shipping languages are left-to-right today; the attribute is what makes
       adding a right-to-left one a catalogue change rather than a code change. */
    test('each option carries its own script direction', () => {
      const h = boot();
      h.app.Views.renderLangMenu();
      const menu = h.document.getElementById('langMenu').innerHTML;
      h.app.I18n.LANGS.forEach(l =>
        assert.includes(menu, `data-dir="${l.dir}"`, `${l.code} option has no direction`));
    });

    test('typing in each language reaches the right intent', async () => {
      /* One representative phrase per language, checked against the live
         matcher rather than against the keyword list, so the whole path is
         exercised. */
      const PHRASES = {
        es: ['humedad del suelo', 'moisture'],
        fr: ['humidité du sol', 'moisture'],
        pt: ['umidade do solo', 'moisture'],
      };
      for (const [code, [phrase, want]] of Object.entries(PHRASES)) {
        const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', code + '.json'), 'utf8'));
        const hay = phrase.toLowerCase();
        const hit = Object.keys(cat.intents).find(id =>
          cat.intents[id].some(w => hay.includes(w.toLowerCase())));
        assert.equal(hit, want, `"${phrase}" (${code}) would fall through to the fallback reply`);
      }
    });

    test('English keywords keep working in every language', () => {
      const h = boot();
      assert.equal(h.app.Console.match('soil moisture'), 'moisture',
        'English must stay matchable — the quick-reply buttons send it');
    });

    test('place names are requested in the active language', () => {
      const { script } = readSource();
      assert.includes(script, 'language=${encodeURIComponent(I18n.lang())}',
        'the geocoder would always answer in English');
    });

    /* The chat matcher works on English. A quick-reply button therefore DISPLAYS
       the translation but must SEND the original, or every button breaks the
       moment someone switches language. */
    test('quick replies display the translation but send English', () => {
      const { script } = readSource();
      assert.includes(script, 'data-quick="${esc(q)}">${esc(t(q))}',
        'the button either sends a translated string or displays an untranslated one');
    });

    test('every quick reply still resolves to an intent in every language', () => {
      const h = boot();
      Object.values(h.app.Views.QUICK).flat().forEach(q =>
        assert.ok(h.app.Console.match(q), `"${q}" no longer matches an intent`));
    });

    test('the locale catalogues are precached for offline use', () => {
      const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
      const h = boot();
      h.app.I18n.LANGS.filter(l => l.code !== 'en').forEach(l =>
        assert.includes(sw, `./i18n/${l.code}.json`,
          `${l.code} would fall back to English the moment the network drops`));
    });

    test('an unreviewed translation is badged rather than presented as finished', () => {
      const { script } = readSource();
      assert.includes(script, 'translationBadge', 'no badge function');
      assert.includes(script, 'not reviewed by a native speaker', 'the caveat is stated nowhere');
    });
  });
};
