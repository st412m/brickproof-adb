'use strict';
/**
 * adb.js — the adb binary and everything around it that knows nothing about
 * particular tools: running commands, turning typical failures into advice,
 * quoting for the device shell, client argument coercion, host temp dirs.
 *
 * Every adb call goes through run(): adb() for buffered output, spawnAdb() for
 * a stream (the screenshot). The server never starts, stops or moves the adb
 * server: the first client call starts it on 127.0.0.1:5037 if it is not
 * running, and that server is shared with the user's own adb.
 */

const { execFile, spawn } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ADB_TIMEOUT_MS = 30000;
const ADB_MAX_BUFFER = 16 * 1024 * 1024;

// The binary: adb_path, or "adb" looked up on PATH (libuv finds adb.exe on
// Windows). PREFIX is empty in production; tests put a script there.
let ADB_BIN = 'adb';
let ADB_PREFIX = [];

function configure({ adbPath } = {}) {
  ADB_BIN = adbPath || 'adb';
  ADB_PREFIX = [];
}

/**
 * Tests only: run `bin prefix... <adb args>` instead of adb, e.g.
 * (process.execPath, ['test/fake-adb.js']). A script cannot be adb_path on
 * Windows (execFile runs no .js or .cmd without a shell), so the fake adb is
 * started through node. Not a setting, not an environment variable.
 */
function useTestRunner(bin, prefix = []) {
  ADB_BIN = bin;
  ADB_PREFIX = prefix.slice();
}

function adbBinary() {
  return ADB_BIN;
}

// ---------------------------------------------------------------- call notes
// Warnings that belong to the whole tool call rather than to one adb command
// (another adb restarted the server). server.js collects them per call and
// appends them to the result.

const callNotes = new AsyncLocalStorage();

async function collectNotes(fn) {
  const notes = new Set();
  try {
    const value = await callNotes.run(notes, fn);
    return { value, notes: [...notes] };
  } catch (e) {
    e.adbNotes = [...notes];
    throw e;
  }
}

function addNote(msg) {
  const store = callNotes.getStore();
  if (store) store.add(msg);
}

// The client prints this to stderr when its version differs from the running
// server's, then kills that server and starts its own; network devices drop.
// The numbers are the protocol version: two builds of one protocol print the
// same number twice.
const FOREIGN_ADB_RE = /adb server version \((\d+)\) doesn't match this client \((\d+)\)/;

function foreignAdbWarning(stderr) {
  const m = FOREIGN_ADB_RE.exec(String(stderr || ''));
  if (!m) return null;
  const versions = m[1] !== m[2] ? ` (server version ${m[1]}, client version ${m[2]})` : '';
  return `⚠ the adb server was started by another adb on this machine and this client restarted it${versions}, ` +
    'so network devices may need adb_connect again. Set adb_path to the same adb your other programs use (Android Studio, scrcpy, vendor tools); `brickproof-adb check` lists every adb it finds.';
}

/**
 * `<bin> version` of any adb found on the machine, for `check`: { ok, build,
 * protocol, error }. The only adb call that does not use the configured
 * binary.
 */
function adbVersionOf(bin, timeout = 10000) {
  return new Promise(resolve => {
    execFile(bin, ['version'], { timeout, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.code || err.message });
      const out = String(stdout || '');
      const protocol = (/Android Debug Bridge version (\S+)/.exec(out) || [])[1] || null;
      const build = (/^Version (\S+)/m.exec(out) || [])[1] || null;
      resolve({ ok: true, protocol, build });
    });
  });
}

function noteForeignAdb(stderr) {
  const w = foreignAdbWarning(stderr);
  if (w) addNote(w);
}

// ------------------------------------------------------------------ failures

function installHint(platform = process.platform) {
  const cmd = platform === 'win32' ? 'winget install Google.PlatformTools'
    : platform === 'darwin' ? 'brew install --cask android-platform-tools'
      : 'the adb or android-tools package of your distribution';
  return 'Run `brickproof-adb get-adb` to download Google\'s platform-tools, ' +
    `or install them yourself (${cmd}; https://developer.android.com/tools/releases/platform-tools), ` +
    'or set adb_path to the adb executable.';
}

