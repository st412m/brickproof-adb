'use strict';
/**
 * ui.js — screen and input.
 *
 * ⚠ Screenshot: file pipeline only. `adb exec-out screencap -p` writes the PNG
 * into a temp file, image.js reads it in a worker. Never pipe exec-out into
 * the converter and never buffer the PNG in this thread.
 *
 * parseUiNodes returns structure and formatting is separate, so
 * adb_find_and_tap never parses its own text.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  adb, adbSh, spawnAdb, withSerial, sq, text, escapeInputText, describeAdbFailure, friendlyAdbError,
  makeTempDir, ADB_TIMEOUT_MS,
} = require('./adb.js');
const { resumedActivity } = require('./device.js');
const image = require('./image.js');

const { DARK_MEAN_THRESHOLD, DARK_SD_THRESHOLD } = image;

// TTL of a screenshot's geometry for coords="screenshot".
const SCREENSHOT_GEOM_TTL_MS = 120000;

/**
 * The geometry object of a processed frame: W/H original, w/h downscaled,
 * mean/sd of the downscaled frame, sx/sy frame-to-image ratio, dark. A field
 * that is not a finite number is null, never 0 (0 is a valid mean).
 */
function geometryOf(r) {
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const W = num(r && r.W), H = num(r && r.H), w = num(r && r.w), h = num(r && r.h);
  const mean = num(r && r.mean), sd = num(r && r.sd);
  return {
    W, H, w, h, mean, sd,
    sx: (W && w) ? W / w : null,
    sy: (H && h) ? H / h : null,
    dark: (mean !== null && sd !== null) ? (mean < DARK_MEAN_THRESHOLD && sd < DARK_SD_THRESHOLD) : null,
  };
}

/**
 * `wm size` prints `Override size: WxH` apart from `Physical size: WxH` when
 * the system runs a logical size different from the screencap buffer (a TV box
 * at 1920x1080 over a 3840x2160 panel). `input tap` and uiautomator work in the
 * Override size; a device without that line has Physical as its only space.
 * Parsed by line: the order is not guaranteed and Override may be absent.
 */
function parseWmSize(raw) {
  const t = String(raw || '');
  const phys = /Physical size:\s*(\d+)x(\d+)/.exec(t);
  const over = /Override size:\s*(\d+)x(\d+)/.exec(t);
  const physical = phys ? { w: +phys[1], h: +phys[2] } : null;
  const override = over ? { w: +over[1], h: +over[2] } : null;
  return { physical, override, logical: override || physical };
}

/**
 * Reconcile the PNG frame with `wm size` into the size `input tap` and
 * uiautomator use: "screen" in the response, and the clamp of
 * coords="screenshot".
 *
 * Override always wins over Physical. When `wm size` did not parse, the frame
 * size is used and flagged (fallback: true), to be shown in the response.
 * Orientation follows the PNG, the captured frame being the truth about the
 * current rotation: a landscape PNG with a portrait logical size swaps W/H.
 */
function reconcileScreenSize(frameW, frameH, wmsize) {
  const logical = wmsize && wmsize.logical;
  if (!logical) return { screenW: frameW, screenH: frameH, frameW, frameH, fallback: true };

  let { w, h } = logical;
  const frameLandscape = frameW >= frameH;
  const logicalLandscape = w >= h;
  if (frameLandscape !== logicalLandscape) { const t = w; w = h; h = t; }

  return { screenW: w, screenH: h, frameW, frameH, fallback: false };
}

/**
 * Capture and process one screenshot. `wm size` is read fresh for every
 * frame (the logical size can change between two frames when the display
 * mode follows the content); its failure does not fail the screenshot.
 * Stage errors: adb exec-out screencap failed / timed out, screencap produced
 * no data, image conversion failed.
 */
