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
    /* Two more shapes carry English source that is translated at paint time
       rather than at the call: seg('…') inside a stored line, and the {t:'…'}
       variable form. Both are as real as a t() call, and a catalogue key that
       matches one of them is not stale. */
    for (const m of script.matchAll(/\bseg\(\s*'((?:[^'\\]|\\.)*)'/g)) set.add(m[1].replace(/\\'/g, "'"));
    for (const m of script.matchAll(/\{\s*t:\s*'((?:[^'\\]|\\.)*)'/g)) set.add(m[1].replace(/\\'/g, "'"));
    for (const m of markup.matchAll(/data-i18n[^>]*>([^<]+)</g)) set.add(m[1].trim());
    const tables = [/label:'([^']+)',\s+unit/g, /word:'([^']+)'/g, /label:'([^']+)',\s+glyph/g,
                    /note:'([^']+)'/g, /label:'([^']+)', severity/g, /product:'([^']+)'/g,
                    /nav:'([^']+)', title:'([^']+)'/g, /title:'([^']+)',\s*$/gm,
                    /name:'([A-Z][a-z]+)',\s+endonym/g,
                    /label:'([^']+)', product:'([^']+)'/g,    // satellite layers
                    /name:'([^']+)',\s*kind:/g,               // map node labels, via t(n.name)
                    /\bsub:'([^']+)'/g,                       // and their subtitles
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
    /* The opening exchange stores English source too, and its lines carry no
       prose key to find them by. Only the sentences are wanted: the rest of the
       literals in that function are participant ids and the separators between
       segments, which are punctuation and units, not translatable text. */
    for (const m of block('function greet(){', 'return { post,')
      .matchAll(/(?:text:\s*|post\('SYSTEM',\s*)'((?:[^'\\]|\\.)*)'/g))
      set.add(m[1].replace(/\\'/g, "'"));

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

    test('every declared language has a code, locale, name and endonym', () =>
      I18n.LANGS.forEach(l => {
        assert.ok(/^[a-z]{2}$/.test(l.code), `bad code ${l.code}`);
        assert.ok(l.locale && l.name && l.endonym, `${l.code} is missing metadata`);
      }));

    test('language codes are unique', () => {
      const c = I18n.LANGS.map(l => l.code);
      assert.equal(new Set(c).size, c.length, 'duplicate language code');
    });

    /* The picker is the whole language surface. Anything offered here must have
       a catalogue, and anything with a catalogue must be offered — the two are
       checked against each other in the catalogue suite. Four is the set. */
    test('exactly the four maintained languages are offered', () =>
      assert.deepEqual(I18n.LANGS.map(l => l.code), ['en', 'es', 'pt', 'fr'],
        'the picker offers a language the system no longer maintains'));

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
            /* Keywords are matched as substrings, so a single letter would fire
               on almost any sentence. Two is the floor rather than one because
               every shipping language is latin-script — and two is genuinely
               needed: French "où" is the whole question. */
            assert.ok(w.trim().length >= 2, `${id} keyword "${w}" is too short and would match noise`);
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

    /* The segment helpers are the same hazard one level down: a local `val` or
       `node` would turn a stored line into whatever that local happens to be,
       and the line would still render — just wrong, and only in one language.
       They are named for uniqueness, and this is what keeps them unique. */
    test('nothing shadows the segment helpers', () => {
      ['seg', 'mapNode', 'amount', 'instant'].forEach(name => {
        const decls = script.split('\n')
          .map(line => line.match(new RegExp(`^\\s*(?:const|let|var)\\s+${name}\\s*[=\\s]`)))
          .filter(Boolean).length;
        assert.equal(decls, 1, `${name} is declared more than once — one of them shadows the helper`);
        assert.deepEqual(
          [...script.matchAll(new RegExp(`function\\s+\\w+\\s*\\(\\s*${name}\\s*[,)]`, 'g'))].map(m => m[0]), [],
          `a parameter named ${name} shadows the helper`);
      });
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
    test('apply() puts the active locale on the document', () => {
      const h = boot();
      h.app.I18n.apply();
      assert.equal(h.document.documentElement.getAttribute('lang'), 'en', 'lang not applied');
    });

    /* Every shipping language is left-to-right, so nothing in the app carries a
       direction any more. A stray `dir` would be a leftover from a language that
       no longer exists, and would quietly re-mirror the layout if one came back
       without the stylesheet rules that used to accompany it. */
    test('no direction survives anywhere in the shell', () => {
      const { html } = readSource();
      assert.notIncludes(html, 'dir="rtl"', 'a right-to-left rule outlived its language');
      assert.notIncludes(html, 'data-dir', 'the picker still stamps a script direction');
      assert.notIncludes(html, 'unicode-bidi', 'bidi isolation is left over from a dropped language');
    });

    test('the picker offers every declared language', () => {
      const h = boot();
      h.app.Views.renderLangMenu();
      const menu = h.document.getElementById('langMenu').innerHTML;
      h.app.I18n.LANGS.forEach(l =>
        assert.includes(menu, `data-lang="${l.code}"`, `${l.code} is missing from the picker`));
    });

    /* Each option is tagged with its own locale so a screen reader pronounces
       "Português" as Portuguese rather than as English. */
    test('each option declares its own locale', () => {
      const h = boot();
      h.app.Views.renderLangMenu();
      const menu = h.document.getElementById('langMenu').innerHTML;
      h.app.I18n.LANGS.forEach(l =>
        assert.includes(menu, `lang="${l.locale}"`, `${l.code} option has no locale`));
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

  /* ------------------------------------------------ the chat follows it --- */
  /* A line is composed when it is said but READ when it is painted, and these
     are the checks that keep those two moments apart. Every one of them switches
     language AFTER the transcript already exists — the case that used to strand
     it, because an answer assembled with t() had already collapsed into one
     finished Spanish-or-English string that no later repaint could undo. */
  suite('i18n · the chat follows the language', () => {
    /* Serves the shipped catalogues off disk, so switching language in a test
       loads exactly the JSON a browser would. */
    const served = () => url => {
      const file = path.join(ROOT, String(url).replace(/^\.?\//, ''));
      if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404 });
      return Promise.resolve({ ok: true, status: 200,
        json: () => Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8'))) });
    };

    const ES = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', 'es.json'), 'utf8')).strings;
    // The Spanish of a key, up to its first placeholder — enough to identify the
    // sentence on screen without depending on the numbers spliced into it.
    const stem = key => (ES[key] || key).split('{')[0].trim();

    /* Boot, let the opening exchange finish draining, then ask — otherwise the
       greeting's own queued lines arrive after the answer and the last message
       in the transcript is not the one under test. */
    async function asked(question) {
      const h = boot({ fetch: served() });
      h.app.Telemetry.stop();
      await h.advance(20000);
      const from = h.app.State.data.chat.length;
      h.app.Console.handleUserMessage(question);
      await h.advance(8000);
      h.answer = h.app.State.data.chat.slice(from).find(m => m.from === 'BOT');
      return h;
    }
    // What the picker does: load the catalogue, then repaint everything.
    async function switchTo(h, code) {
      await h.app.I18n.set(code);
      h.app.Views.repaintAll();
      await h.advance(200);          // let the prose fetch land
    }

    test('an answer given in English is reread in Spanish', async () => {
      const h = await asked('soil moisture');
      const m = h.answer;
      const english = h.app.Views.msgText(m);
      await switchTo(h, 'es');
      const spanish = h.app.Views.msgText(m);
      assert.notEqual(spanish, english, 'the answer stayed in the language it was written in');
      assert.includes(spanish, stem('Plot F-2 root-zone moisture is {pct}% ({src}, {ts} UTC).'),
        'the answer did not retranslate');
      assert.notIncludes(spanish, 'root-zone moisture is', 'English survived the switch');
    });

    test('the readout under an answer retranslates with it', async () => {
      const h = await asked('soil moisture');
      const m = h.answer;
      await switchTo(h, 'es');
      const kv = h.app.Views.segText(m.kv);
      assert.includes(kv, ES['field mean'], 'the readout kept its English labels');
      assert.notIncludes(kv, 'field mean', 'an English label survived in the readout');
    });

    test('a reading frozen into an answer is not retranslated along with it', async () => {
      const h = await asked('soil moisture');
      const m = h.answer;
      const pct = h.app.Views.segText(m.kv).match(/(\d+[.,]\d)%/);
      await switchTo(h, 'es');
      assert.ok(pct, 'no reading in the readout to begin with');
      assert.includes(h.app.Views.segText(m.kv), pct[1].replace('.', ','),
        'the number changed with the language — it is a record, not a live value');
    });

    /* Map labels are not translated anywhere in this app — the map itself draws
       them as they come — so a waypoint chain is not a language surface. What it
       must not be is a frozen COPY: the line stores node ids and reads the
       labels back, so the transcript and the map cannot disagree about where the
       driver is going. Changing region is what makes the difference visible. */
    test('a waypoint chain is read back from the map, not copied into the line', async () => {
      const h = await asked('route check');
      const kv = () => h.app.Views.segText(h.answer.kv);
      assert.includes(kv(), 'Somanya Depot', 'no waypoint chain to check');
      h.app.Region.load('nigeria-oyo');
      assert.includes(kv(), 'Ojoo Depot', 'the chain is a stale copy of labels the map no longer shows');
    });

    test('a distance inside a stored line follows the locale', async () => {
      const h = await asked('route check');
      assert.ok(/\d\.\d km/.test(h.app.Views.segText(h.answer.kv)), 'no distance to check');
      await switchTo(h, 'es');
      const kv = h.app.Views.segText(h.answer.kv);
      assert.ok(/\d,\d km/.test(kv), `the decimal separator stayed English: ${kv}`);
      assert.ok(!/\d\.\d km/.test(kv), `an English decimal separator survived the switch: ${kv}`);
    });

    test('what the user typed is never translated', async () => {
      const h = await asked('soil moisture');
      const mine = h.app.State.data.chat.find(m => m.mine);
      await switchTo(h, 'es');
      assert.equal(h.app.Views.msgText(mine), 'soil moisture',
        'the app translated the words the user typed');
    });

    /* The prose catalogue is fetched separately and lands AFTER the repaint that
       the language switch triggers. Without a second repaint on arrival, every
       briefing line in the transcript sits in English until something unrelated
       happens to redraw it. */
    test('briefing lines repaint when the prose arrives', async () => {
      const h = boot({ fetch: served() });
      h.app.Telemetry.stop();
      h.app.Console.cascade('FROST', { cut: 20 });
      await h.advance(20000);
      h.app.Views.renderChat();
      const before = h.document.getElementById('chatStream').innerHTML;
      assert.includes(before, 'FROST EVENT', 'the briefing never ran');
      await switchTo(h, 'es');
      const after = h.document.getElementById('chatStream').innerHTML;
      assert.notIncludes(after, 'FROST EVENT', 'the briefing stayed English after the prose landed');
    });

    test('no reply is finished at the moment it is written', () => {
      const { script } = readSource();
      const body = script.slice(script.indexOf('function reply(intent, persona){'),
                                script.indexOf('function handleUserMessage('));
      assert.deepEqual([...body.matchAll(/[^.\w]t\(/g)].map(m => m[0].trim()), [],
        'a reply is calling the translator at write time, which freezes it in that language');
    });

    /* An advisory outlives the moment it armed — it sits on the hero and on the
       role cards until the metric recovers — so it is the surface where a
       sentence frozen at write time survives longest and reads worst. */
    async function armFrost() {
      const h = boot({ fetch: served() });
      h.app.Telemetry.stop();
      Object.assign(h.app.State.data.latest, { temp: 24, moisture: 32, ndvi: 0.63, traff: 90 });
      for (let i = 0; i < 4; i++) h.app.EventEngine.evaluate();
      Object.assign(h.app.State.data.latest, { temp: -5 });
      h.app.EventEngine.evaluate();
      await h.advance(2000);
      return h;
    }

    test('an advisory armed in English reads in Spanish', async () => {
      const h = await armFrost();
      const a = h.app.State.data.alerts.get('FROST_EVENT');
      assert.ok(a, 'no advisory armed');
      assert.ok(!('detail' in a), 'the advisory still stores a finished sentence');
      const english = h.app.I18n.t(a.detailKey, a.vars);
      await switchTo(h, 'es');
      const spanish = h.app.I18n.t(a.detailKey, a.vars);
      assert.notEqual(spanish, english, 'the advisory stayed in the language it armed in');
      assert.includes(spanish, stem('Surface temperature {temp}°C — at or below the {floor}°C frost floor.'),
        'the advisory did not retranslate');
      assert.ok(/-5,0|\d,\d/.test(spanish), `the reading kept an English decimal separator: ${spanish}`);
    });

    test('the advisory card and the hero note are painted in the active language', async () => {
      const h = await armFrost();
      h.app.Views.setRole('FARMER');
      await switchTo(h, 'es');
      h.app.Views.setRole('FARMER');
      const card = h.document.getElementById('paneFarmer').innerHTML;
      assert.includes(card, ES['Frost event'], 'the card chip kept the English rule name');
      assert.notIncludes(card, 'Frost event', 'an English rule name survived on the card');
      assert.notIncludes(card, 'Surface temperature', 'an English advisory sentence survived on the card');
      assert.equal(h.document.getElementById('heroNote').textContent,
        h.app.I18n.t(h.app.State.data.alerts.get('FROST_EVENT').detailKey,
                     h.app.State.data.alerts.get('FROST_EVENT').vars),
        'the hero note disagrees with the advisory it is showing');
    });

    /* The DOM walk the README claims, run rather than described. Every pane is
       rendered in every language with a field in trouble, so each conditional
       branch is on screen, and every catalogue key that changes under
       translation must be absent in its English form. This is what caught the
       role panes and the map labels; it is here so they cannot come back. */
    ['es', 'pt', 'fr'].forEach(code => {
      test(`no English survives in the ${code} role panes`, async () => {
        const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', code + '.json'), 'utf8')).strings;
        const h = boot({ fetch: served() });
        h.app.Telemetry.stop();
        Object.assign(h.app.State.data.latest, { temp: -6, moisture: 8, ndvi: 0.2, traff: 10 });
        for (let i = 0; i < 4; i++) h.app.EventEngine.evaluate();
        await h.advance(3000);
        await switchTo(h, code);

        /* A key with a placeholder can only be matched on a fragment, and a
           fragment is not evidence; nor is a translation that contains its own
           English word — French "cellule" holds "cell". */
        const rx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const testable = Object.keys(cat).filter(k =>
          cat[k] !== k && k.length > 3 && !k.includes('{') &&
          !cat[k].toLowerCase().includes(k.toLowerCase()));

        const leaks = [];
        ['FARMER', 'BUYER', 'DRIVER'].forEach(role => {
          h.app.Views.setRole(role);
          const text = ' ' + (h.document.getElementById('pane' + role[0] + role.slice(1).toLowerCase()).innerHTML || '')
            .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ') + ' ';
          testable.forEach(k => {
            if (new RegExp(`(^|[^\\p{L}])${rx(k)}([^\\p{L}]|$)`, 'u').test(text))
              leaks.push(`${role}: ${k}`);
          });
        });
        assert.deepEqual([...new Set(leaks)].slice(0, 5), [],
          `English on screen in ${code}, out of ${testable.length} translatable strings`);
      });
    });

    test('map labels are drawn in the active language', async () => {
      const h = boot({ fetch: served() });
      h.app.Telemetry.stop();
      await switchTo(h, 'es');
      const svg = h.document.getElementById('fieldMap').innerHTML;
      assert.includes(svg, ES['Plot F-2'], 'the map kept its English plot labels');
      assert.notIncludes(svg, 'Plot F-2', 'an English plot label survived on the map');
      assert.notIncludes(svg, 'Jct N', 'an English junction label survived on the map');
      // A hub with a real name keeps it: a proper noun is not translated anywhere.
      assert.includes(svg, 'Terrace Kitchen', 'a proper noun was translated');
    });

    test('the all-clear state is translated too, not just the alarm', async () => {
      const h = boot({ fetch: served() });
      h.app.Telemetry.stop();
      await switchTo(h, 'es');
      assert.equal(h.app.State.data.alerts.size, 0, 'something is advising, so this is not the all-clear');
      assert.includes(h.document.getElementById('heroNote').textContent,
        stem('All four orbital feeds within nominal bands. No autonomous interventions active.'),
        'the all-clear line is still English');
    });
  });
};
