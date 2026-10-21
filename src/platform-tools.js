'use strict';
/**
 * platform-tools.js — where adb is, and `brickproof-adb get-adb`.
 *
 * findAdb() only checks that files exist; it never runs adb, so the server
 * starts and lists its tools without adb. Order:
 *   adb_path (when set) → <state_dir>/platform-tools → PATH → Android SDK
 *   (ANDROID_HOME, ANDROID_SDK_ROOT, the Android Studio default) → WinGet →
 *   Homebrew.
 *
 * get-adb downloads Google's platform-tools zip into a temporary directory
 * under state_dir, unpacks it with the ZIP reader of files.js, and replaces
 * <state_dir>/platform-tools as a whole; nothing partial is left behind.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { zipEntries, zipRead } = require('./files.js');

const PLATFORM_ZIP = {
  win32: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  darwin: 'https://dl.google.com/android/repository/platform-tools-latest-darwin.zip',
  linux: 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
};
const LICENSE_URL = 'https://developer.android.com/studio/releases/platform-tools';

function exeName(platform = process.platform) {
  return platform === 'win32' ? 'adb.exe' : 'adb';
}

function isExecutableFile(p, platform = process.platform) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// A bare command name on PATH (PATHEXT on Windows).
function onPath(name, { env = process.env, platform = process.platform, exists = isExecutableFile } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(name)
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(e => /^\.(exe|com)$/i.test(e)).map(e => e.toLowerCase())
    : [''];
  for (const dir of String(env.PATH || env.Path || '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = P.join(dir, name + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}

/**
 * Every place adb may be, in order, with what is there: [{ path, source,
 * found }]; one file found by several paths is one place. `chosen` is
 * adb_path when it is set, else the first found; null when none is.
 * `exists`, `list` and `realpath` are the file system, replaceable in tests.
 */
function findAdb({ adbPath = 'adb', adbPathSource = 'default', stateDir, env = process.env, platform = process.platform,
  homedir = os.homedir(), exists = p => isExecutableFile(p, platform), list = dir => { try { return fs.readdirSync(dir); } catch { return []; } },
  realpath = p => fs.realpathSync.native(p) } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const exe = exeName(platform);
  const places = [];
  const add = (p, source) => { if (p) places.push({ path: p, source }); };

  const userSet = adbPathSource !== 'default';
  if (userSet) {
    if (/[\\/]/.test(adbPath)) add(adbPath, `adb_path (${adbPathSource})`);
    else add(onPath(adbPath, { env, platform, exists }) || adbPath, `adb_path (${adbPathSource}) on PATH`);
  }
  if (stateDir) add(P.join(stateDir, 'platform-tools', exe), 'get-adb');
  const onPathHit = onPath('adb', { env, platform, exists });
  // PATH is a place even without a hit: the list of where adb was looked for
  // names it (lookedIn).
  const pathAt = places.length;
  add(onPathHit, 'PATH');
  const v = name => (env[name] && P.isAbsolute(env[name]) ? env[name] : null);
  for (const [root, source] of [[v('ANDROID_HOME'), 'ANDROID_HOME'], [v('ANDROID_SDK_ROOT'), 'ANDROID_SDK_ROOT']]) {
    if (root) add(P.join(root, 'platform-tools', exe), source);
  }
  const local = v('LOCALAPPDATA') || P.join(homedir, 'AppData', 'Local');
  if (platform === 'win32') add(P.join(local, 'Android', 'Sdk', 'platform-tools', exe), 'Android Studio SDK');
  if (platform === 'darwin') add(P.join(homedir, 'Library', 'Android', 'sdk', 'platform-tools', exe), 'Android Studio SDK');
  if (platform === 'linux') add(P.join(homedir, 'Android', 'Sdk', 'platform-tools', exe), 'Android Studio SDK');
  if (platform === 'win32') {
    add(P.join(local, 'Microsoft', 'WinGet', 'Links', exe), 'WinGet');
    const pkgs = P.join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const d of list(pkgs).filter(n => /^Google\.PlatformTools_/.test(n)).sort())
      add(P.join(pkgs, d, 'platform-tools', exe), 'WinGet');
  }
  if (platform === 'darwin') {
    add('/opt/homebrew/bin/adb', 'Homebrew');
    add('/usr/local/bin/adb', 'Homebrew');
  }
  for (const p of places) p.found = exists(p.path);
  const merged = mergeSameFile(places, { platform, realpath });
  // An adb_path someone set is used as it is, found or not: silently taking
  // another adb instead would bring back the version clash it was set to
  // avoid. Otherwise the first one found.
  const chosen = userSet ? merged[0] : (merged.find(p => p.found) || null);
  // The place that comes right after PATH in the search, for lookedIn().
  const afterPath = onPathHit ? null : places[pathAt] || null;
  return { places: merged, chosen, userSet, pathMissed: !onPathHit, afterPath };
}

/**
 * Where adb was looked for, in the order of the search, for `check`: the
 * paths, with "PATH (no adb there)" in its place when PATH had none.
 */
function lookedIn(found) {
  const out = found.places.map(p => p.path);
  if (found.pathMissed) {
    const i = found.afterPath ? found.places.indexOf(found.afterPath) : -1;
    out.splice(i === -1 ? out.length : i, 0, 'PATH (no adb there)');
  }
  return out;
}

