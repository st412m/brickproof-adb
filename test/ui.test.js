'use strict';
// UI dump (one shell, marker, sweep, queue) and the screenshot path through a
// fake adb: wm size, exec-out into a file, the worker, the response text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../src/ui.js');
const I = require('../src/image.js');
const { tmpDir, useFakeAdb } = require('./helpers.js');

const XML = '<?xml version="1.0"?><hierarchy><node text="OK" bounds="[0,0][100,50]" clickable="true"/></hierarchy>';

test('the dump command: sweep both prefixes in /sdcard/, dump, marker, cat, rm, in one shell', () => {
  const cmd = U.buildDumpCommand('brickproof_ui_0a1b2c3d.xml');
  assert.equal(cmd,
    "find /sdcard/ -maxdepth 1 -name 'brickproof_ui_*.xml' -mmin +2 -delete 2>/dev/null; " +
    "find /sdcard/ -maxdepth 1 -name 'adbmcp_ui_*.xml' -mmin +2 -delete 2>/dev/null; " +
    "uiautomator dump '/sdcard/brickproof_ui_0a1b2c3d.xml' 2>&1; echo __BRICKPROOF_XML__; " +
    "cat '/sdcard/brickproof_ui_0a1b2c3d.xml' 2>/dev/null; rm -f '/sdcard/brickproof_ui_0a1b2c3d.xml'");
});

test('the dump output: XML after the marker, uiautomator errors before it', () => {
  assert.equal(U.parseDumpOutput(`UI hierchary dumped to: /sdcard/x.xml\n__BRICKPROOF_XML__\n${XML}`), XML);
  assert.equal(U.parseDumpOutput(`UI hierchary dumped to: /sdcard/x.xml\r\n__BRICKPROOF_XML__\r\n${XML}`), XML);
  assert.throws(() => U.parseDumpOutput('ERROR: null root node returned by UiTestAutomationBridge.\n__BRICKPROOF_XML__\n'),
    /^Error: uiautomator: ERROR: null root node returned by UiTestAutomationBridge\.$/);
  assert.throws(() => U.parseDumpOutput('Killed\n'), /^Error: uiautomator: no dump output \(Killed\)$/);
  assert.throws(() => U.parseDumpOutput('UI hierchary dumped to: /sdcard/x.xml\n__BRICKPROOF_XML__\n\n'), /^Error: uiautomator: UI hierchary dumped to/);
});

test('dumps of one device run one at a time; another device does not wait', async () => {
  const fake = useFakeAdb([
    { match: '-s slow shell', delayMs: 300, stdout: `dumped to\n__BRICKPROOF_XML__\n${XML}` },
    { match: 'shell', stdout: `dumped to\n__BRICKPROOF_XML__\n${XML}` },
  ]);
  const t0 = Date.now();
  const order = [];
  await Promise.all([
    U.dumpXml('slow').then(() => order.push(['slow1', Date.now() - t0])),
    U.dumpXml('slow').then(() => order.push(['slow2', Date.now() - t0])),
    U.dumpXml('fast').then(() => order.push(['fast', Date.now() - t0])),
  ]);
  const at = Object.fromEntries(order);
  assert.ok(at.fast < at.slow1, JSON.stringify(order));
  assert.ok(at.slow2 - at.slow1 >= 250, `the second dump of one device waits for the first: ${JSON.stringify(order)}`);
  const names = fake.log().map(a => /brickproof_ui_[0-9a-f]{8}\.xml/.exec(a.join(' '))[0]);
  assert.equal(new Set(names).size, 3, 'a random file per dump');
});

test('a failed dump does not block the queue', async () => {
  useFakeAdb([{ match: '-s bad shell', code: 1, stderr: 'error: closed\n' }, { match: 'shell', stdout: `dumped to\n__BRICKPROOF_XML__\n${XML}` }]);
  await assert.rejects(U.dumpXml('bad'), /error: closed/);
  useFakeAdb([{ match: 'shell', stdout: `dumped to\n__BRICKPROOF_XML__\n${XML}` }]);
  assert.equal(await U.dumpXml('bad'), XML);
});