async function screenshotPipeline(serial, px, q) {
  let wmRaw = '';
  try { wmRaw = (await adb(withSerial(serial, ['shell', 'wm size']))).toString(); } catch { /* fallback below */ }
  const wmsize = parseWmSize(wmRaw);

  const dir = makeTempDir();
  try {
    const png = path.join(dir, 's.png');
    const fd = fs.openSync(png, 'w');
    let r;
    try {
      r = await spawnAdb(withSerial(serial, ['exec-out', 'screencap', '-p']), fd, { timeout: ADB_TIMEOUT_MS });
    } finally {
      fs.closeSync(fd);
    }
    if (r.timedOut)
      throw new Error(`adb exec-out screencap timed out after ${ADB_TIMEOUT_MS / 1000} s and was killed`);
    if (r.code !== 0) {
      const why = r.stderr.trim() ? friendlyAdbError(r.stderr.trim())
        : describeAdbFailure({ code: r.code, signal: r.signal }, '', '', withSerial(serial, ['exec-out', 'screencap', '-p']));
      throw new Error(`adb exec-out screencap failed: ${why}`);
    }
    if (!fs.statSync(png).size) throw new Error('screencap produced no data (device asleep or protected content?)');

    let frame;
    try {
      frame = await image.processFrame(png, px, q);
    } catch (e) {
      throw new Error(`image conversion failed: ${e.message}`);
    }
    return { data: frame.jpeg.toString('base64'), geom: geometryOf(frame), wmsize };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Geometry of the last screenshot per device, the source of coords="screenshot"
// for adb_tap/adb_swipe. Keyed like uiXmlFresh (serial || '_default').
const lastScreenshotGeom = new Map();
const geomKey = serial => serial || '_default';

/** mWakefulness from dumpsys power (Awake|Asleep|Dozing|Dreaming); null on failure. */
async function wakefulness(serial) {
  try {
    const out = (await adb(withSerial(serial, ['shell', 'dumpsys power 2>/dev/null | grep -m1 mWakefulness=']))).toString();
    const m = out.match(/mWakefulness=(\w+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * The command that prints the fl= line of the FOCUSED window, filtered on the
 * device (the full `dumpsys window windows` is hundreds of KB). The focused
 * hash comes from mCurrentFocus anywhere in the output. fl= is taken only from
 * the block whose header has both `Window #` and `Window{<hash> ` (the space
 * keeps a shorter hash from matching a longer one). A header of the NEXT
 * window before any fl= ends the block with no output: "not determined".
 */
function buildSecureFlagCmd() {
  return (
    'F=$(dumpsys window windows 2>/dev/null | sed -n "s/.*mCurrentFocus=Window{\\([0-9a-f]*\\) .*/\\1/p" | head -1); ' +
    '[ -n "$F" ] && dumpsys window windows 2>/dev/null | awk -v f="$F" \'' +
      '$0 ~ /Window #/ && index($0, "Window{" f " ") { phase=1; next } ' +
      'phase==1 && / fl=/ { print; exit } ' +
      'phase==1 && $0 ~ /Window #/ { exit }' +
    '\''
  );
}

/**
 * ⚠ The fl= format is not verified on any SDK, so only two forms are read and
 * anything else is null, not false:
 *  · numeric (`fl=#<hex>` or `fl=0x<hex>`): FLAG_SECURE is bit 0x00002000;
 *  · named (flags joined by `,`/`|`/`[...]`): SECURE as a separate token, so
 *    INSECURE_KEYGUARD does not match.
 */
function parseSecureFlag(line) {
  const m = /\bfl=(\S+)/.exec(String(line || ''));
  if (!m) return null;
  const v = m[1].replace(/[,;]+$/, '');

  if (/^#[0-9a-fA-F]+$/.test(v)) return !!(parseInt(v.slice(1), 16) & 0x00002000);
  if (/^0x[0-9a-fA-F]+$/i.test(v)) return !!(parseInt(v.slice(2), 16) & 0x00002000);

  if (/[A-Z]/.test(v) && /^[A-Z0-9_|,[\]]+$/.test(v)) {
    const tokens = v.split(/[|,[\]]+/).filter(Boolean);
    return tokens.includes('SECURE');
  }

  return null; // unknown form: no guess
}

async function secureWindowFlag(serial) {
  try {
    const out = (await adb(withSerial(serial, ['shell', buildSecureFlagCmd()]))).toString();
    return parseSecureFlag(out);
  } catch { return null; }
}

/**
 * The dark-frame warning. Called only when geom.dark === true, so a normal
 * frame costs no extra adb call. Each piece of evidence is optional: one that
 * cannot be read is left out, never guessed.
 */
async function darknessWarning(serial, geom) {
  const meanTxt = geom.mean !== null ? geom.mean.toFixed(3) : '?';
  const sdTxt = geom.sd !== null ? geom.sd.toFixed(3) : '?';
  const wake = await wakefulness(serial).catch(() => null);
  const secure = await secureWindowFlag(serial).catch(() => null);

  const parts = [];
  if (wake) parts.push(`screen: ${wake}`);
  if (secure === true) parts.push('focused window has FLAG_SECURE, content hidden by the system');
  else if (secure === false) parts.push('no protection flag found, the frame may genuinely be black');

  return `⚠ frame is almost uniformly dark (mean ${meanTxt}, sd ${sdTxt}).${parts.length ? ' ' + parts.join(', ') : ''}`;
}

async function screenshot(args) {
  const q = Math.min(Math.max(Math.round(args.quality || 70), 30), 95);
  const px = Math.min(Math.max(Math.round(args.max_px || 1024), 320), 1920);
  const serial = args.serial;

  let data, geom, wmsize;
  try {
    const r = await screenshotPipeline(serial, px, q);
    data = r.data; geom = r.geom; wmsize = r.wmsize;
  } catch (e) {
    // An empty capture: no frame at all, so mWakefulness is read separately.
    if (/screencap produced no data/i.test(e.message)) {
      const wake = await wakefulness(serial).catch(() => null);
      if (wake) throw new Error(`${e.message} (mWakefulness=${wake})`);
    }
    throw e;
  }

  let scaleTxt;
  if (geom && geom.W && geom.H && geom.w && geom.h) {
    // input tap and uiautomator work in the LOGICAL size (wm size Override if
    // present, else Physical), not in the PNG frame size; the scale is
    // computed against it.
    const rec = reconcileScreenSize(geom.W, geom.H, wmsize);
    const sx = rec.screenW / geom.w;
    const sy = rec.screenH / geom.h;

    lastScreenshotGeom.set(geomKey(serial),
      { W: rec.screenW, H: rec.screenH, w: geom.w, h: geom.h, sx, sy, ts: Date.now() });

    // The frame size is shown only when it differs from the logical size.
    const frameNote = (rec.frameW !== rec.screenW || rec.frameH !== rec.screenH)
      ? ` (frame ${rec.frameW}x${rec.frameH})` : '';
    const fallbackNote = rec.fallback
      ? ' ⚠ wm size did not parse, the frame size is used - coordinates may not match input tap' : '';

    scaleTxt = `screen ${rec.screenW}x${rec.screenH}${frameNote} -> image ${geom.w}x${geom.h} · scale ${sx.toFixed(3)}/${sy.toFixed(3)} · ` +
      `pass coords="screenshot" to adb_tap/adb_swipe${fallbackNote}`;
  } else {
    // No geometry for this frame: coords="screenshot" is unavailable rather
    // than guessed.
    scaleTxt = `frame geometry not determined - use coords="screen" (the default) for adb_tap/adb_swipe`;
  }

  const warnTxt = (geom && geom.dark === true) ? '\n' + await darknessWarning(serial, geom) : '';

  return [
    { type: 'image', data, mimeType: 'image/jpeg' },
    { type: 'text', text: scaleTxt + warnTxt },
  ];
}

/**
 * uiautomator returns XML, so line breaks and specials in labels arrive as
 * entities. Numeric forms (&#10;, &#x41;) are decoded too, and `&amp;` last,
 * or `&amp;lt;` would become `<`.
 */
function decodeXmlEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** A uiautomator dump as a list of nodes. */
function parseUiNodes(xml) {
  const nodes = [];
  const re = /<node[^>]*\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const attr = name => {
      const a = tag.match(new RegExp(`${name}="([^"]*)"`));
      return a ? a[1] : '';
    };
    const bounds = attr('bounds');
    const b = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    const clickable = attr('clickable') === 'true';
    const txt = decodeXmlEntities(attr('text'));
    const desc = decodeXmlEntities(attr('content-desc'));
    const rid = attr('resource-id');
    const focused = attr('focused') === 'true';
    // A password field is listed even without clickable/text/desc, otherwise
    // it is invisible in the dump. Matching (nodeMatches) is unaffected.
    const password = attr('password') === 'true';
    if (!clickable && !txt && !desc && !focused && !password) continue;
    if (!b) continue;
    nodes.push({
      text: txt, desc, resourceId: rid, clickable, focused, password, bounds,
      box: [+b[1], +b[2], +b[3], +b[4]],
      x: Math.round((+b[1] + +b[3]) / 2),
      y: Math.round((+b[2] + +b[4]) / 2),
    });
  }
  return nodes;
}

function formatUiNodes(nodes) {
  if (!nodes.length) return '(no interactive/labeled nodes found)';
  return nodes.map(n =>
    `${n.clickable ? '[BTN]' : '[TXT]'}${n.focused ? '[FOCUSED]' : ''}${n.password ? '[PASSWORD]' : ''} ` +
    `${n.text || n.desc || (n.password ? '(password field)' : '(no text)')}` +
    `${n.resourceId ? ` id=${n.resourceId.split('/').pop()}` : ''}` +
    ` @(${n.x},${n.y}) bounds=${n.bounds}`
  ).join('\n');
}

// uiautomator can return a stale dump right after the screen changes.
const lastUiDumpHash = new Map();

// ------------------------------------------------------------------ UI dump

const DUMP_DIR = '/sdcard';
const DUMP_MARKER = '__BRICKPROOF_XML__';

/**
 * One device shell for the whole dump: sweep dump files older than 2 minutes
 * (this server's and those of ha-adb-mcp 1.x), dump, print a marker, print
 * the file, remove it. The file name is random, so parallel callers never
 * share one.
 *
 * `/sdcard/` keeps its trailing slash: /sdcard is a symlink, and find does not
 * descend into a starting symlink without it. No find or no -delete: the sweep
 * is skipped silently.
 *
 * ⚠ On a timeout the adb client is killed and the `rm` at the end does not
 * run. A file left that way is removed by the sweep of a later dump, not by
 * this shell.
 */
function buildDumpCommand(name) {
  const file = path.posix.join(DUMP_DIR, name);
  const sweep = pattern => `find ${DUMP_DIR}/ -maxdepth 1 -name ${sq(pattern)} -mmin +2 -delete 2>/dev/null`;
  return `${sweep('brickproof_ui_*.xml')}; ${sweep('adbmcp_ui_*.xml')}; ` +
    `uiautomator dump ${sq(file)} 2>&1; echo ${DUMP_MARKER}; cat ${sq(file)} 2>/dev/null; rm -f ${sq(file)}`;
}

/**
 * Split the dump shell output at the marker: before it uiautomator's own
 * output (stderr is merged on devices without shell v2 too), after it the XML.
 * No marker or an empty XML is an error carrying uiautomator's output.
 */
function parseDumpOutput(out) {
  const s = String(out || '');
  const at = s.indexOf(DUMP_MARKER);
  const status = (at === -1 ? s : s.slice(0, at)).trim();
  if (!/dumped to/i.test(status) && /error/i.test(status)) throw new Error(`uiautomator: ${status}`);
  if (at === -1) throw new Error(`uiautomator: no dump output${status ? ` (${status})` : ''}`);
  const xml = s.slice(at + DUMP_MARKER.length).replace(/^\r?\n/, '');
  if (!xml.trim()) throw new Error(`uiautomator: ${status || 'the dump is empty'}`);
  return xml;
}

// Dumps of one device run one at a time in this process.
const dumpQueues = new Map();

function serialized(key, fn) {
  const prev = dumpQueues.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const tail = run.catch(() => {});
  dumpQueues.set(key, tail);
  tail.then(() => { if (dumpQueues.get(key) === tail) dumpQueues.delete(key); });
  return run;
}

// The queue wraps this function itself, so callers (uiXmlFresh, runVerify)
// never hold a slot while waiting for another dump.
// "null root node" often clears on a second try a moment later (a watch,
// a window in transition): one retry after DUMP_RETRY.delayMs.
const DUMP_RETRY = { delayMs: 1000 };

function dumpXml(serial) {
  return serialized(serial || '_default', async () => {
    const once = async () => {
      const name = `brickproof_ui_${crypto.randomBytes(4).toString('hex')}.xml`;
      return parseDumpOutput((await adb(withSerial(serial, ['shell', buildDumpCommand(name)]))).toString());
    };
    try {
      return await once();
    } catch (e) {
      if (!/null root node/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, DUMP_RETRY.delayMs));
      return once();
    }
  });
}

async function uiXmlFresh(serial) {
  const key = serial || '_default';
  let xml = await dumpXml(serial);
  const h = x => crypto.createHash('md5').update(x).digest('hex');
  if (lastUiDumpHash.get(key) === h(xml)) {
    await new Promise(r => setTimeout(r, 600));
    xml = await dumpXml(serial);
  }
  lastUiDumpHash.set(key, h(xml));
  return xml;
}

async function uiDump(args) {
  const xml = await uiXmlFresh(args.serial);
  return text(formatUiNodes(parseUiNodes(xml)));
}

/**
 * coords="screen" (default): coordinates as given. coords="screenshot":
 * coordinates off the adb_screenshot image, rescaled by its stored scale;
 * refused when there is no screenshot for this key or it is older than the
 * TTL. Rotation between screenshot and tap is not checked (said in the tool
 * description).
 */
function resolveCoord(coordsMode, x, y, serial) {
  const mode = coordsMode === 'screenshot' ? 'screenshot' : 'screen';
  if (mode === 'screen') return { x: Math.round(x), y: Math.round(y), note: '' };

  const g = lastScreenshotGeom.get(geomKey(serial));
  if (!g || (Date.now() - g.ts) > SCREENSHOT_GEOM_TTL_MS)
    throw new Error(
      'the screenshot is stale or was never taken - call adb_screenshot. ' +
      'Pass serial the same way as in adb_screenshot: a screenshot without serial and a tap with serial are different keys.');

  const xi = Math.round(x), yi = Math.round(y);
  const xOut = Math.min(Math.max(Math.round(xi * g.sx), 0), g.W - 1);
  const yOut = Math.min(Math.max(Math.round(yi * g.sy), 0), g.H - 1);
  return { x: xOut, y: yOut, note: ` - from screenshot coordinates (${xi},${yi}) × ${g.sx.toFixed(3)}/${g.sy.toFixed(3)}` };
}

/**
 * verify compares before and after an action. A failure of the check itself
 * never turns the performed action into an error: act() has already run when
 * anything in the check can break.
 */
async function runVerify(serial, mode, act) {
  if (mode !== 'activity' && mode !== 'ui') {
    await act();
    return { note: '', changed: null };
  }

  const safe = async fn => {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, error: e.message }; }
  };

  const beforeR = await safe(() => resumedActivity(serial));
  const xmlBeforeR = mode === 'ui' ? await safe(() => dumpXml(serial)) : null;

  await act();
  await new Promise(r => setTimeout(r, 700));

  const afterR = await safe(() => resumedActivity(serial));

  const comp = r => (r && r.ok && r.value.component) ? r.value.component : null;
  const b = comp(beforeR), a = comp(afterR);
  let activityTxt;
  if (!beforeR.ok && !afterR.ok) activityTxt = `resumed: unknown (${afterR.error || beforeR.error})`;
  else if (b === null || a === null) activityTxt = 'resumed: unknown';
  else if (b === a) activityTxt = `resumed: unchanged (${b})`;
  else activityTxt = `resumed: ${b} -> ${a}`;

  if (mode === 'activity') return { note: ` · ${activityTxt}`, changed: null };

  if (!xmlBeforeR.ok)
    return { note: ` · ${activityTxt} · ui: unknown (${xmlBeforeR.error})`, changed: null };

  let xmlAfterR = await safe(() => dumpXml(serial));
  if (!xmlAfterR.ok)
    return { note: ` · ${activityTxt} · ui: unknown (${xmlAfterR.error})`, changed: null };

  let changed = hashUiXml(xmlBeforeR.value) !== hashUiXml(xmlAfterR.value);
  if (!changed) {
    // Equal hashes: an animation may still be running; wait and compare once more.
    await new Promise(r => setTimeout(r, 600));
    const retryR = await safe(() => dumpXml(serial));
    if (retryR.ok) changed = hashUiXml(xmlBeforeR.value) !== hashUiXml(retryR.value);
  }
  return { note: ` · ${activityTxt} · ui: ${changed ? 'changed' : 'unchanged'}`, changed };
}

/**
 * The dump before hashing: nodes of `package="com.android.systemui"` are
 * dropped (the status-bar clock would report a change on every verify=ui).
 * Focus and selection are kept: for DPAD that is the change being measured.
 */
function normalizeUiXmlForHash(xml) {
  return String(xml || '').replace(/<node[^>]*\/?>/g, tag =>
    /\bpackage="com\.android\.systemui"/.test(tag) ? '' : tag);
}

function hashUiXml(xml) {
  return crypto.createHash('md5').update(normalizeUiXmlForHash(xml)).digest('hex');
}

async function tap(args) {
  const c = resolveCoord(args.coords, args.x, args.y, args.serial);
  const v = await runVerify(args.serial, args.verify,
    () => adb(withSerial(args.serial, ['shell', `input tap ${c.x} ${c.y}`])));
  return text(`Tapped (${c.x}, ${c.y})${c.note}${v.note}`);
}

async function swipe(args) {
  const c1 = resolveCoord(args.coords, args.x1, args.y1, args.serial);
  const c2 = resolveCoord(args.coords, args.x2, args.y2, args.serial);
  const d = args.duration_ms || 300;
  const v = await runVerify(args.serial, args.verify,
    () => adb(withSerial(args.serial, ['shell', `input swipe ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${Math.round(d)}`])));
  // For a swipe "unchanged" usually means the end of a list.
  const scrollHint = (v.changed === false) ? ' (for a scroll this usually means the end of the list)' : '';
  const note = c1.note || c2.note;
  return text(`Swiped (${c1.x},${c1.y}) -> (${c2.x},${c2.y}) in ${d}ms${note}${v.note}${scrollHint}`);
}

// How long typeText() waits for ADBKeyBoard to become the input method;
// replaced in tests.
const IME_TIMING = { pollMs: 250, windowMs: 2000 };

function isAdbIme(ime) {
  return /^com\.android\.adbkeyboard\/(?:com\.android\.adbkeyboard)?\.AdbIME$/.test(ime);
}

// The IME bridge of the Google TV remote service holds the keyboard while a
// remote client is connected (the Google TV app on a phone, the Android TV
// Remote integration of Home Assistant), and takes it back from ADBKeyBoard.
function imeHolderNote(ime) {
  return /^com\.google\.android\.tv\.remote\.service\//.test(ime)
    ? ' The keyboard is held by a connected Google TV remote (the Google TV app on a phone, or the Android TV Remote integration in Home Assistant); while it is connected, only Latin text can be typed (adb_text with ASCII works).'
    : '';
}

/**
 * mInputShown of `dumpsys input_method`: whether an on-screen keyboard is
 * shown, so a system text field has the focus. null when the line is missing.
 */
function parseInputShown(out) {
  const m = /\bmInputShown=(true|false)\b/.exec(String(out || ''));
  return m ? m[1] === 'true' : null;
}

async function inputShown(serial) {
  try {
    return parseInputShown(await adbSh(serial, 'dumpsys input_method 2>/dev/null | grep mInputShown'));
  } catch { return null; }
}

// The text is sent even without a shown keyboard: some keyboards of their
// own (Fire TV's) take ASCII while mInputShown is false. Only the answer
// changes. A TV box without a touchscreen opens the keyboard with OK on the
// field, not with a tap.
const NO_KEYBOARD = (n, tv) => `Sent ${n} chars, but no on-screen keyboard is shown, so no system text field seems to have focus: ` +
  (tv ? 'the text may have gone nowhere. Check with adb_screenshot. On a TV box, press OK on the field (adb_key DPAD_CENTER) to open the keyboard, then type again.'
    : 'the text may have gone nowhere. Check with adb_screenshot; tap the field first.');

async function isTvBox(serial) {
  try {
    const caps = await deviceCaps(serial);
    return caps.leanback && !caps.touchscreen;
  } catch { return false; }
}

async function typeText(args) {
  const serial = args.serial;
  const t = String(args.text);
  const shown = await inputShown(serial);
  const tv = shown === false && await isTvBox(serial);
  if (/^[\x20-\x7E]*$/.test(t)) {
    await adb(withSerial(serial, ['shell', `input text ${sq(escapeInputText(t))}`]));
    // Only the count: the text may be a password, and the caller knows it.
    return text(shown === false ? NO_KEYBOARD(t.length, tv) : `Typed ${t.length} chars (ASCII)`);
  }
  // Non-ASCII through ADBKeyBoard: `input text` has no unicode.
  const pkgs = (await adb(withSerial(serial, ['shell', 'pm list packages com.android.adbkeyboard']))).toString();
  if (!pkgs.includes('com.android.adbkeyboard'))
    throw new Error('Non-ASCII text requires ADBKeyBoard on the device. Install it (github.com/senzhk/ADBKeyBoard, pm install -r -t -g ADBKeyboard.apk from /data/local/tmp; adb_shell needs allow_shell), then retry.');
  const currentIme = async () => (await adb(withSerial(serial, ['shell', 'settings get secure default_input_method']))).toString().trim();
  const prevIme = await currentIme();
  const b64 = Buffer.from(t, 'utf8').toString('base64');
  try {
    await adb(withSerial(serial, ['shell', 'ime enable com.android.adbkeyboard/.AdbIME >/dev/null 2>&1; ime set com.android.adbkeyboard/.AdbIME']));
    // `ime set` says "selected" also when another input method takes the
    // keyboard back right after: what counts is the setting itself.
    let ime = '';
    for (const deadline = Date.now() + IME_TIMING.windowMs; ;) {
      await new Promise(r => setTimeout(r, IME_TIMING.pollMs));
      ime = await currentIme();
      if (isAdbIme(ime) || Date.now() >= deadline) break;
    }
    if (!isAdbIme(ime))
      throw new Error(`Nothing was typed: the input method is ${ime || '(none)'} instead of ADBKeyBoard, so non-Latin text cannot be typed now.${imeHolderNote(ime)}`);
    await adb(withSerial(serial, ['shell', `am broadcast -a ADB_INPUT_B64 --es msg ${b64}`]));
    const after = await currentIme();
    if (!isAdbIme(after))
      throw new Error(`The text may not have been typed: the input method changed to ${after || '(none)'} during typing.${imeHolderNote(after)}`);
  } finally {
    if (prevIme && prevIme !== 'null' && !prevIme.includes('adbkeyboard'))
      await adb(withSerial(serial, ['shell', `ime set ${prevIme}`])).catch(() => {});
  }
  return text(shown === false
    ? `${NO_KEYBOARD(t.length, tv)} Non-Latin text reaches only a system text field.`
    : `Typed ${t.length} chars (unicode via ADBKeyBoard)`);
}

async function key(args) {
  const k = /^\d+$/.test(args.key) ? args.key : `KEYCODE_${args.key.toUpperCase().replace(/^KEYCODE_/, '')}`;
  const v = await runVerify(args.serial, args.verify,
    () => adb(withSerial(args.serial, ['shell', `input keyevent ${k}`])));
  return text(`Sent keyevent ${k}${v.note}`);
}

/**
 * Input capabilities are read off the device, not guessed from the model.
 * Leanback devices commonly report no android.hardware.touchscreen (only
 * leanback_only, sometimes faketouch), and a coordinate tap there activates
 * whatever has focus. A phone takes the tap path with the same code.
 */
async function deviceCaps(serial) {
  const out = (await adb(withSerial(serial, ['shell', 'pm list features']))).toString();
  const has = f => out.includes(`feature:${f}`);
  return {
    touchscreen: has('android.hardware.touchscreen'),
    faketouch: has('android.hardware.faketouch'),
    leanback: has('android.software.leanback') || has('android.software.leanback_only'),
  };
}

const norm = s => String(s || '').trim().toLowerCase();

/** Whether a node matches the requested criteria. */
function nodeMatches(n, args) {
  const exact = args.exact === true || args.exact === 'true';
  const cmp = (hay, needle) => {
    const h = norm(hay), x = norm(needle);
    if (!x) return false;
    return exact ? h === x : h.includes(x);
  };
  if (args.resource_id) {
    // both the full id and the part after '/'
    const rid = norm(n.resourceId), tail = norm(String(n.resourceId).split('/').pop());
    const want = norm(args.resource_id);
    if (!(exact ? (rid === want || tail === want) : (rid.includes(want) || tail.includes(want)))) return false;
  }
  // `text` searches text and content-desc: some TV launchers put every label
  // in content-desc. What is searched must equal what "Visible now" shows.
  // `desc` stays narrow: content-desc only.
  if (args.text && !(cmp(n.text, args.text) || cmp(n.desc, args.text))) return false;
  if (args.desc && !cmp(n.desc, args.desc)) return false;
  return !!(args.resource_id || args.text || args.desc);
}

/**
 * A node's label. TV launcher containers are focusable but carry no text; the
 * text is in a child. The parser is flat, so the child is found by geometry:
 * the smallest labelled node lying entirely inside this one.
 */
function nodeLabel(n, nodes) {
  if (n.text) return n.text;
  if (n.desc) return n.desc;
  if (!nodes || !n.box) return '';
  let best = null;
  for (const c of nodes) {
    if (c === n || !c.box || !(c.text || c.desc)) continue;
    const b = c.box, o = n.box;
    if (b[0] < o[0] || b[1] < o[1] || b[2] > o[2] || b[3] > o[3]) continue;
    const area = (b[2] - b[0]) * (b[3] - b[1]);
    if (!best || area < best.area) best = { area, label: c.text || c.desc };
  }
  return best ? best.label : '';
}

/**
 * A stable node identity: bounds move when scrolling, text does not. Textless
 * containers get the label of their child, else their bounds (worse when
 * scrolling, better than every card sharing one key).
 */
const nodeKey = (n, nodes) => {
  const label = nodeLabel(n, nodes);
  return `${n.resourceId}|${n.text}|${n.desc}|${label || n.bounds}`;
};

// Pauses of the DPAD walk after a key and after DPAD_CENTER; replaced in tests.
const WALK_TIMING = { keyMs: 350, centerMs: 400 };

// Box helpers for the DPAD walk: [left, top, right, bottom].
const boxContains = (o, b) => o[0] <= b[0] && o[1] <= b[1] && o[2] >= b[2] && o[3] >= b[3];
const centreDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** The area every node of a dump covers: the screen, as far as the dump shows it. */
function screenBox(nodes) {
  const boxes = nodes.filter(n => n.box).map(n => n.box);
  if (!boxes.length) return null;
  return [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])),
    Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
}

/**
 * The key to press from `cur` towards `target`, and the one on the other
 * axis: [primary, alternate].
 *  • The target wholly on one side along one axis and overlapping along the
 *    other: that side (a row right below the focus is DOWN, however far its
 *    centre lies to the right).
 *  • The focus contains the target (a full-screen banner): the focus has no
 *    position of its own; the directions count from the centre of the screen.
 *  • Otherwise: by the centres, the larger offset first.
 */
function stepDirections(cur, target, screen) {
  const h = (tx, cx) => (tx > cx ? 'DPAD_RIGHT' : 'DPAD_LEFT');
  const v = (ty, cy) => (ty > cy ? 'DPAD_DOWN' : 'DPAD_UP');
  const byCentre = (cx, cy) => (Math.abs(target.x - cx) > Math.abs(target.y - cy)
    ? [h(target.x, cx), v(target.y, cy)]
    : [v(target.y, cy), h(target.x, cx)]);
  const c = cur.box, t = target.box;
  if (c && t) {
    if (boxContains(c, t)) {
      const s = screen || c;
      return byCentre((s[0] + s[2]) / 2, (s[1] + s[3]) / 2);
    }
    const xOverlap = t[0] < c[2] && t[2] > c[0];
    const yOverlap = t[1] < c[3] && t[3] > c[1];
    if (xOverlap && (t[1] >= c[3] || t[3] <= c[1])) return [t[1] >= c[3] ? 'DPAD_DOWN' : 'DPAD_UP', h(target.x, cur.x)];
    if (yOverlap && (t[0] >= c[2] || t[2] <= c[0])) return [t[0] >= c[2] ? 'DPAD_RIGHT' : 'DPAD_LEFT', v(target.y, cur.y)];
  }
  return byCentre(cur.x, cur.y);
}

async function currentWindow(serial) {
  try {
    const o = (await adb(withSerial(serial, ['shell', 'dumpsys window 2>/dev/null | grep -m1 mCurrentFocus']))).toString();
    return o.trim();
  } catch { return ''; }
}

/**
 * Find an element by text / resource-id / content-desc and activate it.
 *
 * The method is derived, not chosen:
 *  • touchscreen → `input tap` at the element centre;
 *  • leanback without touchscreen → walk the focus with DPAD keys, then
 *    DPAD_CENTER. A coordinate tap there activates the CURRENT focus, the
 *    worst kind of failure: silent and wrong.
 *
 * No step counts without a check: the dump is taken again after every key and
 * the focus compared. A stalled or cycling focus is an honest refusal with the
 * path walked, never a look of success.
 */
async function findAndTap(args) {
  const serial = args.serial;
  if (!args.text && !args.resource_id && !args.desc)
    throw new Error('pass at least one criterion: text, resource_id or desc');

  const caps = await deviceCaps(serial);
  let nodes = parseUiNodes(await uiXmlFresh(serial));
  let hits = nodes.filter(n => nodeMatches(n, args));

  if (!hits.length) {
    // "Visible now": one line per label, keeping the variant with an id. A
    // container and the label inside it would otherwise be listed twice.
    const byLabel = new Map();
    for (const n of nodes) {
      const label = nodeLabel(n, nodes);
      if (!label) continue;
      const tail = n.resourceId ? n.resourceId.split('/').pop() : '';
      const prev = byLabel.get(label);
      if (prev === undefined) byLabel.set(label, tail);
      else if (!prev && tail) byLabel.set(label, tail);
    }
    const visible = [];
    for (const [label, tail] of byLabel) {
      visible.push(`  ${label}${tail ? ` [id=${tail}]` : ''}`);
      if (visible.length >= 40) break;
    }
    throw new Error(`Element not found. Visible now:\n${visible.join('\n') || '  (nothing with a label)'}`);
  }

  // A container and the label inside it are ONE element for the user, yet
  // both match: keep the outer clickable node, which a walk would reach.
  if (hits.length > 1) {
    hits = hits.filter(n => !hits.some(o =>
      o !== n && o.box && n.box &&
      nodeLabel(o, nodes) === nodeLabel(n, nodes) &&
      o.box[0] <= n.box[0] && o.box[1] <= n.box[1] &&
      o.box[2] >= n.box[2] && o.box[3] >= n.box[3] &&
      (o.clickable || !n.clickable) &&
      (o.box[2] - o.box[0]) * (o.box[3] - o.box[1]) > (n.box[2] - n.box[0]) * (n.box[3] - n.box[1])));
  }

  if (hits.length > 1 && args.index === undefined) {
    const list = hits.map((n, i) => `  [${i}] ${nodeLabel(n, nodes)} @(${n.x},${n.y})`).join('\n');
    throw new Error(`${hits.length} elements match the criteria - narrow the query or pass index:\n${list}`);
  }
  let target = hits[Math.min(Number(args.index) || 0, hits.length - 1)];
  const targetLabel = nodeLabel(target, nodes) || nodeKey(target, nodes);

  // On TV launchers the label sits in a non-focusable image and DPAD focus
  // lands on the card around it; a walk to the label itself never arrives.
  // The target is raised to the smallest clickable node containing it.
  if (!target.clickable && target.box) {
    let host = null;
    for (const c of nodes) {
      if (c === target || !c.clickable || !c.box) continue;
      const b = target.box, o = c.box;
      if (b[0] < o[0] || b[1] < o[1] || b[2] > o[2] || b[3] > o[3]) continue;
      const area = (o[2] - o[0]) * (o[3] - o[1]);
      if (!host || area < host.area) host = { area, node: c };
    }
    if (host) target = host.node;
  }
  let targetKey = nodeKey(target, nodes);
  const winBefore = await currentWindow(serial);

  // ── touchscreen ──
  if (caps.touchscreen) {
    await adb(withSerial(serial, ['shell', `input tap ${target.x} ${target.y}`]));
    const winAfter = await currentWindow(serial);
    return text(
      `Tapped "${targetLabel}" @(${target.x},${target.y}) - the device has a touchscreen.\n` +
      `Window ${winAfter && winAfter !== winBefore ? 'changed' : 'did NOT change (normal for in-screen actions)'}`);
  }

  // ── leanback: DPAD walk ──
  if (!caps.leanback)
    throw new Error('The device reports neither touchscreen nor leanback - there is no known way to activate the element. Refused instead of tapping blind.');

  // Every step is a full dump (~1.5-2 s): 12 steps by default and a clock
  // budget, so a report comes back before the client's call timeout.
  const maxSteps = Math.min(Math.max(Number(args.max_steps) || 12, 1), 40);
  const deadline = Date.now() + 25000;
  const trail = [];
  let stuck = 0;
  const visited = new Set();
  // A cycle, or a step that took the focus further from the target, switches
  // to the other axis once before the walk gives up: the axis of the key that
  // was pressed from the node seen again, or of the step that led away.
  let switched = false, avoidAxis = null;
  const usedFrom = new Map();
  const axisOf = d => (d === 'DPAD_LEFT' || d === 'DPAD_RIGHT' ? 'h' : 'v');

  for (let step = 0; step < maxSteps; step++) {
    const cur = nodes.find(n => n.focused);
    if (!cur) {
      throw new Error(
        `No focused element on screen - there is nothing to walk from. ` +
        `Press any key (adb_key DPAD_DOWN) and retry.${trail.length ? ` Walked: ${trail.join(' ')}` : ''}`);
    }
    const curKey = nodeKey(cur, nodes);
    if (curKey === targetKey) break;

    // The focus going round between a few nodes (typical when the target is
    // not focusable), not only a full stop.
    if (visited.has(curKey)) {
      if (switched) {
        throw new Error(
          `Focus is cycling: back on "${nodeLabel(cur, nodes) || '(no label)'}", already visited on this walk ` +
          `(${trail.join(' ')}). Target "${targetLabel}" cannot be reached by walking - it is most likely not focusable. ` +
          `Nothing was pressed.`);
      }
      switched = true;
      avoidAxis = axisOf(usedFrom.get(curKey));
    }
    visited.add(curKey);

    if (Date.now() > deadline) {
      throw new Error(
        `Walk stopped on its time budget after ${trail.length} step${trail.length === 1 ? '' : 's'} (${trail.join(' ')}), ` +
        `so a report is returned instead of a timeout. Focused now: "${nodeLabel(cur, nodes) || '(no label)'}", ` +
        `target "${targetLabel}" not reached. Nothing was pressed.`);
    }

    const [primary, secondary] = stepDirections(cur, target, screenBox(nodes));
    const dir = avoidAxis ? (axisOf(primary) !== avoidAxis ? primary : secondary)
      : stuck === 0 ? primary : secondary;
    avoidAxis = null;
    usedFrom.set(curKey, dir);

    await adb(withSerial(serial, ['shell', `input keyevent ${dir}`]));
    trail.push(dir.replace('DPAD_', ''));
    await new Promise(r => setTimeout(r, WALK_TIMING.keyMs));

    const prevKey = curKey;
    nodes = parseUiNodes(await uiXmlFresh(serial));
    const now = nodes.find(n => n.focused);
    // the target may have moved with a scroll: find it again by its key
    const again = nodes.find(n => nodeKey(n, nodes) === targetKey);
    if (again) target = again;

    if (now && nodeKey(now, nodes) === prevKey) {
      stuck++;
      if (stuck >= 2)
        throw new Error(
          `Focus does not move on either axis, still on "${nodeLabel(now, nodes) || '(no label)'}". ` +
          `Target "${targetLabel}" not reached in ${step + 1} step${step === 0 ? '' : 's'} (${trail.join(' ')}). ` +
          `Nothing was pressed - walk manually with adb_key.`);
    } else {
      stuck = 0;
      // Further from the target than before the step. Not judged when either
      // node contains the target (it has no position of its own), nor on a
      // node seen before: the cycle check takes that one.
      const placed = n => !(n.box && target.box && boxContains(n.box, target.box));
      if (!switched && now && placed(cur) && placed(now) && !visited.has(nodeKey(now, nodes)) &&
        centreDist(now, target) > centreDist(cur, target)) {
        switched = true;
        avoidAxis = axisOf(dir);
      }
    }
  }

  const finalFocus = nodes.find(n => n.focused);
  if (!finalFocus || nodeKey(finalFocus, nodes) !== targetKey)
    throw new Error(
      `Focus did not reach the target in ${maxSteps} steps (${trail.join(' ')}). ` +
      `Focused now: "${finalFocus ? (nodeLabel(finalFocus, nodes) || '(no label)') : 'nothing'}". ` +
      `Nothing was pressed. Raise max_steps or walk manually.`);

  await adb(withSerial(serial, ['shell', 'input keyevent DPAD_CENTER']));
  await new Promise(r => setTimeout(r, WALK_TIMING.centerMs));
  const winAfter = await currentWindow(serial);

  return text(
    `Activated "${targetLabel}" via DPAD (leanback device, no touchscreen).\n` +
    `Path: ${trail.length ? trail.join(' -> ') : 'already focused'} -> CENTER\n` +
    `Window ${winAfter && winAfter !== winBefore ? 'changed' : 'did NOT change (normal for in-screen actions)'}`);
}

module.exports = {
  screenshot, uiDump, tap, swipe, typeText, key, findAndTap, IME_TIMING, DUMP_RETRY, WALK_TIMING,
  stepDirections, screenBox, parseInputShown,
  parseUiNodes, formatUiNodes, uiXmlFresh, screenshotPipeline,
  deviceCaps, nodeMatches, nodeKey, decodeXmlEntities,
  geometryOf, hashUiXml, normalizeUiXmlForHash,
  resolveCoord, dumpXml, buildDumpCommand, parseDumpOutput, DUMP_MARKER,
  buildSecureFlagCmd, parseSecureFlag,
  parseWmSize, reconcileScreenSize,
  DARK_MEAN_THRESHOLD, DARK_SD_THRESHOLD, SCREENSHOT_GEOM_TTL_MS,
};