// One file reached by several paths (another case of the drive letter, a
// symlink) is one place, at its first path, with every source: "PATH, Android
// Studio SDK". Compared by realpath; without case on Windows and macOS.
function mergeSameFile(places, { platform = process.platform, realpath = p => fs.realpathSync.native(p) } = {}) {
  const fold = platform === 'win32' || platform === 'darwin';
  const byKey = new Map();
  const out = [];
  for (const p of places) {
    let key = p.path;
    if (p.found) { try { key = realpath(p.path); } catch {} }
    if (fold) key = key.toLowerCase();
    const first = byKey.get(key);
    if (!first) { byKey.set(key, p); out.push(p); continue; }
    if (!first.source.split(', ').includes(p.source)) first.source += `, ${p.source}`;
  }
  return out;
}

/**
 * The adb the server uses: the first one found, else the setting as it is
 * (so the error says what was looked for).
 */
function resolveAdbPath(settings, sources, opts = {}) {
  const r = findAdb({ adbPath: settings.adb_path, adbPathSource: sources ? sources.adb_path : 'default', stateDir: settings.state_dir, ...opts });
  return { path: r.chosen ? r.chosen.path : settings.adb_path, source: r.chosen ? r.chosen.source : 'not found', ...r };
}

// ------------------------------------------------------------------ get-adb

/** Why get-adb cannot run here, or null. */
function getAdbRefusal(platform = process.platform, arch = process.arch) {
  if (!PLATFORM_ZIP[platform]) return `Google publishes platform-tools for Windows, macOS and Linux only, not for ${platform}`;
  if (platform === 'linux' && arch !== 'x64')
    return `Google publishes platform-tools for Linux on x86_64 only, this machine is ${arch}. Install your distribution's package instead, ` +
      'e.g. `sudo apt install adb` (Debian, Ubuntu), `sudo dnf install android-tools` (Fedora) or `sudo pacman -S android-tools` (Arch)';
  return null;
}

/**
 * A safe relative path for a ZIP entry under a directory: forward or back
 * slashes as separators; an absolute name, a drive, "..", ":" or NUL is
 * refused, and the result must stay inside `dir`. null for a directory entry.
 */
function safeEntryPath(dir, name) {
  const parts = String(name).split(/[\\/]+/);
  const isDirEntry = /[\\/]$/.test(name);
  if (/^[\\/]/.test(name) || parts.some(p => p === '..' || /[:\0]/.test(p)))
    throw new Error(`unsafe file name in the archive: ${JSON.stringify(String(name)).slice(0, 120)}`);
  const clean = parts.filter(p => p && p !== '.');
  if (!clean.length) return null;
  const full = path.join(dir, ...clean);
  const rel = path.relative(dir, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe file name in the archive: ${JSON.stringify(String(name)).slice(0, 120)}`);
  return { full, isDir: isDirEntry };
}

/**
 * Unpack a ZIP buffer into `dir`. Unix modes of the entries are kept on POSIX
 * (adb needs its execute bit); symlinks are refused. Returns the file count.
 */
function extractZip(buf, dir, { platform = process.platform } = {}) {
  let files = 0;
  for (const e of zipEntries(buf)) {
    const target = safeEntryPath(dir, e.name);
    if (!target) continue;
    const unixMode = (e.attr >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`the archive holds a symlink, which is not unpacked: ${e.name}`);
    if (target.isDir || (unixMode & 0o170000) === 0o040000) { fs.mkdirSync(target.full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target.full), { recursive: true });
    fs.writeFileSync(target.full, zipRead(buf, e));
    if (platform !== 'win32') {
      const mode = unixMode & 0o777;
      fs.chmodSync(target.full, mode ? mode | 0o600 : 0o644);
    }
    files++;
  }
  return files;
}

/** GET with redirects, into a Buffer. */
function download(url, { maxRedirects = 5, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (!maxRedirects) return reject(new Error('too many redirects'));
        return resolve(download(new URL(res.headers.location, url).href, { maxRedirects: maxRedirects - 1, timeoutMs }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${url}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${url} within ${timeoutMs / 1000} s`)));
    req.on('error', reject);
  });
}

/**
 * Install platform-tools from a ZIP buffer into <stateDir>/platform-tools:
 * unpack into a temporary directory next to it, check that adb is there, then
 * swap the directories. On any failure the old directory stays as it was and
 * the temporary one is removed.
 */
function installPlatformTools(buf, stateDir, { platform = process.platform } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const target = path.join(stateDir, 'platform-tools');
  const tmp = fs.mkdtempSync(path.join(stateDir, '.platform-tools-new-'));
  const old = path.join(stateDir, `.platform-tools-old-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const files = extractZip(buf, tmp, { platform });
    const unpacked = path.join(tmp, 'platform-tools');
    const adb = path.join(unpacked, exeName(platform));
    if (!fs.existsSync(adb)) throw new Error('the archive has no platform-tools/' + exeName(platform));
    let moved = false;
    if (fs.existsSync(target)) { fs.renameSync(target, old); moved = true; }
    try {
      fs.renameSync(unpacked, target);
    } catch (e) {
      if (moved) fs.renameSync(old, target);
      throw e;
    }
    if (moved) fs.rmSync(old, { recursive: true, force: true });
    return { dir: target, adb: path.join(target, exeName(platform)), files };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  PLATFORM_ZIP, LICENSE_URL, exeName, onPath, findAdb, resolveAdbPath, lookedIn,
  getAdbRefusal, safeEntryPath, extractZip, download, installPlatformTools,
};