test('wm size, reconcileScreenSize: Override wins, orientation from the frame, a flagged fallback', () => {
  const both = U.parseWmSize('Physical size: 3840x2160\nOverride size: 1920x1080\n');
  assert.deepEqual(both.logical, { w: 1920, h: 1080 });
  assert.deepEqual(U.reconcileScreenSize(3840, 2160, both), { screenW: 1920, screenH: 1080, frameW: 3840, frameH: 2160, fallback: false });
  assert.deepEqual(U.reconcileScreenSize(2340, 1080, U.parseWmSize('Physical size: 1080x2340')), { screenW: 2340, screenH: 1080, frameW: 2340, frameH: 1080, fallback: false });
  assert.deepEqual(U.reconcileScreenSize(800, 600, U.parseWmSize('')), { screenW: 800, screenH: 600, frameW: 800, frameH: 600, fallback: true });
});

test('geometryOf: null for what is not a number, dark only with both statistics', () => {
  assert.deepEqual(U.geometryOf({ W: 3840, H: 2160, w: 1024, h: 576, mean: 0, sd: 0 }),
    { W: 3840, H: 2160, w: 1024, h: 576, mean: 0, sd: 0, sx: 3.75, sy: 3.75, dark: true });
  assert.equal(U.geometryOf({ W: 10, H: 10, w: 5, h: 5, mean: NaN, sd: 0 }).dark, null);
});

test('parseSecureFlag: hex and named forms, anything else unknown', () => {
  assert.equal(U.parseSecureFlag('  fl=#81812100'), true);
  assert.equal(U.parseSecureFlag('  fl=0x01810100'), false);
  assert.equal(U.parseSecureFlag('fl=LAYOUT_IN_SCREEN|SECURE|HARDWARE_ACCELERATED'), true);
  assert.equal(U.parseSecureFlag('fl=INSECURE_KEYGUARD'), false);
  assert.equal(U.parseSecureFlag('fl=weird'), null);
  assert.equal(U.parseSecureFlag(''), null);
});

// ------------------------------------------------------------------ screenshot

function screenshotRules(png, wm = 'Physical size: 3840x2160\nOverride size: 1920x1080\n') {
  return [
    { match: 'shell wm size$', stdout: wm },
    { match: 'exec-out screencap -p$', stdoutFile: png },
    { match: 'dumpsys power', stdout: '  mWakefulness=Asleep\n' },
    { match: 'shell', stdout: '' },
  ];
}

test('screenshot: wm size, PNG into a file, the worker, the scale line against the logical size', async () => {
  const dir = tmpDir();
  const png = path.join(dir, 'frame.png');
  fs.writeFileSync(png, I.makePng(3840, 2160, (x, y) => [x % 256, y % 256, 90]));
  useFakeAdb(screenshotRules(png));
  // os.tmpdir() follows these variables, so the pipeline's temp dir lands here.
  const tmp = tmpDir();
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
  let r;
  try {
    r = await U.screenshot({ serial: '192.0.2.38:5555' });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(os.tmpdir() === tmp, false);
  assert.deepEqual(fs.readdirSync(tmp), [], 'the temporary directory is removed');
  assert.equal(r[0].type, 'image');
  assert.equal(r[0].mimeType, 'image/jpeg');
  assert.equal(Buffer.from(r[0].data, 'base64')[0], 0xff);
  assert.equal(r[1].text, 'screen 1920x1080 (frame 3840x2160) -> image 1024x576 · scale 1.875/1.875 · pass coords="screenshot" to adb_tap/adb_swipe');
  assert.deepEqual(U.resolveCoord('screenshot', 512, 288, '192.0.2.38:5555'),
    { x: 960, y: 540, note: ' - from screenshot coordinates (512,288) × 1.875/1.875' });
  assert.throws(() => U.resolveCoord('screenshot', 1, 1, undefined), /the screenshot is stale or was never taken/);
});

test('screenshot: a dark frame gets the warning with the evidence that could be read', async () => {
  const dir = tmpDir();
  const png = path.join(dir, 'black.png');
  fs.writeFileSync(png, I.makePng(1080, 2340, () => [0, 0, 0]));
  useFakeAdb(screenshotRules(png, 'Physical size: 1080x2340\n'));
  const r = await U.screenshot({});
  assert.equal(r[1].text, 'screen 1080x2340 -> image 473x1024 · scale 2.283/2.285 · pass coords="screenshot" to adb_tap/adb_swipe\n' +
    '⚠ frame is almost uniformly dark (mean 0.000, sd 0.000). screen: Asleep');
});

test('screenshot: wm size failing is a flagged fallback, not a failure', async () => {
  const dir = tmpDir();
  const png = path.join(dir, 'f.png');
  fs.writeFileSync(png, I.makePng(800, 600, () => [100, 100, 100]));
  useFakeAdb([{ match: 'wm size', code: 1, stderr: 'error\n' }, { match: 'exec-out', stdoutFile: png }]);
  const r = await U.screenshot({});
  assert.equal(r[1].text, 'screen 800x600 -> image 800x600 · scale 1.000/1.000 · pass coords="screenshot" to adb_tap/adb_swipe' +
    ' ⚠ wm size did not parse, the frame size is used - coordinates may not match input tap');
});

test('screenshot: stage errors — empty capture, adb failure, not an image', async () => {
  const dir = tmpDir();
  const empty = path.join(dir, 'empty.png');
  fs.writeFileSync(empty, '');
  useFakeAdb(screenshotRules(empty, 'Physical size: 1080x2340\n'));
  await assert.rejects(U.screenshot({}), /^Error: screencap produced no data \(device asleep or protected content\?\) \(mWakefulness=Asleep\)$/);

  useFakeAdb([{ match: 'wm size', stdout: '' }, { match: 'exec-out', code: 1, stderr: 'error: device offline\n' }]);
  await assert.rejects(U.screenshot({}), /^Error: adb exec-out screencap failed: error: device offline\. The TCP session died/);

  const junk = path.join(dir, 'junk.png');
  fs.writeFileSync(junk, 'not a png at all');
  useFakeAdb([{ match: 'wm size', stdout: '' }, { match: 'exec-out', stdoutFile: junk }]);
  await assert.rejects(U.screenshot({}), /^Error: image conversion failed: /);
});

test('typeText: the ADBKeyBoard hint says adb_shell needs allow_shell', async () => {
  useFakeAdb([{ match: 'pm list packages', stdout: '' }]);
  await assert.rejects(U.typeText({ text: 'привет' }), /adb_shell needs allow_shell\), then retry\.$/);
});

