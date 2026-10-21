'use strict';
/**
 * image.js — the screenshot image pipeline, pure JavaScript.
 *
 * processFrame() reads a PNG file in a worker thread: decode (pngjs), fit into
 * px × px without enlarging (area average), brightness statistics of the
 * downscaled frame, JPEG (jpeg-js). A new worker per frame, ended after it, so
 * the decoded frame (about 33 MB for 4K) goes back to the system; no pool, no
 * long-lived worker.
 *
 * ⚠ The PNG never passes through the main thread: adb writes it into a file,
 * only the worker reads it. Buffering screenshots in the main thread is what
 * leaked memory frame after frame.
 *
 * Statistics follow ImageMagick's %[fx:mean] and %[fx:standard_deviation]
 * without a channel qualifier: the composite of the R, G and B channels is the
 * arithmetic mean of the per-channel means and of the per-channel sample
 * standard deviations (denominator n-1), scaled to 0..1. It is not the
 * deviation of all samples pooled. Computed on the downscaled pixels before
 * JPEG encoding.
 *
 * `check` and the tests run processFrame() itself, never a copy of it.
 */

const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

// "Almost uniformly dark": both below.
const DARK_MEAN_THRESHOLD = 0.03;
const DARK_SD_THRESHOLD = 0.01;

const IMAGE_TIMEOUT_MS = 30000;

/** Fit W×H into px×px keeping the aspect ratio; never enlarges. */
function fitSize(W, H, px) {
  if (W <= px && H <= px) return { w: W, h: H };
  const s = Math.min(px / W, px / H);
  return { w: Math.max(1, Math.round(W * s)), h: Math.max(1, Math.round(H * s)) };
}

// For each destination index: the source indices it covers and their share.
function areaTaps(src, dst) {
  const scale = src / dst;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const weights = [];
  for (let i = 0; i < dst; i++) {
    const a = i * scale, b = (i + 1) * scale;
    const lo = Math.floor(a), hi = Math.min(src, Math.ceil(b));
    start[i] = lo;
    count[i] = hi - lo;
    for (let s = lo; s < hi; s++) weights.push((Math.min(b, s + 1) - Math.max(a, s)) / scale);
  }
  return { start, count, weights: Float64Array.from(weights) };
}

/**
 * Area-average downscale of RGBA to w×h RGBA (alpha 255). Separable: each
 * output pixel is the coverage-weighted mean of the source pixels under it.
 */
function resizeArea(rgba, W, H, w, h) {
  const out = new Uint8Array(w * h * 4);
  if (w === W && h === H) {
    for (let i = 0; i < W * H; i++) {
      out[i * 4] = rgba[i * 4]; out[i * 4 + 1] = rgba[i * 4 + 1]; out[i * 4 + 2] = rgba[i * 4 + 2]; out[i * 4 + 3] = 255;
    }
    return out;
  }
  const hx = areaTaps(W, w);
  const vy = areaTaps(H, h);
  // Horizontal pass: H rows of w RGB floats.
  const tmp = new Float32Array(w * H * 3);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    let wi = 0;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      const s0 = hx.start[x], n = hx.count[x];
      for (let k = 0; k < n; k++) {
        const p = row + (s0 + k) * 4;
        const wt = hx.weights[wi++];
        r += rgba[p] * wt; g += rgba[p + 1] * wt; b += rgba[p + 2] * wt;
      }
      const o = (y * w + x) * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  // Vertical pass.
  let wi = 0;
  for (let y = 0; y < h; y++) {
    const s0 = vy.start[y], n = vy.count[y];
    const wts = vy.weights.subarray(wi, wi + n);
    wi += n;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < n; k++) {
        const p = ((s0 + k) * w + x) * 3;
        r += tmp[p] * wts[k]; g += tmp[p + 1] * wts[k]; b += tmp[p + 2] * wts[k];
      }
      const o = (y * w + x) * 4;
      out[o] = Math.min(255, Math.round(r));
      out[o + 1] = Math.min(255, Math.round(g));
      out[o + 2] = Math.min(255, Math.round(b));
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Composite brightness statistics of an RGBA buffer, 0..1: the mean of the
 * R, G, B means and the mean of the R, G, B sample standard deviations.
 */
function frameStats(rgba, w, h) {
  const n = w * h;
  const sum = [0, 0, 0], sq = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = rgba[p + c];
      sum[c] += v;
      sq[c] += v * v;
    }
  }
  let mean = 0, sd = 0;
  for (let c = 0; c < 3; c++) {
    const m = sum[c] / n;
    const variance = n > 1 ? Math.max(0, (sq[c] - sum[c] * m) / (n - 1)) : 0;
    mean += m;
    sd += Math.sqrt(variance);
  }
  return { mean: mean / 3 / 255, sd: sd / 3 / 255 };
}

function isDark(mean, sd) {
  return mean < DARK_MEAN_THRESHOLD && sd < DARK_SD_THRESHOLD;
}

/**
 * The whole pipeline on PNG bytes, synchronously (the worker's job; tests call
 * it directly). Returns { jpeg, W, H, w, h, mean, sd }.
 */
function processPngBuffer(buf, px, quality) {
  const png = PNG.sync.read(buf);
  const W = png.width, H = png.height;
  const { w, h } = fitSize(W, H, px);
  const small = resizeArea(png.data, W, H, w, h);
  const { mean, sd } = frameStats(small, w, h);
  const encoded = jpeg.encode({ data: small, width: w, height: h }, quality).data;
  return { jpeg: Buffer.from(encoded), W, H, w, h, mean, sd };
}

/**
 * Run the pipeline on a PNG file in a fresh worker. Resolves { jpeg (Buffer),
 * W, H, w, h, mean, sd }; rejects on a decode error, a worker failure or the
 * timeout (the worker is terminated).
 */
function processFrame(pngPath, px, quality, { timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { brickproofImage: true, pngPath, px, quality } });
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`image conversion timed out after ${timeoutMs / 1000} s`));
      worker.terminate();
    }, timeoutMs);
    worker.once('message', m => {
      if (m && m.ok) finish(null, { ...m.result, jpeg: Buffer.from(m.result.jpeg) });
      else finish(new Error((m && m.error) || 'image worker returned nothing'));
    });
    worker.once('error', e => finish(e));
    worker.once('exit', code => finish(new Error(`image worker exited with code ${code} before answering`)));
  });
}

/** A PNG of the given size, pixels from fill(x, y) -> [r, g, b]. For check and fixtures. */
function makePng(width, height, fill) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      const p = (y * width + x) * 4;
      png.data[p] = r; png.data[p + 1] = g; png.data[p + 2] = b; png.data[p + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

if (!isMainThread && workerData && workerData.brickproofImage) {
  try {
    const buf = fs.readFileSync(workerData.pngPath);
    const result = processPngBuffer(buf, workerData.px, workerData.quality);
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
  }
}

module.exports = {
  DARK_MEAN_THRESHOLD, DARK_SD_THRESHOLD, IMAGE_TIMEOUT_MS,
  fitSize, resizeArea, frameStats, isDark, processPngBuffer, processFrame, makePng,
};
