/* PWA asset integrity.

   An offline-first app fails in exactly one way that no logic test catches: the
   shell references something the service worker does not precache, or precaches
   something that is not on disk. `cache.addAll` is atomic, so a single bad path
   fails the whole install and the app silently never works offline. These checks
   are cheap and they are the ones that would actually have bitten. */
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, readSource } = require('./harness');

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

    /* Tailwind here is PREBUILT and committed, and there is no build step, so a
       utility class that was not in the source when app.css was compiled is
       silently inert: it reads correctly in the markup and does nothing on
       screen. Six were shipping that way, and `gap-5` is why the driver's
       distance and drive time ran together. Nothing else can catch this --
       every test that reads the DOM sees the class attribute, not the rule. */
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
};
