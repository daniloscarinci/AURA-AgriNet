/* PWA asset integrity.

   An offline-first app fails in exactly one way that no logic test catches: the
   shell references something the service worker does not precache, or precaches
   something that is not on disk. `cache.addAll` is atomic, so a single bad path
   fails the whole install and the app silently never works offline. These checks
   are cheap and they are the ones that would actually have bitten. */
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, readSource, boot } = require('./harness');
const vm = require('vm');

module.exports = ({ suite, test, assert }) => {

  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const exists = f => fs.existsSync(path.join(ROOT, f.replace(/^\.\//, '')));
  const bytes = f => fs.statSync(path.join(ROOT, f.replace(/^\.\//, ''))).size;

  /* ------------------------------------------------------------------------ */
  suite('assets · files on disk', () => {
    const required = [
      'index.html', 'app.css', 'sw.js', 'manifest.webmanifest', 'serve.cmd', 'README.md',
      'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
      'icons/apple-touch-icon-180.png',
    ];
    required.forEach(f => {
      test(`${f} exists`, () => assert.ok(exists(f), `${f} missing from the repo`));
      test(`${f} is not empty`, () => assert.greater(bytes(f), 0, `${f} is zero bytes`));
    });

    test('index.html is a single self-contained document', () => {
      const { html } = readSource();
      assert.ok(html.startsWith('<!DOCTYPE html>'), 'missing doctype');
      assert.includes(html, '</html>', 'document not closed');
    });
  });

  /* ------------------------------------------------------------------------ */
  suite('assets · service worker precache', () => {
    const sw = read('sw.js');
    const list = sw.match(/const PRECACHE = \[([\s\S]*?)\]/);

    test('sw.js declares a PRECACHE list', () => assert.ok(list, 'PRECACHE array not found'));

    const entries = list ? [...list[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

    test('PRECACHE is non-empty', () => assert.greater(entries.length, 0, 'nothing precached'));

    entries.filter(e => e !== './').forEach(e => {
      test(`precached ${e} exists on disk`, () =>
        assert.ok(exists(e), `sw.js precaches ${e} but it is not in the repo — cache.addAll is atomic, so install would fail`));
    });

    test('PRECACHE includes the navigation root', () =>
      assert.includes(entries, './', 'no "./" entry, so a cold start at the root cannot be served offline'));

    test('PRECACHE includes index.html', () =>
      assert.includes(entries, './index.html', 'the shell itself is not precached'));

    test('PRECACHE includes the stylesheet', () =>
      assert.includes(entries, './app.css', 'app.css is not precached, so an offline launch renders unstyled'));

    test('PRECACHE includes the manifest', () =>
      assert.includes(entries, './manifest.webmanifest', 'manifest not precached'));

    test('PRECACHE has no duplicates', () => {
      const dupes = entries.filter((e, i) => entries.indexOf(e) !== i);
      assert.deepEqual(dupes, [], 'duplicate precache entries');
    });

    test('every local asset the shell references is precached', () => {
      const { markup } = readSource();
      const refs = [...markup.matchAll(/(?:href|src)="(?!https?:|data:|#|mailto:|\?)([^"]+)"/g)].map(m => m[1]);
      const missing = [...new Set(refs.filter(r => r !== '.'))]
        .map(r => './' + r.replace(/^\.\//, ''))
        .filter(r => !entries.includes(r));
      assert.deepEqual(missing, [], 'referenced by index.html but absent from PRECACHE — these 404 offline');
    });

    test('cache version is bumped past the default', () => {
      const v = sw.match(/CACHE_VERSION\s*=\s*'([^']+)'/);
      assert.ok(v, 'CACHE_VERSION not found');
      assert.ok(/^aura-v\d+$/.test(v[1]), `CACHE_VERSION ${JSON.stringify(v && v[1])} does not match aura-vN`);
    });

    test('activate purges caches from older versions', () =>
      assert.includes(sw, 'keys.filter(k => !k.startsWith(CACHE_VERSION))',
        'stale caches are never deleted, so old shells linger forever'));

    test('runtime caches are keyed off the shell version', () => {
      // Otherwise a deploy leaves last version's observations behind and the
      // activate purge cannot find them.
      assert.includes(sw, "CACHE_VERSION + '-data'", 'data cache not versioned');
      assert.includes(sw, "CACHE_VERSION + '-tiles'", 'tile cache not versioned');
    });

    test('fetch handler ignores non-GET requests', () =>
      assert.includes(sw, "req.method !== 'GET'", 'non-GET requests would be cached'));

    test('only allowlisted cross-origin hosts are cached', () => {
      assert.includes(sw, 'url.origin !== self.location.origin', 'unlisted cross-origin responses could be cached');
      const data = sw.match(/const DATA_HOSTS\s*=\s*\[([^\]]+)\]/);
      const tiles = sw.match(/const TILE_HOSTS\s*=\s*\[([^\]]+)\]/);
      assert.ok(data && tiles, 'host allowlists not declared');
      const hosts = [...(data[1] + tiles[1]).matchAll(/'([^']+)'/g)].map(m => m[1]);
      const ALLOWED = ['api.open-meteo.com','flood-api.open-meteo.com','geocoding-api.open-meteo.com','gibs.earthdata.nasa.gov'];
      assert.deepEqual(hosts.filter(h => !ALLOWED.includes(h)), [], 'the worker caches an undeclared host');
    });

    test('observations are network-first and imagery is cache-first', () => {
      // Backwards would be a real failure: a grower would act on yesterday's
      // soil moisture, and immutable tiles would be re-fetched every paint.
      const dataBlock = sw.slice(sw.indexOf('DATA_HOSTS.includes'), sw.indexOf('TILE_HOSTS.includes'));
      const tileBlock = sw.slice(sw.indexOf('TILE_HOSTS.includes'));
      assert.less(dataBlock.indexOf('await fetch(req)'), dataBlock.indexOf('cache.match(req)'),
        'observation requests hit the cache before the network');
      assert.less(tileBlock.indexOf('cache.match(req)'), tileBlock.indexOf('await fetch(req)'),
        'imagery requests hit the network before the cache');
    });

    test('the tile cache is bounded', () =>
      assert.includes(sw, 'TILE_LIMIT', 'imagery would grow without limit on disk'));

    test('navigation requests fall back to the cached shell', () =>
      assert.includes(sw, "req.mode === 'navigate'", 'deep links would 404 offline'));

    test('a cache miss while offline returns a real Response, not a throw', () =>
      assert.includes(sw, 'status: 503', 'an uncached asset would reject the fetch instead of failing softly'));
  });

  /* ------------------------------------------------------------------------ */
  suite('assets · web app manifest', () => {
    const raw = read('manifest.webmanifest');
    let mf = null;

    test('manifest is valid JSON', () => { mf = JSON.parse(raw); assert.ok(mf, 'parse returned nothing'); });

    mf = JSON.parse(raw);

    ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'theme_color', 'background_color', 'icons']
      .forEach(k => test(`manifest declares ${k}`, () => assert.ok(mf[k] !== undefined, `${k} missing`)));

    test('short_name fits a home-screen label (≤12 chars)', () =>
      assert.ok(mf.short_name.length <= 12, `short_name is ${mf.short_name.length} chars and will be truncated`));

    test('display is a standalone mode', () =>
      assert.includes(['standalone', 'fullscreen', 'minimal-ui'], mf.display, 'display mode would open in a browser tab'));

    test('theme_color matches the light-scheme meta tag in the shell', () => {
      // Two theme-color metas now: one per colour scheme. The manifest carries a
      // single value, and it must be the light one -- that is what an installer
      // paints the splash and task switcher with before any scheme is known.
      const { markup } = readSource();
      const metas = [...markup.matchAll(/<meta name="theme-color" content="([^"]+)"(?:\s+media="([^"]+)")?/g)];
      assert.greater(metas.length, 0, 'no theme-color meta tag');
      const light = metas.find(m => !m[2] || m[2].includes('light')) || metas[0];
      assert.equal(light[1].toLowerCase(), mf.theme_color.toLowerCase(),
        'manifest and meta tag disagree, so the status bar colour changes on install');
    });

    test('a theme-color is declared for each colour scheme', () => {
      const { markup } = readSource();
      const metas = [...markup.matchAll(/<meta name="theme-color"[^>]*>/g)].map(m => m[0]);
      assert.ok(metas.some(m => m.includes('light')), 'no light-scheme theme colour');
      assert.ok(metas.some(m => m.includes('dark')), 'no dark-scheme theme colour');
    });

    mf.icons.forEach(icon => {
      test(`icon ${icon.src} exists`, () => assert.ok(exists(icon.src), `${icon.src} declared but not on disk`));
      test(`icon ${icon.src} declares a type`, () => assert.equal(icon.type, 'image/png', 'unexpected icon type'));
      test(`icon ${icon.src} sizes look like WxH`, () => assert.ok(/^\d+x\d+$/.test(icon.sizes), `bad sizes ${icon.sizes}`));
      test(`icon ${icon.src} is a real PNG`, () => {
        const buf = fs.readFileSync(path.join(ROOT, icon.src));
        assert.equal(buf.slice(1, 4).toString('ascii'), 'PNG', 'file does not carry a PNG signature');
      });
      test(`icon ${icon.src} dimensions match its declared size`, () => {
        const buf = fs.readFileSync(path.join(ROOT, icon.src));
        // IHDR width/height live at byte offsets 16 and 20, big-endian.
        const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
        assert.equal(`${w}x${h}`, icon.sizes, `${icon.src} is ${w}x${h} but declares ${icon.sizes}`);
      });
    });

    test('a maskable icon is provided', () =>
      assert.ok(mf.icons.some(i => String(i.purpose).includes('maskable')),
        'no maskable icon, so Android crops the square badge'));

    test('a 192px icon is provided (Android home screen minimum)', () =>
      assert.ok(mf.icons.some(i => i.sizes === '192x192'), 'no 192x192 icon'));

    test('a 512px icon is provided (splash screen)', () =>
      assert.ok(mf.icons.some(i => i.sizes === '512x512'), 'no 512x512 icon'));

    test('apple-touch-icon is linked in the shell', () => {
      const { markup } = readSource();
      assert.includes(markup, 'rel="apple-touch-icon"', 'iOS would rasterise a screenshot instead');
    });

    mf.shortcuts.forEach(sc => {
      test(`shortcut "${sc.short_name}" targets a role deep link`, () =>
        assert.ok(/^\.\/\?role=[A-Z]+$/.test(sc.url), `shortcut url ${sc.url} is not a ./?role= deep link`));
      test(`shortcut "${sc.short_name}" has a name and description`, () => {
        assert.ok(sc.name && sc.name.length, 'missing name');
        assert.ok(sc.description && sc.description.length, 'missing description');
      });
    });
  });

  /* ------------------------------------------------------------------------ */
  suite('assets · offline independence', () => {
    const { html } = readSource();
    const css = read('app.css');

    test('the shell loads nothing from a remote origin', () => {
      const remote = [...html.matchAll(/(?:href|src)="(https?:)?\/\/[^"]+"/g)].map(m => m[0]);
      assert.deepEqual(remote, [], 'a remote asset means the app is not offline-capable');
    });

    test('no CDN script tags survive in the shell', () =>
      assert.notIncludes(html, 'cdn.tailwindcss.com', 'the Tailwind CDN would break offline layout'));

    test('the stylesheet imports nothing remote', () => {
      assert.notIncludes(css, '@import url(http', 'remote @import');
      assert.notIncludes(css, 'fonts.googleapis', 'remote webfont');
    });

    /* The app DOES call the network now. What must stay true is narrower and
       more important: every host it reaches is keyless and declared, no
       credential ever appears in the source, and the shell still boots and
       renders with every one of them unreachable. */
    test('every remote host called is on the declared allowlist', () => {
      const { script } = readSource();
      const ALLOWED = [
        'api.open-meteo.com', 'flood-api.open-meteo.com', 'geocoding-api.open-meteo.com',
        'gibs.earthdata.nasa.gov',
      ];
      const hosts = [...new Set([...script.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map(m => m[1]))];
      const rogue = hosts.filter(h => !ALLOWED.includes(h));
      assert.deepEqual(rogue, [], 'an undeclared host is being contacted');
    });

    test('no API key, token or secret is embedded in the source', () => {
      const { script } = readSource();
      const suspicious = [...script.matchAll(/(api[_-]?key|access[_-]?token|client[_-]?secret|bearer)\s*[:=]\s*['"][^'"]{8,}/gi)];
      assert.deepEqual(suspicious.map(m => m[0].slice(0, 40)), [],
        'a credential in a static file is public — this app must stay keyless');
    });

    test('every declared host is reached over https', () => {
      const { script } = readSource();
      assert.deepEqual([...script.matchAll(/http:\/\/(?!localhost)[a-z0-9.-]+/g)].map(m => m[0]), [],
        'plaintext http request');
    });

    test('the service worker registers only over http(s)', () => {
      const { script } = readSource();
      assert.includes(script, "location.protocol.startsWith('http')",
        'registering over file:// throws an unhandled SecurityError');
    });

    test('viewport meta allows a mobile layout', () =>
      assert.includes(html, 'width=device-width', 'no responsive viewport'));

    test('the document declares a language', () =>
      assert.includes(html, '<html lang="en"', 'no lang attribute hurts screen readers'));

    test('the document has a non-empty title', () => {
      const t = html.match(/<title>([^<]+)<\/title>/);
      assert.ok(t && t[1].trim().length > 0, 'missing or empty <title>');
    });

    test('a meta description is present', () =>
      assert.includes(html, '<meta name="description"', 'no meta description'));

    /* The curated city list is the only part of location search that works with
       no network, which is worth nothing if the rows are wrong: every one of
       these coordinates is fetched real weather for. They were resolved once
       against the geocoder rather than written from memory, and this is what
       stops a hand-edit putting a city in the sea. */
    suiteCities();
    function suiteCities() {
      const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'cities.json'), 'utf8'));

      test('cities.json declares what it holds', () => {
        assert.ok(Array.isArray(cities.cities), 'no cities array');
        assert.greater(cities.cities.length, 100, 'too few to be worth browsing');
        assert.equal(cities.meta.count, cities.cities.length, 'meta.count disagrees with the rows');
      });

      test('every city row is complete and on Earth', () => {
        const bad = cities.cities.filter(c =>
          c.length !== 7 || !c[0] || !/^[A-Z]{2}$/.test(c[2]) ||
          typeof c[3] !== 'number' || Math.abs(c[3]) > 90 ||
          typeof c[4] !== 'number' || Math.abs(c[4]) > 180 ||
          typeof c[5] !== 'number');
        assert.deepEqual(bad.slice(0, 3), [], 'malformed rows — a bad coordinate fetches the wrong weather');
      });

      test('no city appears twice', () => {
        const keys = cities.cities.map(c => c[0] + '|' + c[2]);
        assert.equal(new Set(keys).size, keys.length, 'a duplicate would appear twice in the list');
      });

      /* Not a population ranking — the point of curating it. But it must not be
         parochial either: a list that cannot reach a grower is no use to them. */
      test('the list spans the world, not one continent', () =>
        assert.greater(new Set(cities.cities.map(c => c[2])).size, 60,
          'too few countries for a list that claims to be worldwide'));

      test('cities.json is precached, or it is useless offline', () => {
        const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
        const precache = (sw.match(/const PRECACHE = \[([\s\S]*?)\]/) || [, ''])[1];
        assert.includes(precache, './cities.json',
          'the city list is fetched but not precached, so offline it 404s and the list is empty');
      });

      test('the list stays small enough to precache', () =>
        assert.less(bytes('cities.json'), 120 * 1024,
          'the city list has grown past a reasonable share of the install'));
    }

    /* Tailwind here is PREBUILT and committed, and there is no build step, so a
       utility class that was not in the source when app.css was compiled is
       silently inert: it reads correctly in the markup and does nothing on
       screen. Six were shipping that way, and `gap-5` is why the driver's
       distance and drive time ran together. Nothing else can catch this --
       every test that reads the DOM sees the class attribute, not the rule. */
    /* A headline and the status beside it must never resolve by running off the
       edge of the card. Layout cannot be measured against a stub DOM, so what
       is checked here is the contract that produces it: the stat tiles stack
       unconditionally, so every tile in the row shares one baseline whatever
       the language, and the single-title headers wrap rather than overflow. */
    test('headlines resolve downwards, not sideways', () => {
      const style = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
      const tile = style.match(/\.tile-head\{([^}]*)\}/);
      assert.ok(tile, 'the tile headline has no rule of its own');
      assert.includes(tile[1], 'flex-direction:column',
        'the tile headline puts its chip beside the label, so a long status overflows the card');
      ['.panel-head', '.mcard-head', '.agro-head', '.persona-row', '.tile-body'].forEach(sel => {
        const rule = style.match(new RegExp(`${sel.replace('.', '\\.')}[^{]*\\{([^}]*)\\}`, 'g')) || [];
        assert.ok(rule.some(r => r.includes('flex-wrap:wrap')),
          `${sel} cannot wrap, so a long title pushes its neighbour off the edge`);
      });

      /* A chip is the widest thing in a headline and the one most likely to
         leave the card: every language has an alert wording that does not fit
         a tile on a 360px phone, English included. */
      const chip = style.match(/\.chip\{([^}]*)\}/);
      assert.ok(chip, 'no chip rule');
      assert.includes(chip[1], 'max-width:100%', 'a chip can grow wider than the card it labels');
      assert.notIncludes(chip[1], 'white-space:nowrap',
        'a chip that cannot wrap can only resolve by overflowing');
    });

    test('every class the app uses is defined in a stylesheet', () => {
      const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
      const inline = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
      const sheets = css + '\n' + inline;

      const used = new Set();
      for (const m of html.matchAll(/class="([^"]*)"/g))
        for (const c of m[1].split(/\s+/))
          // Template literals put JS between the quotes; only real class names.
          if (/^[a-zA-Z][\w:.\/[\]%-]*$/.test(c)) used.add(c);

      const undefined_ = [...used].filter(c => {
        // Tailwind escapes . : / [ ] in its selectors: .max-h-\[260px\]
        const esc = [...c].map(ch => /[\w-]/.test(ch) ? ch : '\\\\?\\' + ch).join('');
        return !new RegExp('\\.' + esc + '(?![\\w-])').test(sheets);
      });
      assert.deepEqual(undefined_.sort().slice(0, 6), [],
        'class names that style nothing — app.css is prebuilt, so a new utility must be written by hand');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The APK carries a copy of this directory, and that copy is defined by
     exclusion. So the danger is not a forgotten include — it is an exclude
     pattern that quietly swallows something sw.js precaches. cache.addAll is
     atomic, so such a package installs, launches, and then dies the first time
     the phone loses signal. The cheapest guard against the worst failure. */
  suite('assets · android package', () => {
    const GRADLE = 'android/app/build.gradle.kts';

    test('the Android build file exists', () =>
      assert.ok(exists(GRADLE), `${GRADLE} missing — what the APK carries is undefined`));

    const gradle = exists(GRADLE) ? read(GRADLE) : '';
    const block = gradle.match(/exclude\(([\s\S]*?)\)/);

    test('the Android build declares an asset exclude list', () =>
      assert.ok(block, `no exclude(...) call in ${GRADLE} — what the APK carries is unstated`));

    const excluded = block ? [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]) : [];

    test('the exclude list is non-empty', () =>
      assert.greater(excluded.length, 0, 'exclude(...) parsed to nothing'));

    /* Gradle uses Ant glob patterns. Scanned character by character rather than
       rewritten by chained replaces, because chaining needs placeholder characters
       and a placeholder that can occur in real input is a bug lying in wait.
       A doubled star before a separator spans whole directories, a doubled star
       alone spans anything, and a single star stops at a separator. */
    const META = '.+^$()|[]{}?\\';
    const matches = (pattern, file) => {
      let re = '';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c !== '*') { re += META.includes(c) ? '\\' + c : c; continue; }
        if (pattern[i + 1] !== '*') { re += '[^/]*'; continue; }
        if (pattern[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      }
      return new RegExp('^' + re + '$').test(file);
    };

    const swList = read('sw.js').match(/const PRECACHE = \[([\s\S]*?)\]/);
    const precached = swList ? [...swList[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

    precached.forEach(entry => {
      // './' is the navigation root, which the worker serves out of index.html.
      const file = entry === './' ? 'index.html' : entry.replace(/^\.\//, '');
      test(`the APK ships precached ${entry}`, () => {
        const hit = excluded.find(pattern => matches(pattern, file));
        assert.notOk(hit,
          `sw.js precaches ${entry}, but the Android build excludes it via "${hit}" — ` +
          'cache.addAll is atomic, so the installed app would fail offline entirely');
      });
    });

    test('the build excludes its own output', () =>
      assert.ok(excluded.some(p => matches(p, 'android/app/build/outputs/apk/debug/app-debug.apk')),
        'android/ is not excluded, so the copy task would recurse into its own build directory'));

    test('the build excludes the test suite', () =>
      assert.ok(excluded.some(p => matches(p, 'tests/run.js')),
        'tests/ would ship inside the APK for no reason'));

    /* The copy is defined by exclusion, which is the right direction -- a web file
       added later ships by default, and the failure mode is a larger APK rather
       than a 404 in a field. The cost is that anything else added at the root
       ships too, and the only thing that caught the last one was aapt discarding
       dot-prefixed names, which is a tool default this project never asked for and
       does not control. A scratch directory without a leading dot would ship
       silently. Git already knows which root directories are not part of the app:
       they are the ones it refuses to track. */
    const ignoredRoots = read('.gitignore')
      .split(/[\r\n]+/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .filter(l => l.endsWith('/') && !l.startsWith('!') && !l.includes('*'))
      .map(l => l.replace(/\/$/, ''))
      .filter(dir => !dir.includes('/'));          // nested ones sit under an excluded root

    test('the gitignore names at least one root directory to check', () =>
      assert.greater(ignoredRoots.length, 0,
        'no root-level ignored directory found — this guard is checking nothing'));

    ignoredRoots.forEach(dir => {
      test(`the APK excludes the untracked ${dir}/`, () =>
        assert.ok(excluded.some(p => matches(p, `${dir}/anything/at/all.html`)),
          `git refuses to track ${dir}/ but the Android build copies it into the ` +
          'package. It is kept out today only by aapt discarding dot-prefixed ' +
          `names; rename it without the dot and it ships. Add "${dir}/**" to exclude(...)`));
    });
  });

  /* ------------------------------------------------------------------------ */
  /* The Android back button names two element ids in Java, where nothing else in
     this suite can see them. The shell registers no history entries, so a back
     press has nothing to pop and would close the app outright. Rename either id
     in index.html and back silently stops dismissing the layer on screen and
     starts quitting instead — with no error anywhere to say so. */
  suite('assets · android back button', () => {
    const JAVA = 'android/app/src/main/java/earth/aura/agrinet/MainActivity.java';

    test('MainActivity.java exists', () => assert.ok(exists(JAVA), `${JAVA} missing`));

    const java = exists(JAVA) ? read(JAVA) : '';
    const decl = java.match(/var ids\s*=\s*\[([^\]]*)\]/);

    test('the back handler declares the layer ids it dismisses', () =>
      assert.ok(decl, 'no "var ids=[...]" in MainActivity.java — the back button probes nothing'));

    const ids = decl ? [...decl[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

    test('it probes at least one layer', () =>
      assert.greater(ids.length, 0, 'the id list parsed to nothing'));

    const { markup } = readSource();
    ids.forEach(id => {
      test(`#${id} exists in the shell`, () =>
        assert.includes(markup, `id="${id}"`,
          `MainActivity dismisses #${id} on back, but no such element is in index.html — ` +
          'back would close the app with that layer still open'));
    });

    test('the manual is one of them', () =>
      assert.includes(ids, 'manualLayer', 'back would close the app with the manual open'));

    test('the simulation sheet is one of them', () =>
      assert.includes(ids, 'simSheet', 'back would close the app with the sheet open'));

    test('the handler dispatches Escape rather than reaching into the page', () =>
      assert.includes(java, "key:'Escape'",
        'the back handler should hand the page an Escape and let its own keydown ' +
        'handler resolve the innermost layer, not duplicate that ordering in Java'));
  });

  /* ------------------------------------------------------------------------ */
  /* When the screen goes off or the app is backgrounded, the page's own
     visibilitychange is not guaranteed to run before Android freezes the process,
     and its periodic snapshot is twenty seconds wide. So the Activity runs a
     snippet of JavaScript on pause. That snippet is a string in a Java file: no
     compiler checks it, and nothing in the app would fail if it stopped working.
     Here it is run against the real shipped script, and it has to write. */
  suite('assets · android lifecycle', () => {
    const JAVA = 'android/app/src/main/java/earth/aura/agrinet/MainActivity.java';
    const java = exists(JAVA) ? read(JAVA) : '';
    // The constant is written as several Java literals joined by +, so take the
    // whole declaration and concatenate every quoted run inside it.
    const decl = java.match(/SAVE_ON_PAUSE\s*=([\s\S]*?);\n/);
    const parts = decl ? [...decl[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]) : [];

    test('MainActivity declares a save-on-pause snippet', () =>
      assert.ok(decl && parts.length,
        'no SAVE_ON_PAUSE constant — nothing forces a save when the screen goes off'));

    test('the snippet writes to storage when run against the shipped script', () => {
      if (!parts.length) return;               // already reported above
      const snippet = parts.join('').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const h = boot();
      h.app.State.data.role = 'DRIVER';
      h.storage.clear();
      // Same footing Android gives it: a separate script evaluated in global scope.
      vm.runInContext(snippet, h.window);
      assert.greater(h.storage.size, 0,
        'the snippet Android runs on pause wrote nothing — State is out of reach ' +
        'from a global eval, so closing the app would lose the session');
    });

    test('the Activity pauses and resumes the WebView', () => {
      assert.includes(java, 'webView.onPause()',
        'the page keeps its timers running behind a dark screen, draining the battery');
      assert.includes(java, 'webView.onResume()',
        'the page would stay paused after the user comes back');
    });
  });

  /* ------------------------------------------------------------------------ */
  /* One mark, drawn in four places: the header SVG, four PNGs, and two Android
     vector drawables. Hand-copied geometry drifts, and nothing breaks loudly when
     it does — you just end up with a launcher icon that is not quite the logo.
     So icons/build-icons.js holds the numbers, and these check the rest agrees. */
  suite('assets · brand mark', () => {
    const { MARK, render } = require('../icons/build-icons.js');
    const { markup } = readSource();
    const svg = (markup.match(/<svg[^>]*viewBox="0 0 32 32"[\s\S]*?<\/svg>/) || [''])[0];

    test('the header carries the mark', () =>
      assert.greater(svg.length, 0, 'no 32x32 svg in the header'));

    test('the orbit ring matches the generator', () => {
      assert.includes(svg, `r="${MARK.orbit.r}"`, 'orbit radius differs from MARK.orbit.r');
      assert.includes(svg, `stroke-width="${MARK.orbit.width}"`, 'orbit stroke differs from MARK.orbit.width');
    });

    test('the scan ring matches the generator', () => {
      assert.includes(svg, `A${MARK.scan.r},${MARK.scan.r}`, 'scan arc radius differs from MARK.scan.r');
      assert.includes(svg, `stroke-width="${MARK.scan.width}"`, 'scan stroke differs from MARK.scan.width');
    });

    test('the core and the satellite match the generator', () => {
      assert.includes(svg, `r="${MARK.core.r}"`, 'core radius differs from MARK.core.r');
      assert.includes(svg, `cy="${MARK.satellite.cy}" r="${MARK.satellite.r}"`,
        'satellite position or radius differs from MARK.satellite');
    });

    test('round linecaps have not crept into the arc', () =>
      assert.notIncludes(svg, 'stroke-linecap',
        'the generator draws butt ends, so a round cap here makes the SVG and the PNGs different marks'));

    /* Decoded pixels rather than file bytes: deflate output is not guaranteed
       identical across the Node versions CI runs, but inflate always is. */
    test('the shipped icon-192.png is what the generator produces today', () => {
      const buf = fs.readFileSync(path.join(ROOT, 'icons/icon-192.png'));
      let off = 8, w = 0, h = 0;
      const idat = [];
      while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
        if (type === 'IDAT') idat.push(data);
        off += 12 + len;
      }
      const raw = require('zlib').inflateSync(Buffer.concat(idat));
      const stride = w * 4;
      const pixels = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) {
        raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
      }
      assert.ok(pixels.equals(render(192, false, 1.0)),
        'icons/icon-192.png no longer matches the geometry that generated it — run node icons/build-icons.js');
    });
  });
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

  /* ================================================= themes =============== */
  /* The palettes are the one part of this app a logic test cannot see at all:
     they are CSS custom properties, and the stub DOM has no cascade. What can
     be checked is that the two halves agree, that nothing renders a colour
     outside them, and that the control reaches both. */
  suite('assets · themes', () => {
    const { html, markup } = readSource();

    /** Every `--token: value;` declared inside one block, as a map. */
    const tokensOf = (start) => {
      const a = html.indexOf(start);
      if (a < 0) return null;
      const b = html.indexOf('\n}', a);
      const body = html.slice(a, b < 0 ? a + 4000 : b);
      const out = {};
      for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
      return out;
    };

    /* The dark palette is written twice -- once behind prefers-color-scheme for
       readers who never touch the control, once behind [data-theme] for readers
       who do. Plain CSS cannot share one body between a media block and a bare
       selector, and collapsing them with light-dark() would put a Chrome 123 /
       Safari 17.5 floor under an app that ships an APK onto whatever WebView a
       device happens to carry. So they stay duplicated, and this is what stops
       them drifting: tune a colour in one and forget the other, and the two
       dark themes disagree in a way only a human eye would ever catch. */
    const media = tokensOf(':root:not([data-theme="light"]){');
    const forced = tokensOf(':root[data-theme="dark"]{');

    test('both dark palettes exist', () => {
      assert.ok(media, 'no dark palette behind prefers-color-scheme');
      assert.ok(forced, 'no dark palette behind [data-theme="dark"]');
    });

    test('the two dark palettes declare the same tokens', () =>
      assert.deepEqual(Object.keys(media).sort(), Object.keys(forced).sort(),
        'one dark palette declares a token the other does not'));

    test('the two dark palettes agree on every value', () => {
      const differs = Object.keys(media).filter(k => media[k] !== forced[k]);
      assert.deepEqual(differs, [],
        'the same token has two different dark values, so the theme changes when you choose it');
    });

    /* A token defined only in dark renders as nothing in light -- an invisible
       border, black text on black -- and no test that never paints would see it. */
    test('every token the stylesheet reads is defined in the light palette', () => {
      const light = tokensOf(':root{');
      const used = new Set([...html.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
      const undefined_ = [...used].filter(k => !(k in light));
      assert.deepEqual(undefined_, [],
        'var() reads a token that bare :root never defines');
    });

    test('the theme control is in the shell and names all three modes', () => {
      assert.includes(markup, 'id="btnTheme"', 'no theme button');
      assert.includes(markup, 'id="themeMenu"', 'no theme menu');
      ['light', 'dark', 'system'].forEach(m =>
        assert.includes(html, `id:'${m}'`, `${m} is not a mode the module offers`));
    });

    /* Theme.apply() rewrites these by id. Without the ids it would need
       querySelector('meta[name=...]'), which the stub DOM refuses. */
    test('both theme-color metas carry an id for the module to reach', () => {
      assert.includes(markup, 'id="tcLight"', 'the light theme-color meta has no id');
      assert.includes(markup, 'id="tcDark"', 'the dark theme-color meta has no id');
    });

    test('the ground colours the module writes match the palettes', () => {
      const light = tokensOf(':root{');
      assert.includes(html, `light:'${light['--plane']}'`,
        'Theme.PLANE.light disagrees with --plane, so the browser chrome would not match the page');
      assert.includes(html, `dark:'${forced['--plane']}'`,
        'Theme.PLANE.dark disagrees with the dark --plane');
    });

    /* app.css is prebuilt and the script writes inline styles, so a colour that
       skips the tokens is invisible until someone opens the app in the other
       theme. Three had: a near-black driver label on ochre, and two copies of a
       red belonging to neither palette. */
    test('no raw colour survives in the script outside the palettes', () => {
      const script = html.slice(html.indexOf('MODULE 1: CONFIG'));
      const plane = [...html.matchAll(/PLANE = \{[^}]*\}/g)]
        .flatMap(m => [...m[0].matchAll(/#[0-9a-fA-F]{3,8}/g)].map(c => c[0].toLowerCase()));
      const raw = [
        ...script.matchAll(/#[0-9a-fA-F]{3,8}\b(?![^<]*<\/style>)/g),
        ...script.matchAll(/rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/g),
      /* Theme.PLANE is the one place a colour is legitimately spelled out in the
         script -- the metas it writes are not CSS and cannot read a token. Read
         the exception out of the source rather than repeating it here, or this
         allowlist goes stale the first time a palette is retuned. Which is
         exactly what it did. */
      ].map(m => m[0]).filter(v => !plane.includes(v.toLowerCase()));
      assert.deepEqual([...new Set(raw)], [],
        'a colour bypasses the design tokens and will be wrong in one of the two themes');
    });
  });
};