// Typical adb errors get the action that fixes them.
function friendlyAdbError(msg) {
  if (/device '.*' not found|no devices\/emulators found/i.test(msg))
    return `${msg}. Call adb_devices to list what is connected; network devices may need adb_connect first (wireless-debug ports change after phone reboot). ` +
      'A device that is not in that list: adb_devices discover=true searches the network for it.';
  if (/device offline/i.test(msg))
    return `${msg}. The TCP session died (device slept or rebooted) - run adb_disconnect for this host, then adb_connect again.`;
  if (/device unauthorized|failed to authenticate/i.test(msg))
    return `${msg}. Confirm the prompt to allow debugging on the device screen (check "Always allow").`;
  if (/INSTALL_FAILED_VERIFICATION_FAILURE/i.test(msg))
    return `${msg}. The on-device package verifier rejects ADB installs - disable it once via adb_shell (needs allow_shell): settings put global verifier_verify_adb_installs 0`;
  return msg;
}

/**
 * The text of a failed adb call, built from the execFile fields. A non-empty
 * stderr is the message (plus the stdout tail). With an empty stderr only the
 * adb subcommand is named, never the argv: the argv carries call arguments
 * (typed text, pairing codes).
 *
 * ⚠ maxBuffer is checked first: Node reports it as the string code
 * ERR_CHILD_PROCESS_STDIO_MAXBUFFER without `killed`, which would otherwise
 * read as "adb could not start".
 */
function describeAdbFailure(err, stderr, stdout, args, opts = {}) {
  const raw = (stderr || '').toString();
  // "* daemon not running; starting now", "* daemon started successfully":
  // progress of the adb server start, never the cause of a failure.
  let msg = raw.split(/\r?\n/).filter(l => !/^\s*\* daemon /i.test(l)).join('\n').trim();
  const out = opts.binary ? '' : (stdout || '').toString().trim();
  const a = args || [];
  const sub = (a[0] === '-s' ? a[2] : a[0]) || '(no subcommand)';
  const e = err || {};
  const secs = +((opts.timeout || ADB_TIMEOUT_MS) / 1000).toFixed(3);
  if (e.killed === true && /daemon not running; starting now/i.test(raw))
    msg = `adb ${sub} timed out after ${secs} s: the adb server was still starting (it can take about 20 s on Windows); call again`;
  if (!msg) {
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
      msg = `adb ${sub} output exceeded ${ADB_MAX_BUFFER / 1024 / 1024} MB and was killed`;
    else if (e.killed === true)
      msg = `adb ${sub} timed out after ${secs} s and was killed${e.signal ? ` (${e.signal})` : ''}`;
    else if (e.signal)
      msg = `adb ${sub} was terminated by ${e.signal}`;
    else if (typeof e.code === 'number')
      msg = out ? `adb ${sub} exited with code ${e.code}` : `adb ${sub} exited with code ${e.code} and printed nothing`;
    else if (e.code === 'ENOENT')
      msg = `adb could not start: ENOENT - adb was not found (adb_path: ${JSON.stringify(ADB_BIN)}). ${installHint()}`;
    else if (e.code === 'EINVAL' && process.platform === 'win32')
      msg = 'adb could not start: EINVAL - adb_path must point to the adb executable (adb.exe), not to a .cmd or .bat file';
    else if (typeof e.code === 'string')
      msg = `adb could not start: ${e.code}`;
    else
      msg = `adb ${sub} failed without output`;
  }
  // stdout is kept on a non-zero exit: a failed device pipeline is unreadable
  // without its output.
  if (out) msg = `${msg}\nstdout (tail): ${out.slice(-2000)}`;
  return friendlyAdbError(msg);
}

// --------------------------------------------------------------------- calls

function adb(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(ADB_BIN, [...ADB_PREFIX, ...args], {
      timeout: opts.timeout || ADB_TIMEOUT_MS,
      maxBuffer: ADB_MAX_BUFFER,
      encoding: opts.binary ? 'buffer' : 'utf8',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      noteForeignAdb(stderr);
      if (err) return reject(new Error(describeAdbFailure(err, stderr, stdout, args, opts)));
      resolve(opts.withStderr ? { stdout, stderr } : stdout);
    });
  });
}

/**
 * adb with stdout going straight into a file descriptor (the screenshot PNG):
 * the bytes never pass through this process. Resolves { code, signal,
 * timedOut, stderr }; rejects only when adb cannot be started.
 */
