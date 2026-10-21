'use strict';
// Where adb is found, and the get-adb installation: no network, no real adb.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PT = require('../src/platform-tools.js');
const { tmpDir, makeZip } = require('./helpers.js');

// A file system of the given paths only.
const fsOf = paths => ({ exists: p => paths.includes(p), list: dir => paths.filter(p => p.startsWith(dir + '\\') || p.startsWith(dir + '/')).map(p => p.slice(dir.length + 1).split(/[\\/]/)[0]) });

test('Windows: adb_path unset — get-adb, PATH, SDK, WinGet in this order', () => {
  const env = { PATH: 'C:\\Tools;C:\\Windows', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ANDROID_HOME: 'D:\\sdk' };
  const base = { stateDir: 'C:\\Users\\me\\AppData\\Local\\brickproof-adb', env, platform: 'win32', homedir: 'C:\\Users\\me' };
  const all = [
    'C:\\Users\\me\\AppData\\Local\\brickproof-adb\\platform-tools\\adb.exe',
    'C:\\Tools\\adb.exe',
    'D:\\sdk\\platform-tools\\adb.exe',
    'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\adb.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\\platform-tools\\adb.exe',
  ];
  for (let i = 0; i < all.length; i++) {
    const r = PT.findAdb({ ...base, ...fsOf(all.slice(i)) });
    assert.equal(r.chosen.path, all[i], `with ${all.slice(i).length} present`);
  }
  const r = PT.findAdb({ ...base, ...fsOf(all) });
  assert.deepEqual(r.places.map(p => p.source), ['get-adb', 'PATH', 'ANDROID_HOME', 'Android Studio SDK', 'WinGet', 'WinGet']);
  assert.ok(r.places.every(p => p.found));
  assert.equal(PT.findAdb({ ...base, ...fsOf([]) }).chosen, null);
});

