'use strict';
// The image pipeline: sizes, downscale, ImageMagick-compatible statistics,
// the worker, and the fixtures against the values of ha-adb-mcp 1.4.0.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../src/image.js');
const { tmpDir } = require('./helpers.js');

const FIX = path.join(__dirname, 'fixtures');
const REFERENCE = path.join(FIX, 'reference-imagemagick.json');

// The run of every fixture in this suite: max_px and quality of adb_screenshot's defaults.
const PX = 1024, Q = 70;
const FIXTURES = {
  'black.png': { W: 1080, H: 2340, w: 473, h: 1024, dark: true },
  'dark-below.png': { W: 1920, H: 1080, w: 1024, h: 576, dark: true },
  'dark-above.png': { W: 1920, H: 1080, w: 1024, h: 576, dark: false },
  'mid.png': { W: 1080, H: 2400, w: 461, h: 1024, dark: false },
  'light.png': { W: 3840, H: 2160, w: 1024, h: 576, dark: false },
};
// Tolerance against the ImageMagick pipeline of 1.4.0 (which measured the
// re-read JPEG). Sizes and the dark side are exact. ImageMagick's resize
// filter against the area average moves sd of bright frames by 0.002-0.003;
// the frames near the dark threshold get the tight sd bound.
const TOL_MEAN = 0.005, TOL_SD = 0.004, TOL_SD_NEAR_THRESHOLD = 0.001;
const NEAR_THRESHOLD = new Set(['black.png', 'dark-below.png', 'dark-above.png']);

test('fitSize: fit into px x px, never enlarge', () => {
  assert.deepEqual(I.fitSize(1080, 2340, 1024), { w: 473, h: 1024 });
  assert.deepEqual(I.fitSize(3840, 2160, 1024), { w: 1024, h: 576 });
  assert.deepEqual(I.fitSize(1080, 2400, 1024), { w: 461, h: 1024 });
  assert.deepEqual(I.fitSize(800, 600, 1024), { w: 800, h: 600 });
  assert.deepEqual(I.fitSize(1920, 1080, 1920), { w: 1920, h: 1080 });
  assert.deepEqual(I.fitSize(4000, 10, 320), { w: 320, h: 1 });
});

function rgba(pixels) {
  const b = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, bl], i) => { b[i * 4] = r; b[i * 4 + 1] = g; b[i * 4 + 2] = bl; b[i * 4 + 3] = 255; });
  return b;
}

test('resizeArea: the coverage-weighted mean of the source pixels', () => {
  const src = rgba([[0, 0, 0], [100, 100, 100], [200, 200, 200], [255, 255, 255],
                    [0, 0, 0], [100, 100, 100], [200, 200, 200], [255, 255, 255]]);
  const out = I.resizeArea(src, 4, 2, 2, 1);
  assert.deepEqual([...out], [50, 50, 50, 255, 228, 228, 228, 255]);
  const third = I.resizeArea(rgba([[0, 0, 0], [90, 90, 90], [180, 180, 180]]), 3, 1, 2, 1);
  assert.deepEqual([...third], [30, 30, 30, 255, 150, 150, 150, 255], '1.5 source pixels per output pixel');
  const same = I.resizeArea(rgba([[1, 2, 3]]), 1, 1, 1, 1);
  assert.deepEqual([...same], [1, 2, 3, 255]);
});

test('frameStats: the mean of per-channel means and of per-channel SAMPLE deviations, not the pooled deviation', () => {
  // R always 0, G always 255: every channel is constant, so sd is 0, while
  // the pooled deviation of all samples would be about 0.5.
  const flat = I.frameStats(rgba([[0, 255, 0], [0, 255, 0], [0, 255, 0]]), 3, 1);
  assert.equal(flat.sd, 0);
  assert.ok(Math.abs(flat.mean - 1 / 3) < 1e-12);
  // Two pixels 0 and 255 in every channel: the sample deviation (n-1) is
  // 255/sqrt(2); the population one would be 127.5.
  const two = I.frameStats(rgba([[0, 0, 0], [255, 255, 255]]), 2, 1);
  assert.ok(Math.abs(two.sd - 1 / Math.SQRT2) < 1e-12, String(two.sd));
  assert.equal(two.mean, 0.5);
  // Channels with different spreads: the deviations are averaged.
  const mixed = I.frameStats(rgba([[0, 10, 0], [0, 30, 40]]), 2, 1);
  const sd = (a, b) => Math.abs(a - b) / Math.SQRT2;
  assert.ok(Math.abs(mixed.sd - (sd(0, 0) + sd(10, 30) + sd(0, 40)) / 3 / 255) < 1e-12);
});