test('adb_text: one layer of quoting - the device shell gets sq() of the text, input text only its own %s for a space', async () => {
  const fake = useFakeAdb([{ match: 'input text', stdout: '' }]);
  const typed = `bp "q1" 'q2' back\\slash & semi;colon | $HOME \`id\` (x) *? <a> 100% end`;
  const r = await U.typeText({ serial: '192.0.2.50:5555', text: typed });
  assert.equal(r[0].text, `Typed ${typed.length} chars (ASCII)`);
  assert.deepEqual(fake.log().filter(a => a[3].startsWith('input text')), [['-s', '192.0.2.50:5555', 'shell',
    `input text 'bp%s"q1"%s'\\''q2'\\''%sback\\slash%s&%ssemi;colon%s|%s$HOME%s\`id\`%s(x)%s*?%s<a>%s100%%send'`]]);
  // What a POSIX shell (the device's) makes of it: exactly the argument of input text.
  const sent = fake.log().find(a => a[3].startsWith('input text '))[3];
  const sh = require('child_process').spawnSync('sh', ['-c', `printf '%s' ${sent.slice('input text '.length)}`], { encoding: 'utf8' });
  if (!sh.error) assert.equal(sh.stdout, typed.replace(/ /g, '%s'));
});

// ------------------------------------------------ adb_text through ADBKeyBoard

const LATIN = 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME';
const ADB_IME = 'com.android.adbkeyboard/.AdbIME';
const REMOTE = 'com.google.android.tv.remote.service/.ImeBridgeService';

// The fake device: the input method setting answers `imes` one after another
// (the last one from then on).
async function typeUnicode(imes, shown) {
  const rules = [
    ...(shown === undefined ? [] : [{ match: 'dumpsys input_method', stdout: `  mInputShown=${shown}\n` }]),
    { match: 'pm list packages com\\.android\\.adbkeyboard', stdout: 'package:com.android.adbkeyboard\n' },
    { match: 'ime enable', stdout: `Input method ${ADB_IME} selected for user #0\n` },
    { match: 'am broadcast', stdout: 'Broadcasting: Intent { act=ADB_INPUT_B64 flg=0x400000 }\nBroadcast completed: result=0\n' },
    { match: '^-s \\S+ shell ime set ', stdout: 'Input method selected\n' },
    ...imes.map((ime, i) => ({ match: 'settings get secure default_input_method', stdout: `${ime}\n`, once: i < imes.length - 1 })),
  ];
  const fake = useFakeAdb(rules);
  const saved = { ...U.IME_TIMING };
  Object.assign(U.IME_TIMING, { pollMs: 10, windowMs: 200 });
  try {
    return { result: await U.typeText({ serial: '192.0.2.38:5555', text: 'Привет' }).then(r => r[0].text, e => e), log: fake.log().map(a => a.slice(3).join(' ')) };
  } finally {
    Object.assign(U.IME_TIMING, saved);
  }
}

