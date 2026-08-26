/* AURA-AgriNet icon generator.

   The mark is a sensor footprint over a point of ground with a platform passing
   overhead — which is what this app actually does, so it is what the logo draws:

     · a faint outer ORBIT ring, with the satellite sitting on it
     · a heavier SCAN ring, broken at the top so the downlink path reads through
     · a solid CORE, the point being measured

   Why this file exists at all: the same geometry has to appear as an inline SVG
   in the header, as four PNGs for the web manifest, and as two Android vector
   drawables. Six hand-drawn copies of one mark drift, and nothing would fail when
   they did. So the numbers live here once, the PNGs are generated, and a test
   checks the SVG in index.html still agrees with these constants.

   No dependencies, and none available: there is no image library on this project
   and adding one to a repository that advertises zero dependencies to draw four
   circles would be a poor trade. Node's zlib is enough to write a PNG by hand.

   Run:  node icons/build-icons.js
*/
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ------------------------------------------------------------------ geometry --
   A 32-unit square, the same viewBox the header SVG uses, so every number below
   can be read straight off the markup and back. */
const MARK = {
  view: 32,
  orbit:     { cx: 16, cy: 16, r: 13,  width: 1.8, colour: 'series1', alpha: 0.32 },
  scan:      { cx: 16, cy: 16, r: 8.6, width: 2.2, colour: 'series3', alpha: 0.90,
               gapDeg: 60 },     // centred on the top, where the satellite sits
  core:      { cx: 16, cy: 16, r: 3.8, colour: 'series1', alpha: 1 },
  satellite: { cx: 16, cy: 3,  r: 2.4, colour: 'series4', alpha: 1 },
};

/* The light-theme identity colours, straight from the design tokens in
   index.html. The icon does not follow the dark theme: a launcher composites it
   against a wallpaper, not against the app's own background. */
const COLOURS = {
  series1: [0x2b, 0x5f, 0x8f],   // slate — the agent, and the ground point
  series3: [0x4a, 0x7a, 0x29],   // olive — the scan
  series4: [0x8a, 0x6a, 0x14],   // ochre — the platform overhead
  oat:     [0xf4, 0xef, 0xe6],   // the app's own background, for opaque icons
  /* --plane, as it stands after the light theme was brightened. The icons keep
     `oat`: they are composited against a launcher wallpaper rather than against
     the app, so they were never showing the page's ground. A launch image IS the
     page's ground for the second before the shell paints, so it has to match it
     or the app visibly changes colour as it opens. */
  plane:   [0xfb, 0xf9, 0xf5],
};

/* --------------------------------------------------------------- rasteriser -- */

const SS = 4;                      // 4x4 supersampling: 16 coverage samples/pixel
const DEG = Math.PI / 180;

/** Is this point inside the annulus that a stroked circle occupies? */
function inRing(cx, cy, x, y, r, width, gapDeg) {
  const dx = x - cx, dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d < r - width / 2 || d > r + width / 2) return false;
  if (!gapDeg) return true;
  // Screen coordinates put y downwards, so the top of the circle is at -90°.
  let a = Math.atan2(dy, dx) / DEG;
  const half = gapDeg / 2;
  const lo = -90 - half, hi = -90 + half;
  return !(a > lo && a < hi);
}

function inDisc(cx, cy, x, y, r) {
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Paint one shape over the buffer, source-over, at the coverage given. */
/* `h` and `oy` default to the square case, so every existing caller reads the
   same. The launch images are the only rectangular canvas here. */
function paint(buf, size, hit, rgb, alpha, k, o, h, oy) {
  const H = h === undefined ? size : h;
  const OY = oy === undefined ? o : oy;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < size; px++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Sample at subpixel centres, mapped back into the 32-unit viewport.
          const x = ((px + (sx + 0.5) / SS) - o) / k;
          const y = ((py + (sy + 0.5) / SS) - OY) / k;
          if (hit(x, y)) cover++;
        }
      }
      if (!cover) continue;
      const a = (cover / (SS * SS)) * alpha;
      const i = (py * size + px) * 4;
      const dstA = buf[i + 3];
      const outA = a + dstA * (1 - a);
      for (let c = 0; c < 3; c++) {
        buf[i + c] = (rgb[c] * a + buf[i + c] * dstA * (1 - a)) / (outA || 1);
      }
      buf[i + 3] = outA;
    }
  }
}

