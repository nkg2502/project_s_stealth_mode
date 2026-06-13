#!/usr/bin/env node
/*
 * C/C++ Blitz — icon generator (pure Node, no native deps).
 *
 * Renders every marketplace-icon variant with a supersampled software
 * rasterizer and a hand-rolled zlib PNG encoder (so it runs anywhere Node
 * runs — no sharp / canvas / ImageMagick needed). The visual language:
 *
 *   - a rounded square (optionally transparent),
 *   - a bold lightning "spark" bolt (the Feather "zap" silhouette, matching
 *     the activity-bar resources/icon.svg) = fast,
 *   - flanking < > code brackets = C/C++ being analyzed.
 *
 * Each entry in VARIANTS is one PNG. Tweak a field, re-run, compare.
 *
 *   node resources/gen-icons.js [outDir=this dir] [name1 name2 ...]
 *
 * With no name args it writes ALL variants; pass names (without extension)
 * to render only those, e.g.  node resources/gen-icons.js . icon-light-bigbolt
 */
'use strict';
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT = 256;   // final px (square; >=128 as the VS Code marketplace requires)
const SS = 4;      // supersampling factor -> box-downsampled for anti-aliasing
const C = OUT / 2; // center
const RADIUS = 58; // rounded-square corner radius

// ---------- color helpers ----------
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);

// ---------- geometry ----------
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px - C) - (hw - r), qy = Math.abs(py - C) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
// Feather "zap" bolt, mapped from its 24-unit viewBox into OUT space at `scale`.
const BOLT_PATH = [[13, 2], [4, 14], [11, 14], [9, 22], [18, 10], [11, 10]];
const BOLT_CXP = 11, BOLT_CYP = 12;
function makeBolt(scale, glowScale) {
  const pts = BOLT_PATH.map(([x, y]) => [C + (x - BOLT_CXP) * scale, C + (y - BOLT_CYP) * scale]);
  const y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
  const glow = pts.map(([x, y]) => [C + (x - C) * glowScale, C + (y - C) * glowScale]);
  return { pts, glow, y0, y1 };
}
function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function distSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = clamp01((wx * vx + wy * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
function distPolylines(px, py, polys) {
  let d = 1e9;
  for (const poly of polys)
    for (let i = 0; i < poly.length - 1; i++)
      d = Math.min(d, distSeg(px, py, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]));
  return d;
}

// ---------- shading ----------
function makeShade(v) {
  const bolt = makeBolt(v.boltScale, v.glowScale || 1.16);
  const br = v.brackets;
  const brColor = hex(br.color);
  const boltTop = hex(v.bolt[0]), boltBot = hex(v.bolt[1]);
  const bgTop = v.bg ? hex(v.bg[0]) : null, bgBot = v.bg ? hex(v.bg[1]) : null;
  const borderColor = v.border ? hex(v.border) : null;
  const haloColor = v.halo ? hex(v.halo.color) : null;

  return function shade(ox, oy) {
    const sd = sdRoundRect(ox, oy, C, C, RADIUS);
    let col, a;
    if (v.transparentBg) {
      col = [0, 0, 0]; a = 0;
    } else {
      if (sd > 0) return [0, 0, 0, 0];                 // transparent rounded corners
      col = mix(bgTop, bgBot, clamp01((ox + oy) / (OUT * 2)));
      if (v.sheen) col = mix(col, [255, 255, 255], clamp01(1 - (ox + oy) / (OUT * 1.4)) * v.sheen);
      a = 1;
      if (borderColor && sd > -3) col = mix(col, borderColor, 0.55); // crisp edge on a pale bg
    }

    // < > brackets — solid (op>=1) or faint watermark (op<1)
    if (distPolylines(ox, oy, [br.L, br.R]) <= br.r) {
      if (br.op >= 1) { col = brColor.slice(); a = 1; }
      else { col = mix(col, brColor, br.op); }
    }

    // bolt halo (skipped on transparent bg — reads as a smudge there)
    if (v.halo && inPoly(ox, oy, bolt.glow) && !inPoly(ox, oy, bolt.pts)) {
      col = mix(col, haloColor, v.halo.op); a = Math.max(a, v.halo.op);
    }

    // bolt body on top
    if (inPoly(ox, oy, bolt.pts)) {
      col = mix(boltTop, boltBot, clamp01((oy - bolt.y0) / (bolt.y1 - bolt.y0))); a = 1;
    }
    return [col[0], col[1], col[2], a];
  };
}

function renderPixels(v) {
  const shade = makeShade(v);
  const px = Buffer.alloc(OUT * OUT * 4);
  for (let y = 0; y < OUT; y++) for (let x = 0; x < OUT; x++) {
    let ar = 0, ag = 0, ab = 0, aa = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const [r, g, b, a] = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      ar += r * a; ag += g * a; ab += b * a; aa += a;        // premultiplied
    }
    const i = (y * OUT + x) * 4;
    if (aa > 0) { px[i] = Math.round(ar / aa); px[i + 1] = Math.round(ag / aa); px[i + 2] = Math.round(ab / aa); }
    px[i + 3] = Math.round((aa / (SS * SS)) * 255);
  }
  return px;
}