test('adb_text unicode: ADBKeyBoard takes the keyboard - typed; the previous input method comes back', async () => {
  const { result, log } = await typeUnicode([LATIN, LATIN, ADB_IME]);
  assert.equal(result, 'Typed 6 chars (unicode via ADBKeyBoard)');
  assert.ok(log.some(c => c.startsWith('am broadcast -a ADB_INPUT_B64')));
  assert.equal(log[log.length - 1], `ime set ${LATIN}`);
});

test('adb_text unicode: another input method keeps the keyboard - an error naming it, nothing sent; restored', async () => {
  const { result, log } = await typeUnicode([LATIN, REMOTE]);
  assert.ok(result instanceof Error);
  assert.equal(result.message, `Nothing was typed: the input method is ${REMOTE} instead of ADBKeyBoard, so non-Latin text cannot be typed now. ` +
    'The keyboard is held by a connected Google TV remote (the Google TV app on a phone, or the Android TV Remote integration in Home Assistant); while it is connected, only Latin text can be typed (adb_text with ASCII works).');
  assert.ok(!log.some(c => c.startsWith('am broadcast')), 'the broadcast was not sent');
  assert.equal(log[log.length - 1], `ime set ${LATIN}`);
  const other = await typeUnicode([LATIN, 'com.example.keyboard/.Ime']);
  assert.equal(other.result.message, 'Nothing was typed: the input method is com.example.keyboard/.Ime instead of ADBKeyBoard, so non-Latin text cannot be typed now.');
});

test('adb_text unicode: the keyboard taken over during typing - "may not have been typed"; restored', async () => {
  const { result, log } = await typeUnicode([LATIN, ADB_IME, REMOTE]);
  assert.ok(result instanceof Error);
  assert.match(result.message, new RegExp(`^The text may not have been typed: the input method changed to ${REMOTE.replace(/\./g, '\\.')} during typing\\. The keyboard is held by a connected Google TV remote`));
  assert.ok(log.some(c => c.startsWith('am broadcast')));
  assert.equal(log[log.length - 1], `ime set ${LATIN}`);
});

// ------------------------------------------------ adb_text: is a field focused

test('parseInputShown: true, false, and null without the line', () => {
  assert.equal(U.parseInputShown('  mCurClient=ClientState{1 uid 10123}\n  mInputShown=true\n'), true);
  assert.equal(U.parseInputShown('    mInputShown=false mDecorViewVisible=true\n'), false);
  assert.equal(U.parseInputShown('INPUT MANAGER\n  mCurMethodId=null\n'), null);
  assert.equal(U.parseInputShown(''), null);
});

test('adb_text: no on-screen keyboard - the text is still sent, the answer says it may have gone nowhere', async () => {
  const ascii = (shown, tv) => {
    const rules = [{ match: 'input text', stdout: '' }];
    if (shown !== undefined) rules.unshift({ match: 'dumpsys input_method', stdout: `  mInputShown=${shown}\n` });
    if (tv) rules.unshift({ match: 'pm list features', stdout: 'feature:android.software.leanback\nfeature:android.software.leanback_only\n' });
    const fake = useFakeAdb(rules);
    return U.typeText({ serial: '192.0.2.62:5555', text: 'find me' }).then(r => ({ text: r[0].text, log: fake.log().map(a => a.slice(3).join(' ')) }));
  };
  const hidden = await ascii(false);
  assert.equal(hidden.text, 'Sent 7 chars, but no on-screen keyboard is shown, so no system text field seems to have focus: ' +
    'the text may have gone nowhere. Check with adb_screenshot; tap the field first.');
  assert.ok(hidden.log[0].startsWith('dumpsys input_method'), 'read before typing');
  assert.ok(hidden.log.some(c => c.startsWith('input text')), 'typed anyway');
  assert.equal((await ascii(false, true)).text, 'Sent 7 chars, but no on-screen keyboard is shown, so no system text field seems to have focus: ' +
    'the text may have gone nowhere. Check with adb_screenshot. On a TV box, press OK on the field (adb_key DPAD_CENTER) to open the keyboard, then type again.');
  assert.equal((await ascii(true)).text, 'Typed 7 chars (ASCII)');
  assert.equal((await ascii(undefined)).text, 'Typed 7 chars (ASCII)', 'unknown: as before');

  const { result, log } = await typeUnicode([LATIN, ADB_IME], false);
  assert.equal(result, 'Sent 6 chars, but no on-screen keyboard is shown, so no system text field seems to have focus: ' +
    'the text may have gone nowhere. Check with adb_screenshot; tap the field first. Non-Latin text reaches only a system text field.');
  assert.ok(log.some(c => c.startsWith('am broadcast')));
  assert.equal((await typeUnicode([LATIN, ADB_IME], true)).result, 'Typed 6 chars (unicode via ADBKeyBoard)');
});