function spawnAdb(args, outFd, opts = {}) {
  const timeout = opts.timeout || ADB_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ADB_BIN, [...ADB_PREFIX, ...args], { stdio: ['ignore', outFd, 'pipe'], windowsHide: true });
    } catch (e) {
      reject(new Error(describeAdbFailure(e, '', '', args, opts)));
      return;
    }
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stderr.on('data', c => { if (stderr.length < 64 * 1024) stderr += c; });
    child.on('error', e => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(describeAdbFailure(e, '', '', args, opts)));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      noteForeignAdb(stderr);
      resolve({ code, signal, timedOut, stderr });
    });
  });
}

function withSerial(serial, args) {
  return serial ? ['-s', serial, ...args] : args;
}

// Single quotes for the DEVICE shell.
function sq(x) {
  return `'${String(x).replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a command in the device shell and return stdout as a string.
 *
 * ⚠ tolerant (on by default) appends `; :`. Without it the last command of a
 * chain sets the exit code, and a grep with no match (exit 1) fails the whole
 * call with a useless "Command failed".
 */
async function adbSh(serial, cmd, opts = {}) {
  const body = opts.tolerant === false ? cmd : `${cmd}; :`;
  const out = await adb(withSerial(serial, ['shell', body]), opts);
  return out.toString();
}

function text(t) { return [{ type: 'text', text: t }]; }

function json(obj) { return text(JSON.stringify(obj, null, 2)); }

// The argument of `input text`, before sq() quotes it for the device shell.
// `input text` (Input.java up to SDK 30, InputShellCommand from SDK 31) has
// one rule of its own: "%s" is a space. Every other character is typed as it
// is, so nothing else is escaped; a space becomes %s, as it always worked.
function escapeInputText(s) {
  return s.replace(/ /g, '%s');
}

// Some MCP clients send array parameters as JSON strings.
function coerceArray(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* not JSON: a single value */ }
    }
  }
  return [v];
}

// The same for booleans: "true"/"false" strings.
function coerceBool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

// The same for objects (adb_app action=launch extras): a JSON string is accepted.
function coerceObject(v) {
  if (v === undefined || v === null) return {};
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return {};
    if (s.startsWith('{') && s.endsWith('}')) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* not JSON: refused below */ }
    }
  }
  throw new Error(`extras: expected a key-value object, got ${JSON.stringify(v).slice(0, 120)}`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// A serial as a directory name: 192.0.2.50:5555 -> 192.0.2.50_5555. Trailing
// dots are dropped, Windows would drop them silently.
function sanitizeSerial(serial) {
  const s = String(serial || 'default').replace(/[^\w.\-]+/g, '_').replace(/\.+$/, '');
  return s || '_';
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_RETRIES = 5;

/**
 * rename() with retries for a target held open by another process (an
 * antivirus or indexer on Windows): up to RENAME_RETRIES more attempts with a
 * growing pause, one stderr line per retry. Other errors throw at once.
 */
async function renameWithRetry(from, to, {
  fsImpl = fs, retries = RENAME_RETRIES, delayMs = 100,
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  log = line => process.stderr.write(line + '\n'),
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      fsImpl.renameSync(from, to);
      return attempt;
    } catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || attempt >= retries) throw e;
      log(`brickproof-adb: rename ${from} -> ${to} failed with ${e.code}, retry ${attempt + 1}/${retries}`);
      await sleep(delayMs * (attempt + 1));
    }
  }
}

// ------------------------------------------------------------ host temp dirs
// Every temporary directory on the host is <tmpdir>/brickproof-*, removed in
// a finally; sweepTempDirs() at start removes those left by a killed process.

const TEMP_PREFIX = 'brickproof-';

function makeTempDir(kind = '') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${kind}`));
}

function sweepTempDirs({ maxAgeMs = 3600000, dir = os.tmpdir(), now = Date.now() } = {}) {
  const removed = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return removed; }
  for (const n of names) {
    if (!n.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(dir, n);
    try {
      const st = fs.lstatSync(full);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(full);
    } catch { /* another process, or no permission: leave it */ }
  }
  return removed;
}

module.exports = {
  ADB_TIMEOUT_MS, ADB_MAX_BUFFER, TEMP_PREFIX,
  configure, useTestRunner, adbBinary,
  adb, spawnAdb, adbSh, withSerial, friendlyAdbError, describeAdbFailure, installHint,
  collectNotes, addNote, foreignAdbWarning, FOREIGN_ADB_RE, adbVersionOf,
  sq, text, json, escapeInputText,
  coerceArray, coerceBool, coerceObject,
  ensureDir, sanitizeSerial, makeTempDir, sweepTempDirs, renameWithRetry,
};
