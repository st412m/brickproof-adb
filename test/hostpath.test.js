'use strict';
// The host path check on this platform: Linux, macOS and Windows in CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkHostPath, inside } = require('../src/hostpath.js');
const { tmpDir } = require('./helpers.js');

const WIN = process.platform === 'win32';
const CASE_INSENSITIVE = WIN || process.platform === 'darwin';

const base = tmpDir();
const root = path.join(base, 'media');
const sibling = path.join(base, 'media2');
const outside = path.join(base, 'elsewhere');
for (const d of [root, sibling, outside]) fs.mkdirSync(d);
fs.mkdirSync(path.join(root, 'apk'));
fs.writeFileSync(path.join(root, 'apk', 'a.apk'), 'x');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');

const opts = { roots: [root] };
const refused = (p, re, o = opts) => assert.throws(() => checkHostPath(p, o), err => err.name === 'HostPathError' && re.test(err.message), p);

test('inside a root: the root, an existing file, a file that does not exist yet', () => {
  assert.equal(checkHostPath(root, opts), root);
  assert.equal(checkHostPath(path.join(root, 'apk', 'a.apk'), opts), path.join(root, 'apk', 'a.apk'));
  assert.equal(checkHostPath(path.join(root, 'new', 'deeper', 'x.png'), opts), path.join(root, 'new', 'deeper', 'x.png'));
  assert.equal(fs.existsSync(path.join(root, 'new')), false, 'nothing is created');
});

test('outside: another directory, a sibling whose name starts like the root, .. climbing out', () => {
  refused(path.join(outside, 'secret.txt'), /is outside the allowed directories \(file_roots: /);
  refused(path.join(sibling, 'x'), /is outside the allowed directories/);
  refused(sibling, /is outside the allowed directories/);
  refused(path.join(root, '..', 'elsewhere', 'secret.txt'), /is outside the allowed directories/);
  refused(path.join(root, 'apk', '..', '..', 'media2'), /is outside/);
});

test('a name that only starts with ".." is inside', () => {
  assert.equal(inside(path.join(root, '..x'), root), true);
  assert.equal(inside(path.join(root, '..'), root), false);
});

test('relative paths and NUL are refused', () => {
  refused('media/apk/a.apk', /must be an absolute path/);
  refused(path.join(root, 'a\0b'), /NUL/);
  refused('', /non-empty string/);
});

test('Windows: UNC, device and drive-less paths are refused', { skip: !WIN && 'Windows only' }, () => {
  refused('\\\\server\\share\\x.apk', /UNC and device paths/);
  refused('//server/share/x.apk', /UNC and device paths/);
  refused('\\\\?\\C:\\x.apk', /UNC and device paths/);
  refused('\\\\.\\COM1', /UNC and device paths/);
  refused('\\x.apk', /must be an absolute path with a drive letter/);
  refused('C:x.apk', /must be an absolute path with a drive letter/);
});

test('letter case: ignored on Windows and macOS, significant on Linux', () => {
  const other = path.join(base, 'MEDIA', 'apk', 'a.apk');
  if (CASE_INSENSITIVE) assert.equal(checkHostPath(other, opts), other);
  else refused(other, /is outside/);
});

test('a symlink or junction inside a root that leads out is refused', t => {
  const link = path.join(root, 'escape');
  try {
    fs.symlinkSync(outside, link, WIN ? 'junction' : 'dir');
  } catch (e) {
    t.skip(`cannot create a link here: ${e.code}`);
    return;
  }
  refused(path.join(link, 'secret.txt'), /a symlink or junction on the way leads out of them/);
  refused(path.join(link, 'not-yet', 'x.txt'), /leads out of them/);
  // A link that stays inside the root is fine.
  const inner = path.join(root, 'inner');
  fs.symlinkSync(path.join(root, 'apk'), inner, WIN ? 'junction' : 'dir');
  assert.equal(checkHostPath(path.join(inner, 'a.apk'), opts), path.join(inner, 'a.apk'));
});

test('a root reached through a symlink still works (its real path is compared)', t => {
  const viaLink = path.join(base, 'media-link');
  try {
    fs.symlinkSync(root, viaLink, WIN ? 'junction' : 'dir');
  } catch (e) {
    t.skip(`cannot create a link here: ${e.code}`);
    return;
  }
  assert.equal(checkHostPath(path.join(viaLink, 'apk', 'a.apk'), { roots: [viaLink] }), path.join(viaLink, 'apk', 'a.apk'));
});

test('no roots: the refusal names the setting to set', () => {
  refused(path.join(root, 'x'), /is refused: file_roots is empty, so no folder on this computer is open to the tools\. To open one, run `brickproof-adb set file_roots <folder>` and restart the server\.$/, { roots: [] });
  refused(path.join(root, 'x'), /To open one, add a folder to file_roots in the app options in Home Assistant\.$/, { roots: [], emptyHint: 'add a folder to file_roots in the app options in Home Assistant' });
});

test('the refusal names the setting and does not print a long root list', () => {
  const many = Array.from({ length: 6 }, (_, i) => path.join(base, `r${i}`));
  refused(path.join(outside, 'x'), /\(file_roots: 6 directories\)$/, { roots: many });
  refused(path.join(outside, 'x'), /\(store: /, { roots: [root], setting: 'store', what: 'store' });
});

test('exact: the path itself is accepted, its contents are not unless inside a root', () => {
  const store = path.join(outside, 'store');
  assert.equal(checkHostPath(store, { roots: [root], exact: [store], setting: 'store' }), store);
  refused(path.join(store, 'sub'), /is outside/, { roots: [root], exact: [store], setting: 'store' });
  assert.equal(checkHostPath(path.join(root, 'snap'), { roots: [root], exact: [store], setting: 'store' }), path.join(root, 'snap'));
});
