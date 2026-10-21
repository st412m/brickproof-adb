'use strict';
// adb_app: refusal texts, intents, and the snapshot store by device.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../src/apps.js');
const { tmpDir, writeJson, useFakeAdb } = require('./helpers.js');

test('formatProtectedRefusal: fixed first and last lines, one line per package with its sources', () => {
  const sources = {
    launcher: 'com.example.launcher',
    roles: ['com.example.launcher', 'com.example.remote'],
    roles_detail: { HOME: ['com.example.launcher'], SYSTEM_TELEVISION_REMOTE_SERVICE: ['com.example.remote'] },
    net_listener: { 'com.example.remote': { ports: [6466], serving: [] } },
  };
  assert.equal(P.formatProtectedRefusal(['com.example.launcher', 'com.example.remote', 'com.android.settings', 'com.android.providers.media', 'x.y'], sources),
    'REFUSED: the list contains protected packages - com.example.launcher, com.example.remote, com.android.settings, com.android.providers.media, x.y.\n' +
    '  com.example.launcher — launcher, roles (HOME)\n' +
    '  com.example.remote — roles (SYSTEM_TELEVISION_REMOTE_SERVICE), net_listener\n' +
    '  com.android.settings — core\n' +
    '  com.android.providers.media — core (com.android.providers.*)\n' +
    '  x.y — source not recorded\n' +
    'The full set with every source: adb_app action=protected\n' +
    'Nothing was applied. Remove them from the list by hand; the tool has no override.');
});

test('extrasToAmFlags: types to flags, quoting, refusals by key', () => {
  assert.deepEqual(P.extrasToAmFlags({ s: "it's", b: true, i: 7, l: 2 ** 40 }),
    ['--es', "'s'", `'it'\\''s'`, '--ez', "'b'", "'true'", '--ei', "'i'", "'7'", '--el', "'l'", "'1099511627776'"]);
  assert.deepEqual(P.extrasToAmFlags('{"a":"b"}'), ['--es', "'a'", "'b'"]);
  assert.throws(() => P.extrasToAmFlags({ 'bad key': 1 }), /extras\.bad key: key name must match/);
  assert.throws(() => P.extrasToAmFlags({ f: 1.5 }), /extras\.f: unsupported value type \(number\)/);
});

test('parseAmStartOutput: no handler, delivered, errors; the echo line is never read', async () => {
  const ctx = { pkg: null, action: 'android.intent.action.VIEW' };
  await assert.rejects(P.parseAmStartOutput(null, 'Starting: Intent { act=android.intent.action.VIEW dat=x }\nError: Activity not started, unable to resolve Intent { act=x }', ctx),
    /^Error: No handler for this intent \(action=android.intent.action.VIEW\)/);
  const d = await P.parseAmStartOutput(null, 'Warning: Activity not started, intent has been delivered to currently running top-most instance.', { pkg: 'com.example', action: 'a' });
  assert.match(d[0].text, /^Delivered to the already running instance \(com\.example\)/);
  await assert.rejects(P.parseAmStartOutput(null, 'Starting: Intent { dat=error://Exception }\njava.lang.SecurityException: Permission Denial', ctx), /am start refused: java\.lang\.SecurityException/);
  assert.ok(P.CALL_ACTIONS.has('android.intent.action.CALL'));
});

test('CALL intents are refused while allow_shell is off', async () => {
  P.configure({ allowShell: false });
  await assert.rejects(P.adbApp({ action: 'launch', intent_action: 'android.intent.action.CALL', uri: 'tel:1' }),
    /intent_action=android\.intent\.action\.CALL refused: the server option allow_shell is off/);
});

test('mode=uninstall is refused while allow_uninstall is off', async () => {
  P.configure({ allowUninstall: false });
  await assert.rejects(P.adbApp({ action: 'uninstall', packages: ['com.example'] }), /mode=uninstall is refused: the server option allow_uninstall is off/);
});

// ------------------------------------------------------------- snapshot key

