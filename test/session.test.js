'use strict';
// Remembered devices: what is remembered, forgotten, shown, reconnected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const session = require('../src/session.js');
const { callTool } = require('../src/registry.js');
const { tmpDir, useFakeAdb } = require('./helpers.js');

test('what is remembered: ip and ip:port below the ephemeral range; not mDNS names, Wireless debugging ports, USB serials with odd forms', () => {
  assert.equal(session.rememberable('192.0.2.50'), '192.0.2.50:5555');
  assert.equal(session.rememberable('192.0.2.50:5555'), '192.0.2.50:5555');
  assert.equal(session.rememberable('192.0.2.50:5556'), '192.0.2.50:5556');
  assert.equal(session.rememberable('tv.example.lan'), 'tv.example.lan:5555');
  assert.equal(session.rememberable('192.0.2.50:41234'), null, 'a Wireless debugging port');
  assert.equal(session.rememberable('adb-R5CX00000AB-AbCdEf._adb-tls-connect._tcp'), null);
  assert.equal(session.rememberable('[2001:db8::1]:5555'), null);
  assert.equal(session.rememberable(''), null);
});

function setup(rules) {
  const state = tmpDir();
  session.configure({ stateDir: state });
  const fake = useFakeAdb(rules);
  return { state, fake, file: path.join(state, 'devices.json') };
}

test('adb_connect remembers, adb_devices shows the ones not connected, adb_disconnect with host forgets, without host keeps', async () => {
  const { file } = setup([
    { match: '^connect 192\\.0\\.2\\.50:5555$', stdout: 'connected to 192.0.2.50:5555\n' },
    { match: '^connect 192\\.0\\.2\\.51:5555$', stdout: 'connected to 192.0.2.51:5555\n' },
    { match: '^connect 192\\.0\\.2\\.60:41234$', stdout: 'connected to 192.0.2.60:41234\n' },
    { match: '^connect 192\\.0\\.2\\.99:5555$', stdout: 'failed to connect to 192.0.2.99:5555\n' },
    { match: '^devices -l$', stdout: 'List of devices attached\n192.0.2.50:5555        device product:x model:Box device:x\n' },
    { match: '^devices$', stdout: 'List of devices attached\n192.0.2.50:5555\tdevice\n192.0.2.51:5555\tdevice\n192.0.2.60:41234\tdevice\n' },
    { match: '^disconnect$', stdout: '' },
    { match: '^disconnect 192\\.0\\.2\\.51$', stdout: 'disconnected 192.0.2.51\n' },
  ]);
  const c = await session.connect({ host: '192.0.2.50' });
  assert.equal(c[0].text, 'connected to 192.0.2.50:5555\nRemembered 192.0.2.50:5555: the server reconnects it when it starts.');
  await session.connect({ host: '192.0.2.51:5555' });
  await session.connect({ host: '192.0.2.60:41234' });
  await assert.rejects(session.connect({ host: '192.0.2.99' }), /failed to connect/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).devices,
    [{ address: '192.0.2.50:5555', key: null }, { address: '192.0.2.51:5555', key: null }], 'no device key could be read: none stored');
  assert.equal((await session.connect({ host: '192.0.2.50' }))[0].text, 'connected to 192.0.2.50:5555', 'already remembered: no note');

  const d = await session.devices({});
  assert.match(d[0].text, /\nRemembered, not connected now: 192\.0\.2\.51:5555 \(adb_connect reconnects; off or a new address: adb_devices discover=true\)$/);

  const all = await session.disconnect({});
  assert.equal(all[0].text, 'Disconnected\nThe 2 remembered addresses are kept: adb_disconnect with host forgets one.');
  assert.deepEqual(session.readKnown(), ['192.0.2.50:5555', '192.0.2.51:5555']);
  const one = await session.disconnect({ host: '192.0.2.51' });
  assert.equal(one[0].text, 'disconnected 192.0.2.51\nForgotten 192.0.2.51:5555: no longer reconnected at start.');
  assert.deepEqual(session.readKnown(), ['192.0.2.50:5555']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['devices.json'], 'no temporary file left');
});

