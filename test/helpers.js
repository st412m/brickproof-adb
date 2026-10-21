'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');

// A fresh temp dir per call, removed when the test file finishes. Resolved with
// the native realpath: on Windows the JS realpath keeps 8.3 short names.
function tmpDir(prefix = 'bp-test-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  return file;
}

const CLI = path.join(__dirname, '..', 'src', 'main.js');
const FAKE_ADB = path.join(__dirname, 'fake-adb.js');

// An environment that cannot pick up the real config, state dir, token or adb:
// every settings directory of every OS points into `home`, PATH holds no adb
// (node is started by its full path).
function isolatedEnv(home, extra = {}) {
  const env = {
    PATH: path.join(home, 'no-bin'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    BRICKPROOF_ADB: path.join(home, 'no-adb-here', 'adb'),
    ...extra,
  };
  // Windows needs these for sockets and temp files.
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'windir', 'ComSpec', 'PATHEXT']) {
    if (process.env[k] !== undefined && env[k] === undefined) env[k] = process.env[k];
  }
  return env;
}

/**
 * Point adb.js at the fake adb with these rules (see fake-adb.js). Returns
 * { log(): argv arrays of every call, rules(list): replace the rules }.
 */
function useFakeAdb(rules = []) {
  const A = require('../src/adb.js');
  const dir = tmpDir('bp-fake-');
  const rulesFile = path.join(dir, 'rules.json');
  const logFile = path.join(dir, 'calls.log');
  const set = list => fs.writeFileSync(rulesFile, JSON.stringify(list));
  set(rules);
  process.env.FAKE_ADB_RULES = rulesFile;
  process.env.FAKE_ADB_LOG = logFile;
  A.useTestRunner(process.execPath, [FAKE_ADB]);
  return {
    dir,
    rules: set,
    log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []),
    clearLog: () => { try { fs.unlinkSync(logFile); } catch {} },
  };
}

/**
 * A minimal ZIP writer for test archives: [name, Buffer|string, { deflate,
 * mode }]; mode is a unix st_mode written into the external attributes.
 */
function makeZip(entries) {
  const zlib = require('zlib');
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, content, opts = {}] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    const nameBuf = Buffer.from(name, 'utf8');
    const body = opts.deflate ? zlib.deflateRawSync(data) : data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(opts.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(opts.mode ? 0x0314 : 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(opts.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(((opts.mode || 0) << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
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

module.exports = { tmpDir, writeJson, CLI, FAKE_ADB, isolatedEnv, useFakeAdb, makeZip };