// ------------------------------------------------ dump: null root node

test('a dump with "null root node" is tried once more, then the error stands', async () => {
  const saved = U.DUMP_RETRY.delayMs;
  U.DUMP_RETRY.delayMs = 10;
  try {
    const NULL_ROOT = 'ERROR: null root node returned by UiTestAutomationBridge.\n__BRICKPROOF_XML__\n';
    let fake = useFakeAdb([
      { match: 'uiautomator dump', once: true, stdout: NULL_ROOT },
      { match: 'uiautomator dump', stdout: `UI hierchary dumped to: /sdcard/x.xml\n__BRICKPROOF_XML__\n${XML}` },
    ]);
    assert.equal((await U.uiDump({ serial: 'watch-1' }))[0].text.includes('OK'), true);
    assert.equal(fake.log().length, 2);
    fake = useFakeAdb([{ match: 'uiautomator dump', stdout: NULL_ROOT }]);
    await assert.rejects(U.uiDump({ serial: 'watch-2' }), /^Error: uiautomator: ERROR: null root node returned by UiTestAutomationBridge\.$/);
    assert.equal(fake.log().length, 2, 'one retry only');
    fake = useFakeAdb([{ match: 'uiautomator dump', stdout: 'ERROR: could not get idle state.\n__BRICKPROOF_XML__\n' }]);
    await assert.rejects(U.uiDump({ serial: 'watch-3' }), /could not get idle state/);
    assert.equal(fake.log().length, 1, 'other errors: no retry');
  } finally {
    U.DUMP_RETRY.delayMs = saved;
  }
});

// ------------------------------------------------ the DPAD walk

const box = (l, t, r, b) => ({ box: [l, t, r, b], x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) });

test('stepDirections: overlap decides the axis, a containing focus counts from the screen centre, else the centres', () => {
  const screen = [0, 0, 1920, 1080];
  // Fire TV: from "Find" to the Search row right below it (its centre far to the right).
  assert.deepEqual(U.stepDirections(box(104, 560, 260, 630), box(104, 684, 1784, 758), screen), ['DPAD_DOWN', 'DPAD_RIGHT']);
  assert.deepEqual(U.stepDirections(box(104, 684, 1784, 758), box(104, 560, 260, 630), screen), ['DPAD_UP', 'DPAD_LEFT']);
  // wholly to one side, overlapping vertically
  assert.deepEqual(U.stepDirections(box(100, 100, 200, 300), box(900, 250, 1000, 280), screen), ['DPAD_RIGHT', 'DPAD_DOWN']);
  assert.deepEqual(U.stepDirections(box(900, 100, 1000, 300), box(100, 0, 200, 150), screen), ['DPAD_LEFT', 'DPAD_UP']);
  // a full-screen banner containing the target: from the screen centre (960,540)
  assert.deepEqual(U.stepDirections(box(0, 0, 1920, 1080), box(104, 620, 260, 690), screen), ['DPAD_LEFT', 'DPAD_DOWN']);
  assert.deepEqual(U.stepDirections(box(0, 0, 1920, 1080), box(1000, 900, 1100, 1000), screen), ['DPAD_DOWN', 'DPAD_RIGHT']);
  // no overlap: the centres, the larger offset first
  assert.deepEqual(U.stepDirections(box(0, 0, 100, 100), box(500, 200, 600, 300), screen), ['DPAD_RIGHT', 'DPAD_DOWN']);
  assert.deepEqual(U.stepDirections(box(500, 500, 600, 600), box(100, 0, 200, 100), screen), ['DPAD_UP', 'DPAD_LEFT']);
  assert.deepEqual(U.screenBox([box(10, 20, 30, 40), box(0, 5, 100, 50)]), [0, 5, 100, 50]);
});