test('adb_connect remembers only a device adb lists as "device"; unauthorized: confirm on the screen, not remembered', async () => {
  const { file } = setup([
    { match: '^connect 192\\.0\\.2\\.70:5555$', stdout: 'failed to authenticate to 192.0.2.70:5555\nconnected to 192.0.2.70:5555\n' },
    { match: '^connect 192\\.0\\.2\\.71:5555$', stdout: 'connected to 192.0.2.71:5555\n' },
    { match: '^connect 192\\.0\\.2\\.72:5555$', stdout: 'connected to 192.0.2.72:5555\n' },
    // .71 is still authorizing on the first look, then allowed.
    { match: '^devices$', once: true, stdout: 'List of devices attached\n192.0.2.70:5555\tunauthorized\n192.0.2.71:5555\tauthorizing\n' },
    { match: '^devices$', stdout: 'List of devices attached\n192.0.2.70:5555\tunauthorized\n192.0.2.71:5555\tdevice\n192.0.2.72:5555\toffline\n' },
  ]);
  const saved = { ...session.CONNECT_TIMING };
  Object.assign(session.CONNECT_TIMING, { pollMs: 20, unauthorizedMs: 200 });
  try {
    const t0 = Date.now();
    await assert.rejects(session.connect({ host: '192.0.2.70' }), err => {
      assert.equal(err.message, 'failed to authenticate to 192.0.2.70:5555\nconnected to 192.0.2.70:5555\n' +
        'The device has not allowed debugging from this computer yet (unauthorized): confirm the debugging prompt on the device\'s screen (tick "Always allow from this computer"), then call adb_connect again. ' +
        'If the screen is off, wake the device (its remote or power button) so the prompt shows. Not remembered.');
      return true;
    });
    assert.ok(Date.now() - t0 >= 200, 'refused only after unauthorized held');
  } finally {
    Object.assign(session.CONNECT_TIMING, saved);
  }
  assert.ok(!fs.existsSync(file), 'nothing remembered');
  assert.equal((await session.connect({ host: '192.0.2.71' }))[0].text, 'connected to 192.0.2.71:5555\nRemembered 192.0.2.71:5555: the server reconnects it when it starts.');
  assert.equal((await session.connect({ host: '192.0.2.72' }))[0].text,
    'connected to 192.0.2.72:5555\nadb lists 192.0.2.72:5555 as offline, not as a working device: not remembered. Check the device is awake, then call adb_connect again.');
  assert.deepEqual(session.readKnown(), ['192.0.2.71:5555']);
});

test('adb_connect: a trusting device that says unauthorized for a moment is connected and remembered', async () => {
  setup([
    { match: '^connect 192\\.0\\.2\\.73:5555$', stdout: 'connected to 192.0.2.73:5555\n' },
    { match: '^devices$', once: true, stdout: 'List of devices attached\n192.0.2.73:5555\tunauthorized\n' },
    { match: '^devices$', stdout: 'List of devices attached\n192.0.2.73:5555\tdevice\n' },
  ]);
  const saved = { ...session.CONNECT_TIMING };
  // The state changes by the count of calls; the window is far longer than any
  // machine needs for the second look.
  Object.assign(session.CONNECT_TIMING, { pollMs: 20, unauthorizedMs: 10 * 60 * 1000 });
  try {
    assert.equal((await session.connect({ host: '192.0.2.73' }))[0].text, 'connected to 192.0.2.73:5555\nRemembered 192.0.2.73:5555: the server reconnects it when it starts.');
  } finally {
    Object.assign(session.CONNECT_TIMING, saved);
  }
  assert.deepEqual(session.readKnown(), ['192.0.2.73:5555']);
});