test('the key: model_serialno; empty, unknown or shared serials fall back to the connection', () => {
  assert.deepEqual(P.identityFrom('192.0.2.50:5555', 'SHIELD Android TV', 'ABC123XYZ'),
    { key: 'SHIELD_Android_TV_ABC123XYZ', source: 'device', connection: '192.0.2.50:5555', connectionKey: '192.0.2.50_5555', model: 'SHIELD Android TV', serialno: 'ABC123XYZ' });
  for (const sn of ['', '  ', 'unknown', 'UNKNOWN', '0123456789ABCDEF', '0123456789abcdef', '0123456789', '0000000000000000'])
    assert.equal(P.identityFrom('192.0.2.50:5555', 'Box', sn).source, 'connection', JSON.stringify(sn));
  assert.equal(P.identityFrom('192.0.2.50:5555', 'Box', '').key, '192.0.2.50_5555');
  assert.equal(P.identityFrom('R5CX00000AB', 'Phone.', 'R5CX00000AB.').key, 'Phone._R5CX00000AB', 'trailing dots dropped');
});

const PROPS_OUT = (model, serialno) => `@@model@@\n${model}\n@@serialno@@\n${serialno}\n@@end@@\n`;

test('one device over USB and over the network gets one key; without serial the connection comes from get-serialno', async () => {
  const fake = useFakeAdb([
    { match: '^get-serialno', stdout: 'R5CX00000AB\n' },
    { match: 'getprop ro\\.serialno', stdout: PROPS_OUT('Phone', 'R5CX00000AB') },
  ]);
  P._identityCache.clear();
  const usb = await P.deviceIdentity(undefined);
  const net = await P.deviceIdentity('192.0.2.50:5555');
  assert.equal(usb.key, 'Phone_R5CX00000AB');
  assert.equal(net.key, usb.key);
  assert.equal(usb.connection, 'R5CX00000AB');
  assert.equal(net.connectionKey, '192.0.2.50_5555');
  const calls = fake.log();
  assert.deepEqual(calls[0], ['get-serialno']);
  await P.deviceIdentity('192.0.2.50:5555');
  assert.equal(fake.log().length, calls.length, 'cached per connection');
});

// A store context without adb.
function ctxFor(root, id) {
  return { root, id, dir: path.join(root, id.key), legacyDir: id.source === 'device' ? path.join(root, id.connectionKey) : null, readFrom: null };
}

test('reading: the device directory first, else the 1.x connection directory; the first write carries entries over', async () => {
  const root = tmpDir();
  const id = P.identityFrom('192.0.2.50:5555', 'Box', 'SER1');
  const legacyBackup = path.join(root, '192.0.2.50_5555', 'apk', 'com.example', '7');
  writeJson(path.join(root, '192.0.2.50_5555', 'state.json'), {
    device: '192.0.2.50_5555', updated: '2026-09-01T00:00:00.000Z',
    entries: [{ package: 'com.example', mode: 'uninstall', system: false, backup: legacyBackup }],
  });
  const ctx = ctxFor(root, id);
  const st = P.readState(ctx);
  assert.equal(ctx.readFrom, path.join(root, '192.0.2.50_5555', 'state.json'));
  assert.equal(st.entries.length, 1);
  assert.equal(st.device, 'Box_SER1');
  assert.equal(P.keyReport(ctx).read_from, ctx.readFrom);

  st.entries.push({ package: 'com.other', mode: 'disable', system: false, backup: null });
  await P.writeState(ctx, st);
  const written = JSON.parse(fs.readFileSync(path.join(root, 'Box_SER1', 'state.json'), 'utf8'));
  assert.deepEqual(written.entries.map(e => e.package), ['com.example', 'com.other']);
  assert.equal(written.key_source, 'device');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '192.0.2.50_5555', 'state.json'), 'utf8')).entries.length, 1, 'the old directory is untouched');
  assert.deepEqual(fs.readdirSync(path.join(root, 'Box_SER1')), ['state.json'], 'no temporary file left');

  const again = ctxFor(root, id);
  assert.equal(P.readState(again).entries.length, 2);
  assert.equal(again.readFrom, path.join(root, 'Box_SER1', 'state.json'));
});