test('macOS and Linux: SDK and Homebrew places; nothing is run', () => {
  const mac = PT.findAdb({ stateDir: '/Users/me/Library/Application Support/brickproof-adb', env: { PATH: '/usr/bin' }, platform: 'darwin', homedir: '/Users/me', ...fsOf(['/opt/homebrew/bin/adb']) });
  assert.equal(mac.chosen.path, '/opt/homebrew/bin/adb');
  assert.ok(mac.places.some(p => p.path === '/Users/me/Library/Android/sdk/platform-tools/adb'));
  const lin = PT.findAdb({ stateDir: '/home/me/.local/state/brickproof-adb', env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', homedir: '/home/me', ...fsOf(['/usr/bin/adb', '/home/me/Android/Sdk/platform-tools/adb']) });
  assert.equal(lin.chosen.path, '/usr/bin/adb', 'PATH before the SDK');
  assert.equal(lin.chosen.source, 'PATH');
});

test('an adb_path someone set is used as it is, even when it is missing', () => {
  const env = { PATH: '/usr/bin' };
  const set = PT.findAdb({ adbPath: '/opt/adb', adbPathSource: 'env BRICKPROOF_ADB', env, platform: 'linux', homedir: '/home/me', ...fsOf(['/usr/bin/adb']) });
  assert.equal(set.chosen.path, '/opt/adb');
  assert.equal(set.chosen.found, false);
  assert.ok(set.places.some(p => p.path === '/usr/bin/adb' && p.found), 'the others are still listed');
  const bare = PT.findAdb({ adbPath: 'adb', adbPathSource: 'config x', env, platform: 'linux', homedir: '/home/me', ...fsOf(['/usr/bin/adb']) });
  assert.equal(bare.chosen.path, '/usr/bin/adb', 'a bare name is looked up on PATH');
});

test('lookedIn: PATH is named in its place also when it had no adb; the search itself is unchanged', () => {
  const env = { PATH: 'C:\\Tools', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ANDROID_HOME: 'D:\\sdk' };
  const base = { stateDir: 'C:\\Users\\me\\AppData\\Local\\brickproof-adb', env, platform: 'win32', homedir: 'C:\\Users\\me' };
  const none = PT.findAdb({ ...base, ...fsOf([]) });
  assert.equal(none.chosen, null);
  assert.deepEqual(PT.lookedIn(none), [
    'C:\\Users\\me\\AppData\\Local\\brickproof-adb\\platform-tools\\adb.exe',
    'PATH (no adb there)',
    'D:\\sdk\\platform-tools\\adb.exe',
    'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\adb.exe',
  ]);
  assert.ok(!none.places.some(p => /PATH/.test(p.path)), 'not a place to look in');
  const hit = PT.findAdb({ ...base, ...fsOf(['C:\\Tools\\adb.exe']) });
  assert.deepEqual(PT.lookedIn(hit).filter(p => /PATH|Tools/.test(p)), ['C:\\Tools\\adb.exe'], 'a hit is listed as its file');
  const lin = PT.findAdb({ env: { PATH: '' }, platform: 'linux', homedir: '/home/me', ...fsOf([]) });
  assert.deepEqual(PT.lookedIn(lin), ['PATH (no adb there)', '/home/me/Android/Sdk/platform-tools/adb'], 'first when nothing comes before it');
});

test('one adb found by several paths is one place with every source', () => {
  // Windows: PATH says c:\, LOCALAPPDATA says C:\ — the case of S1.
  const sdk = 'C:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
  const env = { PATH: 'c:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };
  const exists = p => p.toLowerCase() === sdk.toLowerCase();
  const win = PT.findAdb({ env, platform: 'win32', homedir: 'C:\\Users\\me', exists, list: () => [], realpath: p => p });
  const found = win.places.filter(p => p.found);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'c:\\Users\\me\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe', 'the first path is kept');
  assert.equal(found[0].source, 'PATH, Android Studio SDK');
  assert.equal(win.chosen, found[0]);
  // A symlink: another path, the same realpath.
  const links = { '/usr/local/bin/adb': '/home/me/Android/Sdk/platform-tools/adb', '/home/me/Android/Sdk/platform-tools/adb': '/home/me/Android/Sdk/platform-tools/adb' };
  const lin = PT.findAdb({ env: { PATH: '/usr/local/bin', ANDROID_HOME: '/home/me/Android/Sdk' }, platform: 'linux', homedir: '/home/me',
    exists: p => p in links, list: () => [], realpath: p => links[p] });
  assert.deepEqual(lin.places.filter(p => p.found).map(p => [p.path, p.source]), [['/usr/local/bin/adb', 'PATH, ANDROID_HOME, Android Studio SDK']]);
  // Linux compares with case: two files.
  const two = { '/opt/A/platform-tools/adb': 1, '/opt/a/platform-tools/adb': 1 };
  const cs = PT.findAdb({ env: { ANDROID_HOME: '/opt/A', ANDROID_SDK_ROOT: '/opt/a' }, platform: 'linux', homedir: '/home/me', exists: p => p in two, list: () => [], realpath: p => p });
  assert.equal(cs.places.filter(p => p.found).length, 2);
});

test('one adb found by several paths: on the real file system', t => {
  const dir = tmpDir();
  const exe = PT.exeName();
  const real = path.join(dir, 'sdk', 'platform-tools', exe);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '');
  fs.chmodSync(real, 0o755);
  let linkDir = path.join(dir, 'bin');
  try {
    fs.symlinkSync(path.dirname(real), linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (e) {
    t.skip(`cannot create a link here: ${e.code}`);
    return;
  }
  // Windows: the drive letter in the other case as well.
  if (process.platform === 'win32') linkDir = linkDir[0] === linkDir[0].toUpperCase() ? linkDir[0].toLowerCase() + linkDir.slice(1) : linkDir[0].toUpperCase() + linkDir.slice(1);
  const r = PT.findAdb({ env: { PATH: linkDir, ANDROID_HOME: path.join(dir, 'sdk') }, homedir: dir, stateDir: path.join(dir, 'state') });
  const found = r.places.filter(p => p.found);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].source, 'PATH, ANDROID_HOME');
});

test('get-adb refuses where Google publishes nothing', () => {
  assert.equal(PT.getAdbRefusal('win32', 'x64'), null);
  assert.equal(PT.getAdbRefusal('darwin', 'arm64'), null);
  assert.equal(PT.getAdbRefusal('linux', 'x64'), null);
  assert.match(PT.getAdbRefusal('linux', 'arm64'), /x86_64 only, this machine is arm64\. Install your distribution's package instead/);
  assert.match(PT.getAdbRefusal('freebsd', 'x64'), /not for freebsd/);
  assert.match(PT.PLATFORM_ZIP.win32, /^https:\/\/dl\.google\.com\/android\/repository\/platform-tools-latest-windows\.zip$/);
});

test('extractZip: directories, files, unix modes; no symlinks; nothing outside', () => {
  const dir = tmpDir();
  const zip = makeZip([
    ['platform-tools/', '', { mode: 0o040755 }],
    ['platform-tools/adb', 'ADB', { deflate: true, mode: 0o100755 }],
    ['platform-tools/NOTICE.txt', 'notice', { mode: 0o100644 }],
    ['platform-tools/lib64/libc++.so', 'lib', { deflate: true }],
  ]);
  assert.equal(PT.extractZip(zip, dir), 3);
  assert.equal(fs.readFileSync(path.join(dir, 'platform-tools', 'adb'), 'utf8'), 'ADB');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'platform-tools', 'adb')).mode & 0o111, 0o111);
  for (const bad of ['../evil', 'platform-tools/../../evil', '/abs/evil', 'C:/evil', 'a\\..\\..\\evil', 'x/\0']) {
    const d2 = tmpDir();
    assert.throws(() => PT.extractZip(makeZip([[bad, 'x']]), d2), /unsafe file name in the archive/, bad);
    assert.deepEqual(fs.readdirSync(d2), [], `nothing written for ${bad}`);
  }
  assert.throws(() => PT.extractZip(makeZip([['platform-tools/link', '../../etc', { mode: 0o120777 }]]), tmpDir()), /holds a symlink/);
});

test('installPlatformTools: replaces the directory as a whole; a bad archive leaves the old one', () => {
  const state = tmpDir();
  const exe = PT.exeName();
  const v1 = makeZip([[`platform-tools/${exe}`, 'one', { mode: 0o100755 }], ['platform-tools/old-only.txt', 'x']]);
  const r1 = PT.installPlatformTools(v1, state);
  assert.equal(r1.adb, path.join(state, 'platform-tools', exe));
  assert.equal(fs.readFileSync(r1.adb, 'utf8'), 'one');
  const v2 = makeZip([[`platform-tools/${exe}`, 'two', { mode: 0o100755 }]]);
  PT.installPlatformTools(v2, state);
  assert.equal(fs.readFileSync(r1.adb, 'utf8'), 'two');
  assert.equal(fs.existsSync(path.join(state, 'platform-tools', 'old-only.txt')), false, 'replaced, not merged');
  assert.throws(() => PT.installPlatformTools(makeZip([['other/readme', 'x']]), state), /the archive has no platform-tools\//);
  assert.throws(() => PT.installPlatformTools(Buffer.from('not a zip'), state), /not a ZIP/);
  assert.equal(fs.readFileSync(r1.adb, 'utf8'), 'two', 'the installed one is untouched');
  assert.deepEqual(fs.readdirSync(state), ['platform-tools'], 'no temporary directories left');
});