test('adb_devices: one device under several serials is marked "same device as" the first; other states are not read', async () => {
  const fake = setup([
    { match: '^devices -l$', stdout: 'List of devices attached\n' +
      'R5CX00000AB            device usb:1-1 product:x model:SM_X device:x transport_id:1\n' +
      '192.0.2.51:5555        device product:x model:SM_X device:x transport_id:2\n' +
      'adb-R5CX00000AB-AbCdEf._adb-tls-connect._tcp device product:x model:SM_X device:x transport_id:3\n' +
      '192.0.2.38:5555        device product:y model:SHIELD device:y transport_id:4\n' +
      '192.0.2.62:5555        unauthorized transport_id:5\n' },
    { match: '^-s (R5CX00000AB|192\\.0\\.2\\.51:5555|adb-R5CX00000AB-AbCdEf\\._adb-tls-connect\\._tcp) shell .*ro\\.serialno', stdout: PROPS('SM-X', 'R5CX00000AB') },
    { match: '^-s 192\\.0\\.2\\.38:5555 shell .*ro\\.serialno', stdout: PROPS('SHIELD Android TV', 'SHLD0001') },
  ]).fake;
  require('../src/apps.js')._identityCache.clear();
  const lines = (await session.devices({}))[0].text.split('\n');
  assert.equal(lines[1], 'R5CX00000AB            device usb:1-1 product:x model:SM_X device:x transport_id:1');
  assert.equal(lines[2], '192.0.2.51:5555        device product:x model:SM_X device:x transport_id:2  same device as R5CX00000AB');
  assert.equal(lines[3], 'adb-R5CX00000AB-AbCdEf._adb-tls-connect._tcp device product:x model:SM_X device:x transport_id:3  same device as R5CX00000AB');
  assert.ok(!lines[4].includes('same device'));
  assert.ok(!lines[5].includes('same device'));
  assert.ok(!fake.log().some(a => a[1] === '192.0.2.62:5555'), 'the unauthorized line is not read');
});

test('a remembered device that dropped: one reconnect, then the call once more', async () => {
  const { state, fake } = setup([]);
  fs.writeFileSync(path.join(state, 'devices.json'), JSON.stringify({ devices: ['192.0.2.50:5555'] }));
  // The first logcat fails, the reconnect works, the second logcat answers.
  fake.rules([
    { match: '^connect 192\\.0\\.2\\.50:5555$', stdout: 'connected to 192.0.2.50:5555\n' },
    { match: '^-s 192\\.0\\.2\\.50:5555 logcat', code: 1, stderr: "error: device '192.0.2.50:5555' not found\n", once: true },
    { match: '^-s 192\\.0\\.2\\.50:5555 logcat', stdout: 'I/Tag: hello\n' },
  ]);
  const r = await callTool('adb_logcat', { serial: '192.0.2.50:5555' });
  assert.equal(r[0].text, 'I/Tag: hello');
  assert.deepEqual(fake.log().map(a => a.join(' ')), [
    '-s 192.0.2.50:5555 logcat -d -t 200', 'connect 192.0.2.50:5555', '-s 192.0.2.50:5555 logcat -d -t 200']);
});