// A TV box that shows these screens one after another, one per dump.
const node = (attrs, [l, t, r, b]) => `<node ${attrs} clickable="true" bounds="[${l},${t}][${r},${b}]"/>`;
const screenXml = nodes => `<?xml version="1.0"?><hierarchy>${nodes.join('')}</hierarchy>`;
async function walkOn(serial, screens, args) {
  const saved = { ...U.WALK_TIMING };
  Object.assign(U.WALK_TIMING, { keyMs: 1, centerMs: 1 });
  const fake = useFakeAdb([
    { match: 'pm list features', stdout: 'feature:android.software.leanback\nfeature:android.software.leanback_only\n' },
    { match: 'dumpsys window', stdout: 'mCurrentFocus=Window{1 u0 com.example.launcher/.Home}\n' },
    { match: 'input keyevent', stdout: '' },
    ...screens.map((s, i) => ({ match: 'uiautomator dump', once: i < screens.length - 1, stdout: `UI hierchary dumped to: /sdcard/x.xml\n__BRICKPROOF_XML__\n${screenXml(s)}` })),
  ]);
  try {
    const r = await U.findAndTap({ serial, ...args }).then(x => x[0].text, e => e);
    return { r, keys: fake.log().map(a => a.slice(3).join(' ')).filter(c => c.startsWith('input keyevent')).map(c => c.replace('input keyevent DPAD_', '')) };
  } finally {
    Object.assign(U.WALK_TIMING, saved);
  }
}

test('DPAD walk, Fire TV: from "Find" the Search row right below is DOWN, not RIGHT along the apps', async () => {
  const find = [104, 560, 260, 630], app = [300, 560, 500, 630], search = [104, 684, 1784, 758];
  const { r, keys } = await walkOn('firetv-1', [
    [node('text="Find" focused="true"', find), node('text="App one"', app), node('text="Search"', search)],
    [node('text="Find"', find), node('text="App one"', app), node('text="Search" focused="true"', search)],
  ], { text: 'Search' });
  assert.deepEqual(keys, ['DOWN', 'CENTER']);
  assert.match(r, /^Activated "Search" via DPAD/);
});

test('DPAD walk, Fire TV: a full-screen banner has no position; after the cycle the other axis reaches "Find"', async () => {
  const banner = [0, 0, 1920, 1080], profile = [0, 0, 80, 80], find = [104, 620, 260, 690];
  const on = which => [
    node(`content-desc="Featured banner"${which === 'banner' ? ' focused="true"' : ''}`, banner),
    node(`text="Profile"${which === 'profile' ? ' focused="true"' : ''}`, profile),
    node(`text="Find"${which === 'find' ? ' focused="true"' : ''}`, find),
  ];
  const { r, keys } = await walkOn('firetv-2', [on('banner'), on('profile'), on('banner'), on('find')], { text: 'Find' });
  // LEFT from the screen centre, the device answers with Profile, from there DOWN
  // comes back to the banner: the cycle switches the banner's axis to DOWN.
  assert.deepEqual(keys, ['LEFT', 'DOWN', 'DOWN', 'CENTER']);
  assert.match(r, /^Activated "Find" via DPAD/);
});

test('DPAD walk: a plain walk by the centres; a second cycle still gives up; a stuck focus is reported', async () => {
  const a = [100, 100, 300, 200], b = [400, 100, 600, 200], c = [700, 100, 900, 200];
  const row = f => [node(`text="A"${f === 'A' ? ' focused="true"' : ''}`, a), node(`text="B"${f === 'B' ? ' focused="true"' : ''}`, b), node(`text="C"${f === 'C' ? ' focused="true"' : ''}`, c)];
  const plain = await walkOn('walk-1', [row('A'), row('B'), row('C')], { text: 'C' });
  assert.deepEqual(plain.keys, ['RIGHT', 'RIGHT', 'CENTER']);

  const cycle = await walkOn('walk-2', [row('A'), row('B'), row('A'), row('B'), row('A')], { text: 'C' });
  assert.ok(cycle.r instanceof Error);
  assert.match(cycle.r.message, /^Focus is cycling: back on "[AB]"/);
  assert.ok(!cycle.keys.includes('CENTER'));

  const stuck = await walkOn('walk-3', [row('A'), [...row('A'), '<node text="clock" bounds="[0,0][10,10]"/>'], row('A')], { text: 'C' });
  assert.ok(stuck.r instanceof Error);
  assert.match(stuck.r.message, /^Focus does not move on either axis, still on "A"/);
});
