#!/usr/bin/env node
// Writes the image fixtures of test/image.test.js into test/fixtures/,
// deterministically: the same bytes on every run and every OS.
//
//   node tools/make-image-fixtures.mjs           write the files
//   node tools/make-image-fixtures.mjs --check   compare the files' pixels with
//                                                what would be written (the PNG
//                                                bytes depend on the zlib build)
//
// black       1080x2340, all 0                        -> dark
// dark-below  1920x1080, tiles of 4..9 per channel     -> mean and sd just below the thresholds (dark)
// dark-above  1920x1080, tiles of 4..14 per channel    -> mean and sd just above the thresholds (not dark)
// mid         1080x2400, tiles of 64..192              -> not dark
// light       3840x2160, tiles of 200..250             -> not dark
//
// "Noise" is in 64-pixel tiles, not single pixels: a downscale averages
// single-pixel noise away, and how much depends on the resize filter, so
// ImageMagick and this pipeline would disagree on sd. Tiles survive any
// filter except at their edges.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makePng } = require('../src/image.js');
const { PNG } = require('pngjs');

const OUT = path.resolve(import.meta.dirname, '..', 'test', 'fixtures');
const TILE = 64;

// mulberry32: a small seeded PRNG.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Every tile gets its own value per channel, uniform in [lo, hi].
function tiles(width, height, lo, hi, seed) {
  const rnd = prng(seed);
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const grid = Array.from({ length: cols * rows }, () => [0, 1, 2].map(() => lo + Math.floor(rnd() * (hi - lo + 1))));
  return (x, y) => grid[Math.floor(y / TILE) * cols + Math.floor(x / TILE)];
}

export const FIXTURES = [
  { name: 'black.png', width: 1080, height: 2340, fill: () => [0, 0, 0] },
  { name: 'dark-below.png', width: 1920, height: 1080, fill: tiles(1920, 1080, 4, 9, 1) },
  { name: 'dark-above.png', width: 1920, height: 1080, fill: tiles(1920, 1080, 4, 14, 2) },
  { name: 'mid.png', width: 1080, height: 2400, fill: tiles(1080, 2400, 64, 192, 3) },
  { name: 'light.png', width: 3840, height: 2160, fill: tiles(3840, 2160, 200, 250, 4) },
];

if (process.argv.includes('--check')) {
  let bad = 0;
  for (const f of FIXTURES) {
    const want = PNG.sync.read(makePng(f.width, f.height, f.fill));
    let got = null;
    try { got = PNG.sync.read(fs.readFileSync(path.join(OUT, f.name))); } catch (e) { console.error(`${f.name}: ${e.message}`); }
    const same = got && got.width === want.width && got.height === want.height && Buffer.compare(got.data, want.data) === 0;
    if (!same) bad++;
    console.log(`${f.name}: ${same ? 'same pixels' : 'DIFFERS - run node tools/make-image-fixtures.mjs'}`);
  }
  process.exitCode = bad ? 1 : 0;
} else {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of FIXTURES) {
    const buf = makePng(f.width, f.height, f.fill);
    fs.writeFileSync(path.join(OUT, f.name), buf);
    console.log(`${f.name}: ${f.width}x${f.height}, ${buf.length} bytes`);
  }
}