/**
 * @param {number} size    pixels square
 * @param {boolean} opaque paint the oat background rather than leaving alpha 0
 * @param {number} fill    fraction of the canvas the mark occupies (maskable
 *                         icons must keep their content inside the middle 80%)
 */
function render(size, opaque, fill) {
  const buf = new Float64Array(size * size * 4);
  if (opaque) {
    for (let i = 0; i < size * size; i++) {
      buf[i * 4] = COLOURS.oat[0];
      buf[i * 4 + 1] = COLOURS.oat[1];
      buf[i * 4 + 2] = COLOURS.oat[2];
      buf[i * 4 + 3] = 1;
    }
  }

  const k = (size * fill) / MARK.view;      // viewport units -> pixels
  const o = (size * (1 - fill)) / 2;        // centring offset

  const { orbit, scan, core, satellite } = MARK;

  // Painted back to front: the satellite sits on the orbit it rides.
  paint(buf, size, (x, y) => inRing(orbit.cx, orbit.cy, x, y, orbit.r, orbit.width),
        COLOURS[orbit.colour], orbit.alpha, k, o);
  paint(buf, size, (x, y) => inRing(scan.cx, scan.cy, x, y, scan.r, scan.width, scan.gapDeg),
        COLOURS[scan.colour], scan.alpha, k, o);
  paint(buf, size, (x, y) => inDisc(core.cx, core.cy, x, y, core.r),
        COLOURS[core.colour], core.alpha, k, o);
  paint(buf, size, (x, y) => inDisc(satellite.cx, satellite.cy, x, y, satellite.r),
        COLOURS[satellite.colour], satellite.alpha, k, o);

  // Float RGBA -> straight 8-bit RGBA.
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size * 4; i += 4) {
    out[i] = Math.round(Math.max(0, Math.min(255, buf[i])));
    out[i + 1] = Math.round(Math.max(0, Math.min(255, buf[i + 1])));
    out[i + 2] = Math.round(Math.max(0, Math.min(255, buf[i + 2])));
    out[i + 3] = Math.round(Math.max(0, Math.min(255, buf[i + 3] * 255)));
  }
  return out;
}

/* --------------------------------------------------------- PNG encoding ------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size, height) {
  const h = height === undefined ? size : height;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type 6 = RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // Every scanline gets filter byte 0. These are flat shapes on a flat ground,
  // so deflate handles them well without per-line filter heuristics.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------------------------------------- launch images -- */

/* What an iPhone shows between the tap on the icon and the shell painting.
   Without one it shows nothing -- a white rectangle -- and iOS has no way to
   derive it that this app can rely on. Android gets a splash screen from its
   own manifest; this is the same courtesy, done the way iOS asks for it.

   The mark is drawn small and centred on the app's own ground, so the launch
   image and the first painted frame are the same colour and the app does not
   flash as it opens. Nearly all of each file is one flat colour, which deflate
   reduces to almost nothing -- which is what makes it affordable to precache
   nine of them. */
function renderLaunch(w, h) {
  const buf = new Float64Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = COLOURS.plane[0];
    buf[i * 4 + 1] = COLOURS.plane[1];
    buf[i * 4 + 2] = COLOURS.plane[2];
    buf[i * 4 + 3] = 1;
  }

  // The mark occupies a quarter of the narrow edge, centred on both axes.
  const span = Math.min(w, h) * 0.25;
  const k = span / MARK.view;
  const ox = (w - span) / 2;
  const oy = (h - span) / 2;

  const { orbit, scan, core, satellite } = MARK;
  paint(buf, w, (x, y) => inRing(orbit.cx, orbit.cy, x, y, orbit.r, orbit.width),
        COLOURS[orbit.colour], orbit.alpha, k, ox, h, oy);
  paint(buf, w, (x, y) => inRing(scan.cx, scan.cy, x, y, scan.r, scan.width, scan.gapDeg),
        COLOURS[scan.colour], scan.alpha, k, ox, h, oy);
  paint(buf, w, (x, y) => inDisc(core.cx, core.cy, x, y, core.r),
        COLOURS[core.colour], core.alpha, k, ox, h, oy);
  paint(buf, w, (x, y) => inDisc(satellite.cx, satellite.cy, x, y, satellite.r),
        COLOURS[satellite.colour], satellite.alpha, k, ox, h, oy);

  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    out[i] = Math.round(Math.max(0, Math.min(255, buf[i])));
    out[i + 1] = Math.round(Math.max(0, Math.min(255, buf[i + 1])));
    out[i + 2] = Math.round(Math.max(0, Math.min(255, buf[i + 2])));
    out[i + 3] = Math.round(Math.max(0, Math.min(255, buf[i + 3] * 255)));
  }
  return out;
}