test('a destructive tool is not repeated after a reconnect; a failed reconnect says how to find the device', async () => {
  const { state } = setup([
    { match: '^connect 192\\.0\\.2\\.50:5555$', stdout: 'connected to 192.0.2.50:5555\n' },
    { match: '^connect 192\\.0\\.2\\.51:5555$', stdout: 'failed to connect to 192.0.2.51:5555\n' },
    { match: 'uninstall', code: 1, stderr: "error: device '192.0.2.50:5555' not found\n" },
    { match: '^-s 192\\.0\\.2\\.51:5555 logcat', code: 1, stderr: "error: device '192.0.2.51:5555' not found\n" },
    { match: '^-s 192\\.0\\.2\\.52:5555 logcat', code: 1, stderr: "error: device '192.0.2.52:5555' not found\n" },
  ]);
  fs.writeFileSync(path.join(state, 'devices.json'), JSON.stringify({ devices: ['192.0.2.50:5555', '192.0.2.51:5555'] }));
  await assert.rejects(callTool('adb_uninstall', { package: 'com.example.app', serial: '192.0.2.50:5555' }),
    /\nReconnected to 192\.0\.2\.50:5555\. The call was not repeated, because it may have been partly done: check the state and call it again\.$/);
  await assert.rejects(callTool('adb_logcat', { serial: '192.0.2.51:5555' }),
    /\nA reconnect to the remembered address 192\.0\.2\.51:5555 failed: the device may be off or have a new address - adb_devices discover=true finds it again\.$/);
  await assert.rejects(callTool('adb_logcat', { serial: '192.0.2.52:5555' }), err => !/reconnect/i.test(err.message), 'not remembered: the plain error');
});

test('repeatable: decided by the call - reading actions and dry runs, with each default', () => {
  const { repeatable } = require('../src/registry.js');
  for (const action of ['list', 'info', 'protected', 'state', 'LIST'])
    assert.equal(repeatable('adb_app', { action }), true, action);
  for (const action of ['disable', 'uninstall', 'enable', 'restore', 'clear']) {
    assert.equal(repeatable('adb_app', { action }), true, `${action}: dry_run by default`);
    assert.equal(repeatable('adb_app', { action, dry_run: 'true' }), true);
    assert.equal(repeatable('adb_app', { action, dry_run: false }), false, `${action} dry_run=false`);
    assert.equal(repeatable('adb_app', { action, dry_run: 'false' }), false);
  }
  assert.equal(repeatable('adb_app', { action: 'stop' }), false, 'stop acts at once');
  assert.equal(repeatable('adb_app', { action: 'stop', dry_run: true }), true);
  assert.equal(repeatable('adb_app', { action: 'backup' }), false);
  assert.equal(repeatable('adb_app', { action: 'launch', package: 'x' }), false, 'no dry_run: as before');
  assert.equal(repeatable('adb_install', {}), true, 'the list of installable files');
  assert.equal(repeatable('adb_install', { apk_path: '/x.apk' }), true, 'dry_run by default');
  assert.equal(repeatable('adb_install', { apk_path: '/x.apk', dry_run: 'no' }), true, 'anything but false is a dry run, as adb_install counts it');
  assert.equal(repeatable('adb_install', { apk_path: '/x.apk', dry_run: false }), false);
  assert.equal(repeatable('adb_uninstall', { package: 'x' }), false);
  assert.equal(repeatable('adb_shell', { command: 'ls' }), false);
  assert.equal(repeatable('adb_push', {}), false);
  assert.equal(repeatable('adb_logcat', {}), true, 'not destructive');
});

test('after a reconnect: adb_app list and a default dry run are repeated, disable with dry_run=false is not', async () => {
  const LOST = { code: 1, stderr: "error: device '192.0.2.62:5555' not found\n" };
  const run = async (args, ruleMatch) => {
    const { state, fake } = setup([
      { match: '^connect 192\\.0\\.2\\.62:5555$', stdout: 'connected to 192.0.2.62:5555\n' },
      { match: ruleMatch, once: true, ...LOST },
      { match: '.', stdout: '' },
    ]);
    fs.writeFileSync(path.join(state, 'devices.json'), JSON.stringify({ devices: ['192.0.2.62:5555'] }));
    require('../src/apps.js')._identityCache.clear();
    const r = await callTool('adb_app', { serial: '192.0.2.62:5555', ...args }).then(x => x[0].text, e => e);
    const calls = fake.log().map(a => a.join(' '));
    return { r, after: calls.slice(calls.indexOf('connect 192.0.2.62:5555') + 1) };
  };
  const list = await run({ action: 'list' }, 'pm list packages');
  assert.ok(!(list.r instanceof Error), String(list.r));
  assert.ok(list.after.some(c => c.includes('pm list packages')), 'list called again');

  const dry = await run({ action: 'disable', packages: ['com.example.tv'] }, 'getprop');
  assert.ok(!String(dry.r && dry.r.message || dry.r).includes('not repeated'), String(dry.r));
  assert.ok(dry.after.length > 0, 'the dry run called again');

  const real = await run({ action: 'disable', packages: ['com.example.tv'], dry_run: false }, 'getprop');
  assert.ok(real.r instanceof Error);
  assert.match(real.r.message, /\nReconnected to 192\.0\.2\.62:5555\. The call was not repeated, because it may have been partly done: check the state and call it again\.$/);
  assert.deepEqual(real.after, [], 'nothing after the reconnect');
});