test('dark: both below the thresholds', () => {
  assert.equal(I.DARK_MEAN_THRESHOLD, 0.03);
  assert.equal(I.DARK_SD_THRESHOLD, 0.01);
  assert.equal(I.isDark(0.029, 0.009), true);
  assert.equal(I.isDark(0.031, 0.001), false);
  assert.equal(I.isDark(0.001, 0.011), false);
});

test('processPngBuffer and processFrame give the same result; the JPEG is a JPEG', async () => {
  const dir = tmpDir();
  const buf = I.makePng(1600, 900, (x, y) => [x % 256, y % 256, (x + y) % 256]);
  const file = path.join(dir, 'f.png');
  fs.writeFileSync(file, buf);
  const direct = I.processPngBuffer(buf, 800, 70);
  const viaWorker = await I.processFrame(file, 800, 70);
  for (const k of ['W', 'H', 'w', 'h', 'mean', 'sd']) assert.equal(viaWorker[k], direct[k], k);
  assert.deepEqual(viaWorker.jpeg, direct.jpeg);
  assert.equal(viaWorker.jpeg[0], 0xff);
  assert.equal(viaWorker.jpeg[1], 0xd8);
  assert.deepEqual([viaWorker.w, viaWorker.h], [800, 450]);
});

test('processFrame: a file that is not a PNG, a missing file, a timeout', async () => {
  const dir = tmpDir();
  const bad = path.join(dir, 'bad.png');
  fs.writeFileSync(bad, 'not a png');
  await assert.rejects(I.processFrame(bad, 1024, 70), Error);
  await assert.rejects(I.processFrame(path.join(dir, 'missing.png'), 1024, 70), /ENOENT/);
  const big = path.join(dir, 'big.png');
  fs.writeFileSync(big, I.makePng(2000, 2000, () => [1, 2, 3]));
  await assert.rejects(I.processFrame(big, 1024, 70, { timeoutMs: 1 }), /image conversion timed out after 0\.001 s/);
});

test('the fixtures: sizes and the dark side as designed; values for the report', async t => {
  for (const [name, want] of Object.entries(FIXTURES)) {
    const r = await I.processFrame(path.join(FIX, name), PX, Q);
    const dark = I.isDark(r.mean, r.sd);
    t.diagnostic(`${name} ${r.W}x${r.H} px=${PX} q=${Q} -> ${r.w}x${r.h} mean=${r.mean.toFixed(4)} sd=${r.sd.toFixed(4)} dark=${dark}`);
    assert.deepEqual([r.W, r.H, r.w, r.h], [want.W, want.H, want.w, want.h], name);
    assert.equal(dark, want.dark, name);
  }
});

test('the fixtures against the ImageMagick pipeline of ha-adb-mcp 1.4.0', async t => {
  const ref = JSON.parse(fs.readFileSync(REFERENCE, 'utf8'));
  t.diagnostic(`reference: ${ref.source}`);
  for (const name of Object.keys(FIXTURES)) {
    const want = ref.fixtures && ref.fixtures[name];
    assert.ok(want, `${name} missing in reference-imagemagick.json`);
    const r = await I.processFrame(path.join(FIX, name), ref.px || PX, ref.quality || Q);
    const tolSd = NEAR_THRESHOLD.has(name) ? TOL_SD_NEAR_THRESHOLD : TOL_SD;
    t.diagnostic(`${name}: ${r.W}x${r.H} -> ${r.w}x${r.h}, mean ${r.mean.toFixed(4)} vs ${want.mean} (diff ${(r.mean - want.mean).toFixed(4)}), ` +
      `sd ${r.sd.toFixed(4)} vs ${want.sd} (diff ${(r.sd - want.sd).toFixed(4)}, tolerance ${tolSd}), dark ${I.isDark(r.mean, r.sd)} vs ${want.dark}`);
    assert.deepEqual([r.W, r.H, r.w, r.h], [want.W, want.H, want.w, want.h], `${name}: sizes`);
    assert.equal(I.isDark(r.mean, r.sd), want.dark, `${name}: dark side`);
    assert.ok(Math.abs(r.mean - want.mean) <= TOL_MEAN, `${name}: mean ${r.mean} vs ${want.mean}`);
    assert.ok(Math.abs(r.sd - want.sd) <= tolSd, `${name}: sd ${r.sd} vs ${want.sd}`);
  }
});
