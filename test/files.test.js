'use strict';
// adb_install, bundles, adb_push/adb_pull host paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const F = require('../src/files.js');
const { tmpDir, useFakeAdb } = require('./helpers.js');

// A minimal ZIP writer for test bundles: [name, Buffer, deflate?].
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, data, deflate] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nameBuf, body);
    centrals.push(ch, nameBuf);
    off += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const PROPS = { sdk: 30, abilist: ['arm64-v8a', 'armeabi-v7a'], density: 320, locale: 'en-US' };

test('installDryRun: only an explicit false installs', () => {
  assert.deepEqual(F.installDryRun(undefined), { dryRun: true, implicit: true });
  assert.deepEqual(F.installDryRun(''), { dryRun: true, implicit: true });
  assert.deepEqual(F.installDryRun(true), { dryRun: true, implicit: false });
  assert.deepEqual(F.installDryRun(false), { dryRun: false, implicit: false });
  assert.deepEqual(F.installDryRun(' FALSE '), { dryRun: false, implicit: false });
  for (const v of [0, 1, '0', 'no', 'yes', 'true', null]) assert.equal(F.installDryRun(v).dryRun, true, String(v));
});

test('the dry-run lines', () => {
  assert.equal(F.DRY_RUN_TAIL, 'dry_run - nothing installed. Repeat with dry_run=false.');
  assert.equal(F.DRY_RUN_DEFAULT_NOTE, 'dry_run was not passed - adb_install only reports unless dry_run=false.');
});

test('split naming: bundletool, APKMirror, pulled from a device', () => {
  assert.equal(F.qualifierOf('splits/base-master.apk'), null);
  assert.equal(F.qualifierOf('splits/base-arm64_v8a.apk'), 'arm64_v8a');
  assert.equal(F.qualifierOf('com.example.app.apk'), null);
  assert.equal(F.qualifierOf('config.xhdpi.apk'), 'xhdpi');
  assert.equal(F.qualifierOf('split_config.ru.apk'), 'ru');
  assert.equal(F.qualifierOf('base.apk'), null);
  assert.deepEqual(F.classify('arm64_v8a'), { kind: 'abi', value: 'arm64-v8a' });
  assert.deepEqual(F.classify('tvdpi'), { kind: 'density', value: 'tvdpi' });
  assert.deepEqual(F.classify('b+sr+Latn'), { kind: 'locale', value: 'sr-Latn' });
});

test('chooseSplits: ABI by the device list, nearest density, device language plus extras', () => {
  const names = ['com.example.app.apk', 'config.armeabi_v7a.apk', 'config.arm64_v8a.apk', 'config.hdpi.apk', 'config.xxhdpi.apk', 'config.ru.apk', 'config.en.apk', 'config.de.apk'];
  const r = F.chooseSplits(names, PROPS, { locales: ['ru'] });
  assert.deepEqual(r.chosen, ['com.example.app.apk', 'config.arm64_v8a.apk', 'config.hdpi.apk', 'config.ru.apk', 'config.en.apk']);
  assert.ok(r.notes.some(n => /nearest used/.test(n)));
});

test('chooseSplits: no ABI match is a refusal, universal.apk alone is a plain APK', () => {
  assert.throws(() => F.chooseSplits(['base.apk', 'split_config.x86.apk'], PROPS), /no split for any ABI of the device \(arm64-v8a, armeabi-v7a\)\. Available: x86\. Install cancelled\./);
  assert.deepEqual(F.chooseSplits(['universal.apk'], PROPS).chosen, ['universal.apk']);
  assert.throws(() => F.chooseSplits(['config.ru.apk'], PROPS), /no base APK/);
});

test('safeEntryName: the last segment by either separator; ., .., empty, ":" and NUL refused', () => {
  assert.equal(F.safeEntryName('splits/base-master.apk'), 'base-master.apk');
  assert.equal(F.safeEntryName('a\\..\\..\\x.apk'), 'x.apk');
  for (const bad of ['dir/', 'dir/..', 'dir/.', 'x/C:evil.apk', 'a\0b.apk', 'evil:stream.apk'])
    assert.throws(() => F.safeEntryName(bad), /unsafe file name in the bundle/, JSON.stringify(bad));
});