test('the default directory of 1.x is never read', () => {
  const root = tmpDir();
  writeJson(path.join(root, 'default', 'state.json'), { entries: [{ package: 'com.any', mode: 'disable' }] });
  const ctx = ctxFor(root, P.identityFrom('R5CX00000AB', 'Phone', 'R5CX00000AB'));
  assert.deepEqual(P.readState(ctx).entries, []);
});

test('backup: new entries relative with POSIX separators, old absolute ones as they are, both checked against the store', () => {
  const root = tmpDir();
  const ctx = ctxFor(root, P.identityFrom('192.0.2.50:5555', 'Box', 'SER1'));
  const dir = path.join(ctx.dir, 'apk', 'com.example', '42');
  assert.equal(P.backupRef(ctx, dir), 'apk/com.example/42');
  assert.equal(P.backupDirOf(ctx, { package: 'com.example', backup: 'apk/com.example/42' }), dir);
  const abs = path.join(root, '192.0.2.50_5555', 'apk', 'com.example', '7');
  assert.equal(P.backupDirOf(ctx, { package: 'com.example', backup: abs }), abs);
  const other = tmpDir();
  assert.throws(() => P.backupDirOf(ctx, { package: 'com.example', backup: path.join(other, 'apk') }), /backup of com\.example .* is outside the allowed directories \(store: /);
  assert.throws(() => P.backupDirOf(ctx, { package: 'com.example', backup: '../../escape' }), /is outside the allowed directories/);
  assert.equal(P.backupDirOf(ctx, { package: 'com.example', backup: null }), null);
});

test('the store parameter: the setting itself or a directory inside file_roots', () => {
  const store = tmpDir(), files = tmpDir(), other = tmpDir();
  P.configure({ store, fileRoots: [files] });
  assert.equal(P.storeRoot({}), store);
  assert.equal(P.storeRoot({ store }), store);
  assert.equal(P.storeRoot({ store: path.join(files, 'snap') }), path.join(files, 'snap'));
  assert.throws(() => P.storeRoot({ store: other }), /store .* is outside the allowed directories \(store: /);
  assert.throws(() => P.storeRoot({ store: path.join(store, 'sub') }), /is outside/);
  P.configure({});
  assert.throws(() => P.storeRoot({}), /the snapshot store is not set/);
});

// ------------------------------------------------------- rename with retries

test('rename retries on EPERM/EBUSY/EACCES with one stderr line per retry, then succeeds', async () => {
  let n = 0;
  const fsImpl = { renameSync: () => { n++; if (n < 3) { const e = new Error('busy'); e.code = n === 1 ? 'EPERM' : 'EBUSY'; throw e; } } };
  const lines = [], sleeps = [];
  const attempt = await P.renameWithRetry('a.tmp', 'a', { fsImpl, sleep: async ms => sleeps.push(ms), log: l => lines.push(l) });
  assert.equal(attempt, 2);
  assert.deepEqual(sleeps, [100, 200]);
  assert.deepEqual(lines, [
    'brickproof-adb: rename a.tmp -> a failed with EPERM, retry 1/5',
    'brickproof-adb: rename a.tmp -> a failed with EBUSY, retry 2/5',
  ]);
});

test('rename gives up after 5 retries; other errors throw at once', async () => {
  const always = code => ({ renameSync: () => { const e = new Error(code); e.code = code; throw e; } });
  const lines = [];
  await assert.rejects(P.renameWithRetry('a.tmp', 'a', { fsImpl: always('EACCES'), sleep: async () => {}, log: l => lines.push(l) }), { code: 'EACCES' });
  assert.equal(lines.length, 5);
  assert.equal(lines[4], 'brickproof-adb: rename a.tmp -> a failed with EACCES, retry 5/5');
  const none = [];
  await assert.rejects(P.renameWithRetry('a.tmp', 'a', { fsImpl: always('ENOSPC'), sleep: async () => {}, log: l => none.push(l) }), { code: 'ENOSPC' });
  assert.deepEqual(none, []);
});

test('writeState: when the rename keeps failing, the error names the temporary file that keeps the state', async () => {
  const root = tmpDir();
  const ctx = ctxFor(root, P.identityFrom('192.0.2.50:5555', 'Box', 'SER1'));
  const fsImpl = { renameSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
  let msg = '';
  await assert.rejects(P.writeState(ctx, { entries: [{ package: 'com.example' }] }, { fsImpl, sleep: async () => {}, log: () => {} }), e => { msg = e.message; return true; });
  const m = /The snapshot state is kept in (.+\.tmp-\d+-\d+): rename it to state\.json/.exec(msg);
  assert.ok(m, msg);
  assert.match(msg, /state\.json could not be written \(EBUSY\)/);
  assert.equal(JSON.parse(fs.readFileSync(m[1], 'utf8')).entries[0].package, 'com.example');
});

// ---------------------------------------------------- action=state end to end

test('action=state through a fake adb: key, source, legacy note, the default directory', async () => {
  const store = tmpDir();
  P.configure({ store });
  writeJson(path.join(store, '192.0.2.60_5555', 'state.json'), { entries: [{ package: 'com.example', mode: 'disable' }] });
  fs.mkdirSync(path.join(store, 'default'));
  useFakeAdb([{ match: 'getprop ro\\.serialno', stdout: PROPS_OUT('Box', 'SER9') }]);
  P._identityCache.clear();
  const r = JSON.parse((await P.adbApp({ action: 'state', serial: '192.0.2.60:5555' }))[0].text);
  assert.equal(r.store, path.join(store, 'Box_SER9'));
  assert.deepEqual(r.snapshot_key, { key: 'Box_SER9', source: 'device', read_from: path.join(store, '192.0.2.60_5555', 'state.json'), connection: '192.0.2.60:5555' });
  assert.equal(r.state.entries.length, 1);
  assert.match(r.legacy_note, /read from the connection directory of an older layout/);
  assert.equal(r.default_dir.path, path.join(store, 'default'));
  assert.match(r.default_dir.note, /is not read/);

  useFakeAdb([{ match: 'getprop ro\\.serialno', stdout: PROPS_OUT('Box', '0123456789ABCDEF') }]);
  P._identityCache.clear();
  const c = JSON.parse((await P.adbApp({ action: 'state', serial: '192.0.2.61:5555' }))[0].text);
  assert.equal(c.snapshot_key.source, 'connection');
  assert.equal(c.snapshot_key.key, '192.0.2.61_5555');
  assert.equal(c.snapshot_key.note, P.CONNECTION_NOTE);
  P.configure({});
});

// ------------------------------------------------------- a damaged state.json

test('a damaged state.json is moved aside, the call refuses, the next call starts empty; the file is kept', () => {
  const root = tmpDir();
  const ctx = ctxFor(root, P.identityFrom('192.0.2.50:5555', 'Box', 'SER1'));
  fs.mkdirSync(ctx.dir, { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'state.json'), '{"entries": [ {"package": "com.ex');
  let moved;
  assert.throws(() => P.readState(ctx), err => {
    moved = err.moved;
    return err.name === 'BrokenStateError' &&
      err.message.startsWith(`The snapshot file ${path.join(ctx.dir, 'state.json')} is damaged (`) &&
      err.message.endsWith(`it was moved to ${moved}. Its rollback entries are not used automatically, and calling again starts an empty snapshot. Nothing was done on the device.`);
  });
  assert.match(path.basename(moved), /^state\.json\.broken-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
  assert.equal(fs.readFileSync(moved, 'utf8'), '{"entries": [ {"package": "com.ex', 'kept as it was');
  assert.deepEqual(P.readState(ctxFor(root, ctx.id)).entries, [], 'the next call: empty');
  // A second damaged file never overwrites the first.
  fs.writeFileSync(path.join(ctx.dir, 'state.json'), '{"no": "entries"}');
  assert.throws(() => P.readState(ctxFor(root, ctx.id)), /no list of entries/);
  assert.equal(P.brokenFiles(ctx.dir).length, 2);
  assert.equal(fs.readFileSync(moved, 'utf8'), '{"entries": [ {"package": "com.ex');
  const n1 = P.brokenName(path.join(ctx.dir, 'state.json'), new Date('2026-10-19T10:00:00Z'));
  fs.writeFileSync(n1, '');
  assert.equal(P.brokenName(path.join(ctx.dir, 'state.json'), new Date('2026-10-19T10:00:00Z')), `${n1}-2`);
});

test('restore with a damaged state.json refuses before touching the device; action=state shows the moved files', async () => {
  const store = tmpDir();
  P.configure({ store });
  const fake = useFakeAdb([{ match: 'getprop ro\\.serialno', stdout: PROPS_OUT('Box', 'SER7') }]);
  P._identityCache.clear();
  const dir = path.join(store, 'Box_SER7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
  await assert.rejects(P.adbApp({ action: 'restore', serial: '192.0.2.70:5555', dry_run: false }), /is damaged .* Nothing was done on the device\.$/);
  assert.ok(fake.log().every(a => /getprop/.test(a.join(' '))), 'only the identity read reached adb');
  fs.writeFileSync(path.join(dir, 'state.json'), 'broken again');
  const r = JSON.parse((await P.adbApp({ action: 'state', serial: '192.0.2.70:5555' }))[0].text);
  assert.equal(r.state, null);
  assert.match(r.damaged, /is damaged/);
  assert.equal(r.broken_files.files.length, 2);
  assert.match(r.broken_files.note, /never used, overwritten or removed/);
  const again = JSON.parse((await P.adbApp({ action: 'state', serial: '192.0.2.70:5555' }))[0].text);
  assert.deepEqual(again.state.entries, []);
  assert.equal(again.broken_files.files.length, 2);
  P.configure({});
});

// ------------------------------------------- package changes count by the device

// `pm list packages` (all, -s, -d) as listPackages() reads it.
const PKGS_OUT = ({ all, system = [], disabled = [] }) =>
  ['all', 'system', 'disabled'].map(k => `@@${k}@@\n${({ all, system, disabled })[k].map(p => `package:${p}`).join('\n')}\n`).join('') + '@@end@@\n';
const ILLEGAL = 'Warning! This command is illegal!\nPackage com.example.tv new state: disabled-user\n';

// A disable through a fake adb: the package list answers `before` first, then `after`.
async function disableWith(after) {
  const store = tmpDir();
  P.configure({ store });
  P._identityCache.clear();
  const before = { all: ['com.example.tv', 'com.android.settings'], system: ['com.example.tv', 'com.android.settings'] };
  const fake = useFakeAdb([
    { match: 'getprop ro\\.serialno', stdout: PROPS_OUT('Stream 4K', 'SER5') },
    { match: 'pm list packages -d', once: true, stdout: PKGS_OUT(before) },
    { match: 'pm list packages -d', stdout: PKGS_OUT(after) },
    { match: 'pm disable-user --user 0', stdout: ILLEGAL },
    { match: '.', stdout: '' },
  ]);
  const r = JSON.parse((await P.adbApp({ action: 'disable', serial: '192.0.2.73:5555', packages: ['com.example.tv'], dry_run: false, canary: false }))[0].text);
  const statePath = path.join(store, 'Stream_4K_SER5', 'state.json');
  const entries = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')).entries : [];
  P.configure({});
  return { r, entries, fake, store };
}

test('disable: "this command is illegal" and the package still enabled - failed, not in the snapshot', async () => {
  const { r, entries, fake } = await disableWith({ all: ['com.example.tv', 'com.android.settings'], system: ['com.example.tv', 'com.android.settings'] });
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.failed, [{ package: 'com.example.tv',
    error: 'not disabled: the device still lists it as enabled; device output: Warning! This command is illegal!\nPackage com.example.tv new state: disabled-user' }]);
  assert.deepEqual(entries, []);
  const lists = fake.log().filter(a => a.join(' ').includes('pm list packages -d'));
  assert.equal(lists.length, 2, 'one package list before, one after the batch');
});

test('disable: "this command is illegal" but the package is disabled - applied, with the line as a warning', async () => {
  const { r, entries } = await disableWith({ all: ['com.example.tv', 'com.android.settings'], system: ['com.example.tv', 'com.android.settings'], disabled: ['com.example.tv'] });
  assert.deepEqual(r.failed, []);
  assert.equal(r.applied.length, 1);
  assert.equal(r.applied[0].warning, 'the device answered "Warning! This command is illegal!\nPackage com.example.tv new state: disabled-user", but the change took effect');
  assert.deepEqual(entries.map(e => [e.package, e.mode]), [['com.example.tv', 'disable']]);
});

test('restore: counted by the package list - enabled is restored and leaves the snapshot, still disabled stays and fails', async () => {
  const store = tmpDir();
  P.configure({ store });
  P._identityCache.clear();
  writeJson(path.join(store, 'Box_SER8', 'state.json'), { entries: [
    { package: 'com.example.a', mode: 'disable', system: true, backup: null },
    { package: 'com.example.b', mode: 'disable', system: true, backup: null },
    { package: 'com.example.c', mode: 'uninstall', system: true, backup: null },
  ] });
  const fake = useFakeAdb([
    { match: 'getprop ro\\.serialno', stdout: PROPS_OUT('Box', 'SER8') },
    { match: 'pm enable .*com\\.example\\.a', stdout: 'Package com.example.a new state: enabled\n' },
    { match: 'pm enable .*com\\.example\\.b', stdout: 'Warning! This command is illegal!\n' },
    { match: 'install-existing', stdout: 'Package com.example.c installed for user: 0\n' },
    { match: 'pm list packages -d', stdout: PKGS_OUT({ all: ['com.example.a', 'com.example.b', 'com.example.c'], disabled: ['com.example.b'] }) },
  ]);
  const r = JSON.parse((await P.adbApp({ action: 'restore', serial: '192.0.2.74:5555', dry_run: false }))[0].text);
  assert.deepEqual(r.restored.map(x => x.package), ['com.example.a', 'com.example.c']);
  assert.deepEqual(r.failed, [{ package: 'com.example.b', error: 'not enabled: the device does not list it as an enabled package; device output: Warning! This command is illegal!' }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store, 'Box_SER8', 'state.json'), 'utf8')).entries.map(e => e.package), ['com.example.b']);
  assert.equal(fake.log().filter(a => a.join(' ').includes('pm list packages -d')).length, 1, 'one package list for the whole batch');
  P.configure({});
});

test('refusals name the action from the settings hints', async () => {
  P.configure({ hints: { allow_shell: 'turn on allow_shell in the extension settings in Claude Desktop', allow_uninstall: 'turn on allow_uninstall in the app options in Home Assistant' } });
  await assert.rejects(P.adbApp({ action: 'launch', intent_action: 'android.intent.action.CALL', uri: 'tel:1' }),
    /refused: the server option allow_shell is off\. If this is intended, turn on allow_shell in the extension settings in Claude Desktop, then use adb_shell\.$/);
  await assert.rejects(P.adbApp({ action: 'uninstall', packages: ['com.example'] }),
    /allow_uninstall is off\. If removal is really needed rather than reversible disabling \(mode=disable\), turn on allow_uninstall in the app options in Home Assistant\.$/);
  P.configure({});
  await assert.rejects(P.adbApp({ action: 'uninstall', packages: ['com.example'] }), /run `brickproof-adb set allow_uninstall on` and restart the server\.$/);
});

test('adb_shell refusal through server.init: the settings UI of the launcher', async () => {
  const S = require('../src/server.js');
  const C = require('../src/config.js');
  const loaded = { settingsUi: 'the extension settings in Claude Desktop', sources: { allow_shell: 'env BRICKPROOF_ALLOW_SHELL' } };
  S.init({}, { hints: C.settingHints(loaded) });
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adb_shell', arguments: { command: 'id' } } });
  assert.equal(r.result.content[0].text, 'Error: adb_shell is disabled: the server option allow_shell is off. To enable it, turn on allow_shell in the extension settings in Claude Desktop.');
  S.init({}, { hints: C.settingHints({ settingsUi: null, sources: { allow_shell: 'env BRICKPROOF_ALLOW_SHELL' } }) });
  const e = await S.handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'adb_shell', arguments: { command: 'id' } } });
  assert.match(e.result.content[0].text, /To enable it, set the environment variable BRICKPROOF_ALLOW_SHELL=true where the server is started, and restart it\.$/);
  S.init({});
});
