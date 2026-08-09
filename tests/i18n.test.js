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

    test('Arabic and Urdu are marked right-to-left', () =>
      ['ar', 'ur'].forEach(c => assert.equal(I18n.langFor(c).dir, 'rtl', `${c} must be RTL`)));

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
      const h2 = boot({ storage: { 'aura-lang': 'sw' } });
      assert.equal(h2.app.I18n.initial(), 'sw', 'the saved language was ignored');
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

      test(`${code}: covers the whole UI`, () =>
        assert.equal(Object.keys(json.strings).length, strings.size,
          `missing ${strings.size - Object.keys(json.strings).length} of ${strings.size} strings`));

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

      test(`${code}: coverage metadata matches the file`, () => {
        const actual = Object.keys(json.strings).length / strings.size;
        assert.close(json.meta.coverage, actual, 0.02,
          'the badge would report a coverage the file does not have');
      });

      test(`${code}: contains no markup`, () =>
        Object.entries(json.strings).forEach(([k, v]) =>
          assert.notIncludes(v, '<', `"${k}" contains HTML, which is escaped and shown literally`)));
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

    test('each option carries its own script direction', () => {
      const h = boot();
      h.app.Views.renderLangMenu();
      assert.includes(h.document.getElementById('langMenu').innerHTML, 'data-dir="rtl"',
        'RTL endonyms would render in the wrong direction inside an LTR menu');
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