test('unpackBundle: every chosen file lands inside a brickproof-apks- directory, whatever its entry name', () => {
  const dir = tmpDir();
  const bundle = path.join(dir, 'app.apks');
  fs.writeFileSync(bundle, makeZip([
    ['a\\..\\..\\base.apk', Buffer.from('BASE'), true],
    ['splits/base-arm64_v8a.apk', Buffer.from('ARM64'), false],
    ['splits/base-xhdpi.apk', Buffer.from('XHDPI'), true],
    ['standalones/standalone-arm64_v8a.apk', Buffer.from('OLD'), false],
  ]));
  const r = F.unpackBundle(bundle, PROPS, {});
  try {
    assert.match(path.basename(r.dir), /^brickproof-apks-/);
    assert.deepEqual(r.files.map(f => path.basename(f)), ['base.apk', 'base-arm64_v8a.apk', 'base-xhdpi.apk']);
    for (const f of r.files) assert.equal(path.dirname(f), r.dir);
    assert.equal(fs.readFileSync(r.files[0], 'utf8'), 'BASE');
    assert.equal(fs.readFileSync(r.files[2], 'utf8'), 'XHDPI');
    assert.equal(r.total, 3, 'standalones/ dropped next to splits/');
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
  const evil = path.join(dir, 'evil.apks');
  fs.writeFileSync(evil, makeZip([['base.apk', Buffer.from('B')], ['x/C:config.arm64_v8a.apk', Buffer.from('E')]]));
  assert.throws(() => F.unpackBundle(evil, PROPS, {}), /unsafe file name in the bundle/);
});

test('without file_roots the file tools refuse and name the setting', async () => {
  F.configure({ fileRoots: [] });
  const dir = tmpDir();
  await assert.rejects(F.push({ host_path: path.join(dir, 'a'), device_path: '/sdcard/a' }), /file_roots is empty, .* run `brickproof-adb set file_roots <folder>` and restart the server\.$/);
  F.configure({ fileRoots: [], rootsHint: 'add a folder to file_roots in the extension settings in Claude Desktop' });
  await assert.rejects(F.push({ host_path: path.join(dir, 'a'), device_path: '/sdcard/a' }), /To open one, add a folder to file_roots in the extension settings in Claude Desktop\.$/);
  await assert.rejects(F.pull({ host_path: path.join(dir, 'b', 'c'), device_path: '/sdcard/a' }), /file_roots is empty/);
  assert.equal(fs.existsSync(path.join(dir, 'b')), false, 'no directory before the check');
  await assert.rejects(F.install({ apk_path: path.join(dir, 'x.apk') }), /file_roots is empty/);
});

test('outside file_roots: refused before anything touches the disk or adb', async () => {
  const root = tmpDir(), other = tmpDir();
  F.configure({ fileRoots: [root] });
  const fake = useFakeAdb([]);
  await assert.rejects(F.pull({ host_path: path.join(other, 'new', 'x'), device_path: '/sdcard/x' }), /is outside the allowed directories \(file_roots: /);
  assert.equal(fs.existsSync(path.join(other, 'new')), false);
  await assert.rejects(F.install({ apk_path: [path.join(root, 'ok.apk'), path.join(other, 'x.apk')] }), /outside|not found/);
  assert.deepEqual(fake.log(), [], 'adb was never called');
});

test('adb_install dry run of a plain APK inside file_roots: the report, no install', async () => {
  const root = tmpDir();
  F.configure({ fileRoots: [root] });
  const apk = path.join(root, 'demo.apk');
  fs.writeFileSync(apk, Buffer.alloc(12345));
  const props = '@@sdk@@\n30\n@@abilist@@\narm64-v8a,armeabi-v7a\n@@abi@@\narm64-v8a\n@@model@@\nX\n@@locale_persist@@\nen-US\n' +
    '@@locale_product@@\n\n@@locale_language@@\n\n@@locale_region@@\n\n@@density_physical@@\n320\n@@density_override@@\n\n@@density_prop@@\n\n@@end@@\n';
  const fake = useFakeAdb([{ match: '^shell', stdout: props }]);
  const r = await F.install({ apk_path: apk });
  assert.equal(r[0].text,
    `APK: 1 file\n  ${apk} (12345 bytes)\nDevice: SDK 30, ABI arm64-v8a,armeabi-v7a, 320 dpi, locale en-US\n` +
    'Would run: install -r -t -g demo.apk on the only connected device\n\n' +
    'dry_run was not passed - adb_install only reports unless dry_run=false.\ndry_run - nothing installed. Repeat with dry_run=false.');
  assert.ok(fake.log().every(a => a[0] === 'shell'), 'only the property read, no install');
  F.configure({});
});

// ------------------------------------------------- adb_install without apk_path

// A file with a given age in minutes.
function put(file, minutesAgo, bytes = 10) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
  const t = new Date(Date.now() - minutesAgo * 60000);
  fs.utimesSync(file, t, t);
  return file;
}

test('without apk_path: the installable files of every root and one level below, newest first; adb is not called', async () => {
  const a = tmpDir(), b = tmpDir();
  const newest = put(path.join(a, 'New.APK'), 1, 2 * 1048576);
  const inSub = put(path.join(a, 'apps', 'tool.xapk'), 5, 3000);
  put(path.join(a, 'apps', 'deeper', 'too-deep.apk'), 2);
  put(path.join(a, '.hidden', 'secret.apk'), 2);
  put(path.join(a, '.dot.apk'), 2);
  put(path.join(a, 'readme.txt'), 0);
  const other = put(path.join(b, 'bundle.Apks'), 10);
  const mirror = put(path.join(b, 'm', 'x.apkm'), 20);
  F.configure({ fileRoots: [a, b] });
  const fake = useFakeAdb([]);
  const r = (await F.install({}))[0].text;
  const lines = r.split('\n');
  assert.equal(lines[0], `Installable files in ${a}, ${b} (the folder itself and one folder below), newest first:`);
  assert.deepEqual(lines.slice(1, 5).map(l => l.trim().split('  ')[0]), [newest, inSub, other, mirror]);
  assert.match(lines[1], /  2\.0 MB  \d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.match(lines[2], /  3 KB  /);
  assert.equal(lines[5], 'Nothing was installed. Install one with adb_install apk_path=<path from this list>; it reports first unless dry_run=false.');
  assert.equal(lines[6], 'Only the top level and one level of subfolders are listed; for a deeper folder pass dir.');
  assert.equal(lines.length, 7);
  assert.ok(!r.includes('too-deep') && !r.includes('secret') && !r.includes('.dot.apk') && !r.includes('readme'));
  assert.deepEqual(fake.log(), [], 'adb was never called');
  F.configure({});
});

test('without apk_path: at most 50 lines and "…and N more"', async () => {
  const a = tmpDir();
  for (let i = 0; i < 53; i++) put(path.join(a, `app${String(i).padStart(2, '0')}.apk`), i);
  F.configure({ fileRoots: [a] });
  const lines = (await F.install({}))[0].text.split('\n');
  assert.equal(lines.filter(l => /\.apk  /.test(l)).length, 50);
  assert.equal(lines[51], '  …and 3 more');
  assert.ok(lines[1].includes('app00.apk'), 'the newest first');
  F.configure({});
});

test('without apk_path: a symlink or junction that leads out of the roots is not followed', async t => {
  const a = tmpDir(), outside = tmpDir();
  put(path.join(outside, 'evil.apk'), 1);
  put(path.join(outside, 'sub', 'evil2.apk'), 1);
  try {
    fs.symlinkSync(outside, path.join(a, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    t.skip(`cannot create a link here: ${e.code}`);
    return;
  }
  put(path.join(a, 'ok.apk'), 1);
  F.configure({ fileRoots: [a] });
  const r = (await F.install({}))[0].text;
  assert.ok(r.includes('ok.apk'));
  assert.ok(!r.includes('evil'), r);
  F.configure({});
});

test('without apk_path: dir lists one folder inside file_roots; outside is refused; ignored with apk_path', async () => {
  const a = tmpDir(), outside = tmpDir();
  const deep = put(path.join(a, 'VAULT', 'apk', 'deep.apk'), 1);
  put(path.join(a, 'top.apk'), 1);
  F.configure({ fileRoots: [a] });
  const r = (await F.install({ dir: path.join(a, 'VAULT') }))[0].text;
  assert.ok(r.includes(deep) && !r.includes('top.apk'), r);
  assert.ok(!(await F.install({}))[0].text.includes('deep.apk'), 'two levels down is not in the default list');
  await assert.rejects(F.install({ dir: outside }), /dir .* is outside the allowed directories \(file_roots: /);
  await assert.rejects(F.install({ dir: outside, apk_path: path.join(outside, 'x.apk') }), /apk_path .* is outside/, 'dir is ignored, apk_path is checked');
  F.configure({});
});

test('without apk_path: nothing found says where to put the file; no file_roots says what to set', async () => {
  const a = tmpDir();
  F.configure({ fileRoots: [a] });
  assert.equal((await F.install({ apk_path: [] }))[0].text,
    `No .apk, .apks, .xapk or .apkm file in ${a} (the folder itself and one folder below). Download or copy the file into one of these folders, then call adb_install again; nothing was installed.\n` +
    'Only the top level and one level of subfolders are listed; for a deeper folder pass dir.');
  F.configure({ fileRoots: [], rootsHint: 'add a folder to file_roots in the app options in Home Assistant' });
  await assert.rejects(F.install({}), /^Error: adb_install has no folder to list: file_roots is empty, .* To open one, add a folder to file_roots in the app options in Home Assistant\.$/);
  F.configure({});
});

// ------------------------------------------------- adb_uninstall counts by the device

// `pm list packages` (all, -s, -d) as listPackages() reads it.
const PKGS = all => `@@all@@\n${all.map(p => `package:${p}`).join('\n')}\n@@system@@\n@@disabled@@\n@@end@@\n`;

test('adb_uninstall: removed - the device output; still listed - failed with it, silent or not', async () => {
  const uninstallWith = (rule, listed) => {
    useFakeAdb([
      { match: '^-s 192\\.0\\.2\\.50:5555 uninstall com\\.example\\.tv$', ...rule },
      { match: 'pm list packages -d', stdout: PKGS(listed) },
    ]);
    return F.uninstall({ serial: '192.0.2.50:5555', package: 'com.example.tv' });
  };
  assert.equal((await uninstallWith({ stdout: 'Success\n' }, ['com.android.settings']))[0].text, 'Success');
  await assert.rejects(uninstallWith({ stdout: 'Success\n' }, ['com.example.tv', 'com.android.settings']),
    /^Error: com\.example\.tv: not removed: the device still lists it as installed; device output: Success$/, 'refused silently');
  await assert.rejects(uninstallWith({ stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n', code: 1 }, ['com.example.tv']),
    /^Error: com\.example\.tv: not removed: the device still lists it as installed; device output: adb uninstall exited with code 1\nstdout \(tail\): Failure \[DELETE_FAILED_INTERNAL_ERROR\]$/, 'refused with a text');
  const odd = (await uninstallWith({ stdout: 'Warning! This command is illegal!\n' }, []))[0].text;
  assert.equal(odd, 'Warning! This command is illegal!\nWarning: the device answered "Warning! This command is illegal!", but the change took effect');
});

test('adb_uninstall: the package list cannot be read - the answer of adb decides, marked not verified', async () => {
  useFakeAdb([{ match: ' uninstall ', stdout: 'Success\n' }]);
  assert.match((await F.uninstall({ serial: '192.0.2.50:5555', package: 'com.example.tv' }))[0].text,
    /^Success\nWarning: not verified: the package list could not be read afterwards \(/);
  useFakeAdb([{ match: ' uninstall ', stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n', code: 1 }]);
  await assert.rejects(F.uninstall({ serial: '192.0.2.50:5555', package: 'com.example.tv' }), /DELETE_FAILED_INTERNAL_ERROR/);
});