// ---------- PNG encode ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(OUT, 0); ihdr.writeUInt32BE(OUT, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
  for (let y = 0; y < OUT; y++) { raw[y * (OUT * 4 + 1)] = 0; px.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- bracket geometries (one < and one >, as polylines) ----------
const BR = {
  // original icon.png: narrow, faint watermark
  faint:  { L: [[96, 78], [54, 128], [96, 178]], R: [[160, 78], [202, 128], [160, 178]] },
  // bold, normal spacing
  normal: { L: [[88, 64], [42, 128], [88, 192]], R: [[168, 64], [214, 128], [168, 192]] },
  // bold, wider spacing
  wide:   { L: [[80, 60], [28, 128], [80, 196]], R: [[176, 60], [228, 128], [176, 196]] },
  // wide but shorter (smaller) brackets
  short:  { L: [[84, 76], [38, 128], [84, 180]], R: [[172, 76], [218, 128], [172, 180]] },
};

// palette shorthands
const BOLT_BRIGHT = ['#fde68a', '#f59e0b']; // for dark / transparent backgrounds
const BOLT_DEEP = ['#f59e0b', '#d97706'];   // a touch deeper, for the pale background
const BG_LIGHT = ['#e0e7ff', '#ede9fe'];
const BORDER_LIGHT = '#a5b4fc';
const GLOW = '#fbbf24';
const BR_INDIGO = '#6366f1'; // bracket on transparent
const BR_INDIGO_DEEP = '#4f46e5'; // bracket on pale bg

// transparent + light builders for a given bolt scale / bracket shape / radius
const tVariant = (name, boltScale, glowScale, shape, r) => ({
  name, transparentBg: true, boltScale, glowScale, bolt: BOLT_BRIGHT, halo: null,
  brackets: { L: BR[shape].L, R: BR[shape].R, r, color: BR_INDIGO, op: 1 },
});
const lVariant = (name, boltScale, glowScale, shape, r) => ({
  name, transparentBg: false, bg: BG_LIGHT, sheen: 0.10, border: BORDER_LIGHT,
  boltScale, glowScale, bolt: BOLT_DEEP, halo: { color: GLOW, op: 0.30 },
  brackets: { L: BR[shape].L, R: BR[shape].R, r, color: BR_INDIGO_DEEP, op: 1 },
});

const VARIANTS = [
  // the original deep-gradient marketplace icon
  {
    name: 'icon', transparentBg: false, bg: ['#1e40af', '#6d28d9'], sheen: 0.10, border: null,
    boltScale: 6.6, glowScale: 1.16, bolt: BOLT_BRIGHT, halo: { color: GLOW, op: 0.28 },
    brackets: { L: BR.faint.L, R: BR.faint.R, r: 11, color: '#e2e8f0', op: 0.16 },
  },

  // small bolt, bold brackets
  tVariant('icon-transparent', 5.6, 1.18, 'normal', 14),
  lVariant('icon-light', 5.6, 1.18, 'normal', 14),

  // original-size bolt ("bigbolt"), normal & wider bracket spacing
  tVariant('icon-transparent-bigbolt', 6.6, 1.16, 'normal', 14),
  lVariant('icon-light-bigbolt', 6.6, 1.16, 'normal', 14),
  tVariant('icon-transparent-bigbolt-wide', 6.6, 1.16, 'wide', 14),
  lVariant('icon-light-bigbolt-wide', 6.6, 1.16, 'wide', 14),

  // larger bolt ("bigbigbolt"), wide brackets
  tVariant('icon-transparent-bigbigbolt', 7.6, 1.14, 'wide', 14),
  lVariant('icon-light-bigbigbolt', 7.6, 1.14, 'wide', 14),

  // bigbigbolt + thinner ("skinny") brackets
  tVariant('icon-transparent-bigbigbolt-skinny', 7.6, 1.14, 'wide', 10),
  lVariant('icon-light-bigbigbolt-skinny', 7.6, 1.14, 'wide', 10),

  // skinny + shorter ("short") brackets
  tVariant('icon-transparent-bigbigbolt-skinny-short', 7.6, 1.14, 'short', 10),
  lVariant('icon-light-bigbigbolt-skinny-short', 7.6, 1.14, 'short', 10),

  // additional
  tVariant('icon-7-t', 7.6, 1.18, 'short', 11),
  lVariant('icon-7-l', 7.6, 1.18, 'short', 11),
];

// ---------- run ----------
const args = process.argv.slice(2);
const outDir = args[0] && !args[0].startsWith('icon') ? path.resolve(args.shift()) : __dirname;
const only = new Set(args);
let n = 0;
for (const v of VARIANTS) {
  if (only.size && !only.has(v.name)) continue;
  fs.writeFileSync(path.join(outDir, v.name + '.png'), encodePng(renderPixels(v)));
  console.log('wrote', path.join(outDir, v.name + '.png'));
  n++;
}
console.log(`done: ${n} icon(s), ${OUT}x${OUT}`);
