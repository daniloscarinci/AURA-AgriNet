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

    test('activate purges every cache except the current version', () => {
      assert.includes(sw, 'k !== CACHE_VERSION', 'stale caches are never deleted, so old shells linger forever');
    });

    test('fetch handler ignores non-GET requests', () =>
      assert.includes(sw, "req.method !== 'GET'", 'non-GET requests would be cached'));

    test('fetch handler never caches cross-origin responses', () =>
      assert.includes(sw, 'url.origin !== self.location.origin', 'cross-origin responses could enter the cache'));

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

    test('theme_color matches the meta tag in the shell', () => {
      const { markup } = readSource();
      const meta = markup.match(/<meta name="theme-color" content="([^"]+)"/);
      assert.ok(meta, 'no theme-color meta tag');
      assert.equal(meta[1].toLowerCase(), mf.theme_color.toLowerCase(),
        'manifest and meta tag disagree, so the status bar colour changes on install');
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

    test('no fetch/XHR call is made to a remote host', () => {
      const { script } = readSource();
      const calls = [...script.matchAll(/fetch\(\s*['"`](https?:)?\/\//g)].map(m => m[0]);
      assert.deepEqual(calls, [], 'the app claims to make no network calls');
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
  });
};