/* Device pixel dimensions, portrait. iOS matches a startup image by exact
   device-width, device-height and pixel ratio, so a size that is nearly right is
   simply ignored -- these are listed as their CSS points and their ratio, and
   the pixel canvas is derived, so the link tag and the file cannot disagree.

   One entry per current iPhone family. Landscape is not listed: the manifest
   pins the app to portrait. */
const LAUNCH = [
  // [ css width, css height, ratio ]  -> device pixels
  [320, 568, 2],   // SE 1st gen
  [375, 667, 2],   // 8, SE 2nd/3rd gen
  [414, 736, 3],   // 8 Plus
  [375, 812, 3],   // X, XS, 11 Pro, 12/13 mini
  [414, 896, 2],   // XR, 11
  [414, 896, 3],   // XS Max, 11 Pro Max
  [390, 844, 3],   // 12, 13, 14
  [428, 926, 3],   // 12/13 Pro Max, 14 Plus
  [393, 852, 3],   // 14 Pro, 15, 16
  [430, 932, 3],   // 14 Pro Max, 15 Plus, 15 Pro Max
  [402, 874, 3],   // 16 Pro
  [440, 956, 3],   // 16 Pro Max
];

/** The filename and the media query for one entry, derived from the same numbers. */
function launchFor([cw, ch, ratio]) {
  return {
    name: `launch-${cw}x${ch}@${ratio}x.png`,
    w: cw * ratio,
    h: ch * ratio,
    media: `(device-width: ${cw}px) and (device-height: ${ch}px) `
         + `and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)`,
  };
}

/* ------------------------------------------------------------------ outputs -- */

const TARGETS = [
  // file,                        size, opaque, fill
  ['icon-192.png',                 192, false, 1.00],
  ['icon-512.png',                 512, false, 1.00],
  // Maskable icons are cropped to whatever shape the launcher likes, so the mark
  // has to stay inside the middle 80% and the corners must be painted.
  ['icon-maskable-512.png',        512, true,  0.80],
  // iOS composites onto a square and applies its own rounding; transparency there
  // comes out black.
  ['apple-touch-icon-180.png',     180, true,  0.86],
];

function main() {
  const dir = __dirname;
  let total = 0;
  for (const [name, size, opaque, fill] of TARGETS) {
    const png = encodePng(render(size, opaque, fill), size);
    fs.writeFileSync(path.join(dir, name), png);
    total += png.length;
    console.log(`${name.padEnd(28)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
  }
  for (const entry of LAUNCH) {
    const { name, w, h } = launchFor(entry);
    const png = encodePng(renderLaunch(w, h), w, h);
    fs.writeFileSync(path.join(dir, name), png);
    total += png.length;
    console.log(`${name.padEnd(28)} ${w}x${h}  ${(png.length / 1024).toFixed(1)} KB`);
  }
  console.log(`${''.padEnd(28)} total ${(total / 1024).toFixed(1)} KB`);

  /* The link tags the shell needs, printed rather than written: index.html is
     hand-maintained and a generator that edited it would be a second author. */
  console.log('\n<!-- paste into index.html -->');
  for (const entry of LAUNCH) {
    const { name, media } = launchFor(entry);
    console.log(`<link rel="apple-touch-startup-image" href="icons/${name}" media="${media}">`);
  }
}

if (require.main === module) main();

module.exports = { MARK, COLOURS, LAUNCH, render, renderLaunch, launchFor, encodePng };