const PROPS = (model, serialno) => `@@model@@\n${model}\n@@serialno@@\n${serialno}\n@@end@@\n`;

test('the device key is remembered; the same device at a new address replaces the old address', async () => {
  const { file } = setup([
    { match: '^connect ', stdout: 'connected\n' },
    { match: '^devices$', stdout: 'List of devices attached\n192.0.2.50:5555\tdevice\n192.0.2.51:5555\tdevice\n192.0.2.52:5555\tdevice\n192.0.2.77:5555\tdevice\n' },
    { match: '^-s 192\\.0\\.2\\.50:5555 shell .*ro\\.serialno', stdout: PROPS('SHIELD Android TV', 'SHLD0001') },
    { match: '^-s 192\\.0\\.2\\.77:5555 shell .*ro\\.serialno', stdout: PROPS('SHIELD Android TV', 'SHLD0001') },
    { match: '^-s 192\\.0\\.2\\.51:5555 shell .*ro\\.serialno', stdout: PROPS('Box', '0123456789ABCDEF') },
    { match: '^-s 192\\.0\\.2\\.52:5555 shell .*ro\\.serialno', stdout: PROPS('Box', '0123456789ABCDEF') },
  ]);
  require('../src/apps.js')._identityCache.clear();
  await session.connect({ host: '192.0.2.50' });
  await session.connect({ host: '192.0.2.51' });
  const moved = await session.connect({ host: '192.0.2.77' });
  assert.equal(moved[0].text, 'connected\nThis device was remembered at 192.0.2.50:5555; its new address 192.0.2.77:5555 replaces it.');
  // a shared, useless serial gives no key: a second such box is a second entry, never a replacement
  await session.connect({ host: '192.0.2.52' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).devices, [
    { address: '192.0.2.77:5555', key: 'SHIELD_Android_TV_SHLD0001' },
    { address: '192.0.2.51:5555', key: null },
    { address: '192.0.2.52:5555', key: null },
  ]);
  assert.deepEqual(session.readKnown(), ['192.0.2.77:5555', '192.0.2.51:5555', '192.0.2.52:5555']);
});

test('the old format of devices.json (a list of addresses) is read', () => {
  const { state } = setup([]);
  fs.writeFileSync(path.join(state, 'devices.json'), JSON.stringify({ devices: ['192.0.2.50:5555'] }));
  assert.deepEqual(session.readEntries(), [{ address: '192.0.2.50:5555', key: null }]);
});

test('nothing connected: adb_devices points to discover=true; so does "device not found" of any tool', async () => {
  setup([
    { match: '^devices -l$', stdout: 'List of devices attached\n\n' },
    { match: 'logcat', code: 1, stderr: "error: device '192.0.2.9:5555' not found\n" },
  ]);
  const d = await session.devices({});
  assert.match(d[0].text, /\nNo device is connected\. To find one on the network: adb_devices discover=true\. A phone on a USB cable shows up here by itself once USB debugging is allowed on it\.$/);
  await assert.rejects(callTool('adb_logcat', { serial: '192.0.2.9:5555' }), /A device that is not in that list: adb_devices discover=true searches the network for it\.$/);
});
