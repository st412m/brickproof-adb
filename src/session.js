'use strict';
/**
 * session.js — adb session and diagnostics: devices, connect, pair,
 * disconnect, shell, logcat; the remembered devices (<state_dir>/devices.json).
 *
 * A successful adb_connect to ip:port remembers the address, adb_disconnect
 * with an address forgets it, and the server connects the remembered ones at
 * start. mDNS names and the random ports of Wireless debugging are not
 * remembered: adb itself reconnects paired devices over mDNS.
 */

const fs = require('fs');
const path = require('path');
const { adb, withSerial, sq, text, ADB_TIMEOUT_MS, renameWithRetry } = require('./adb.js');

let ALLOW_SHELL = false;
let SHELL_HINT = 'run `brickproof-adb set allow_shell on` and restart the server';
let STATE_DIR = null;
let SCAN_SUBNETS = [];

function configure({ allowShell = false, shellHint, stateDir = null, scanSubnets = [] } = {}) {
  ALLOW_SHELL = allowShell === true;
  if (shellHint) SHELL_HINT = shellHint;
  STATE_DIR = stateDir;
  SCAN_SUBNETS = scanSubnets.slice();
}

// ------------------------------------------------------- remembered devices

const KNOWN_FILE = 'devices.json';
// Ports from here up are the ephemeral range Wireless debugging draws from.
const EPHEMERAL_PORT = 32768;

/** ip:port to remember for a host given to adb_connect, or null. */
function rememberable(host) {
  const h = String(host || '').trim();
  if (!h || /_adb|\._tcp|\s/.test(h)) return null;
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(h);
  if (!m || m[1].includes(':')) return null;           // IPv6 and anything odd: not remembered
  const port = m[2] ? Number(m[2]) : 5555;
  if (port <= 0 || port >= EPHEMERAL_PORT) return null;
  return `${m[1]}:${port}`;
}

function knownPath() {
  return STATE_DIR ? path.join(STATE_DIR, KNOWN_FILE) : null;
}

/**
 * The remembered devices: [{ address, key }], key the device's snapshot key
 * (<model>_<serialno>, apps.js) or null when the device has no usable serial.
 * [] when there is no file or it cannot be read.
 */
function readEntries() {
  const p = knownPath();
  if (!p) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(j.devices)) return [];
    return j.devices
      .map(d => (typeof d === 'string' ? { address: d, key: null } : d))
      .filter(d => d && typeof d.address === 'string')
      .map(d => ({ address: d.address, key: typeof d.key === 'string' ? d.key : null }));
  } catch { return []; }
}

/** The remembered addresses. */
function readKnown() {
  return readEntries().map(d => d.address);
}

async function writeKnown(entries) {
  const p = knownPath();
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify({ devices: entries, updated: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  await renameWithRetry(tmp, p);
}

/**
 * Remember an address with its device key. A key already remembered under
 * another address (the device got a new address from the router) has that
 * address replaced. Returns { added, replaced: old address or null }.
 */
async function remember(addr, key = null) {
  const entries = readEntries();
  const same = entries.find(e => e.address === addr);
  if (same) {
    if (key && same.key !== key) { same.key = key; await writeKnown(entries); }
    return { added: false, replaced: null };
  }
  const moved = key ? entries.find(e => e.key === key) : null;
  if (moved) {
    const old = moved.address;
    moved.address = addr;
    await writeKnown(entries);
    return { added: false, replaced: old };
  }
  await writeKnown([...entries, { address: addr, key }]);
  return { added: true, replaced: null };
}

async function forget(addr) {
  const entries = readEntries();
  if (!entries.some(e => e.address === addr)) return false;
  await writeKnown(entries.filter(e => e.address !== addr));
  return true;
}

// The device key behind a connected address; null when it cannot be read or
// the device has no usable serial number.
async function keyOf(addr) {
  try {
    const id = await require('./apps.js').deviceIdentity(addr);
    return id.source === 'device' ? id.key : null;
  } catch { return null; }
}

// ------------------------------------------------------------------- tools

async function devices(args = {}) {
  if (args.discover === true || args.discover === 'true') {
    const { discover } = require('./discover.js');
    return text(await discover({ scan: SCAN_SUBNETS }));
  }
  const out = (await adb(['devices', '-l'])).toString();
  const connected = out.split(/\r?\n/).slice(1).map(l => l.trim().split(/\s+/)[0]).filter(Boolean);
  const idle = readKnown().filter(d => !connected.includes(d));
  let extra = idle.length ? `\nRemembered, not connected now: ${idle.join(', ')} (adb_connect reconnects; off or a new address: adb_devices discover=true)` : '';
  if (!connected.length)
    extra += '\nNo device is connected. To find one on the network: adb_devices discover=true. A phone on a USB cable shows up here by itself once USB debugging is allowed on it.';
  return text((await markSameDevice(out.trim()) || 'No devices') + extra);
}

// The longest a device may take to tell its key to adb_devices.
const SAME_DEVICE_TIMEOUT_MS = 3000;

/**
 * One device is often listed under several serials: USB, ip:port, and the
 * mDNS name adb connects a paired phone under by itself. Lines in state
 * `device` whose device key (model and ro.serialno, the snapshot key) was
 * seen on an earlier line get "same device as <that serial>". Keys are read
 * in parallel, each within SAME_DEVICE_TIMEOUT_MS; a device that does not
 * answer, or has no usable serial number, is left unmarked.
 */
async function markSameDevice(listing) {
  const lines = listing.split(/\r?\n/);
  const rows = lines.map((l, i) => ({ i, serial: l.trim().split(/\s+/)[0], state: l.trim().split(/\s+/)[1] }))
    .filter(r => r.i > 0 && r.serial && r.state === 'device');
  if (rows.length < 2) return listing;
  const { deviceIdentity } = require('./apps.js');
  const keyOf = serial => Promise.race([
    deviceIdentity(serial).then(id => (id.source === 'device' ? id.key : null), () => null),
    new Promise(r => setTimeout(() => r(null), SAME_DEVICE_TIMEOUT_MS).unref()),
  ]);
  const keys = await Promise.all(rows.map(r => keyOf(r.serial)));
  const first = new Map();
  rows.forEach((r, n) => {
    const k = keys[n];
    if (!k) return;
    if (first.has(k)) lines[r.i] = `${lines[r.i].trimEnd()}  same device as ${first.get(k)}`;
    else first.set(k, r.serial);
  });
  return lines.join('\n');
}

// The state `adb devices` lists for a serial (device, unauthorized, offline,
// authorizing, connecting), or null when it is not listed.
async function stateOf(serial) {
  const out = (await adb(['devices'], { timeout: 10000 })).toString();
  for (const line of out.split(/\r?\n/).slice(1)) {
    const [s, state] = line.trim().split(/\s+/);
    if (s === serial) return state || null;
  }
  return null;
}

const SETTLING = new Set([null, 'authorizing', 'connecting']);
// How the state after adb connect is watched; replaced in tests.
// `unauthorized` settles too: a device that trusts this computer may say it
// for a moment first, so it counts only when it holds for unauthorizedMs.
const CONNECT_TIMING = { pollMs: 700, settlingPolls: 2, unauthorizedMs: 5000 };

async function connect(args) {
  const host = args.host.includes(':') ? args.host : `${args.host}:5555`;
  const out = (await adb(['connect', host], { timeout: 10000 })).toString().trim();
  // adb reports a failed connect on stdout with exit code 0.
  if (/failed to connect|unable to connect|cannot connect/i.test(out))
    throw new Error(`${out}. Check the device is awake and the port is current (wireless-debug ports change after device reboot).`);
  // "connected to" is printed also when the device has not allowed this
  // computer ("failed to authenticate"): what counts is the state adb lists.
  const t0 = Date.now();
  let state = await stateOf(host).catch(() => null);
  for (let settling = 0; ;) {
    if (state === 'unauthorized') {
      if (Date.now() - t0 >= CONNECT_TIMING.unauthorizedMs) break;
    } else if (!SETTLING.has(state) || settling++ >= CONNECT_TIMING.settlingPolls) {
      break;
    }
    await new Promise(r => setTimeout(r, CONNECT_TIMING.pollMs));
    state = await stateOf(host).catch(() => null);
  }
  if (state === 'unauthorized')
    throw new Error(`${out}\nThe device has not allowed debugging from this computer yet (unauthorized): confirm the debugging prompt on the device's screen (tick "Always allow from this computer"), then call adb_connect again. ` +
      'If the screen is off, wake the device (its remote or power button) so the prompt shows. Not remembered.');
  if (state !== 'device')
    return text(`${out}\nadb lists ${host} as ${state || 'not connected'}, not as a working device: not remembered. Check the device is awake, then call adb_connect again.`);
  const addr = rememberable(host);
  let note = '';
  if (addr) {
    try {
      const r = await remember(addr, await keyOf(addr));
      if (r.replaced) note = `\nThis device was remembered at ${r.replaced}; its new address ${addr} replaces it.`;
      else if (r.added) note = `\nRemembered ${addr}: the server reconnects it when it starts.`;
    } catch (e) { note = `\nNot remembered (${e.message}).`; }
  }
  return text(out + note);
}

async function pair(args) {
  // Wireless debugging (Android 11+): the pairing port is random, there is no
  // default, so ip:port is required.
  if (!String(args.host).includes(':'))
    throw new Error('Pairing requires ip:port — the random port from the "Pair device with pairing code" dialog (not 5555)');
  const out = await adb(['pair', String(args.host), String(args.code)], { timeout: 20000 });
  return text(out.trim());
}

async function disconnect(args) {
  const out = (await adb(args.host ? ['disconnect', args.host] : ['disconnect'], { timeout: 10000 })).toString().trim();
  let note = '';
  if (args.host) {
    const addr = rememberable(args.host);
    if (addr && await forget(addr).catch(() => false)) note = `\nForgotten ${addr}: no longer reconnected at start.`;
  } else {
    const n = readKnown().length;
    if (n) note = `\nThe ${n} remembered address${n === 1 ? ' is' : 'es are'} kept: adb_disconnect with host forgets one.`;
  }
  return text((out || 'Disconnected') + note);
}

async function shell(args) {
  if (!ALLOW_SHELL) throw new Error(`adb_shell is disabled: the server option allow_shell is off. To enable it, ${SHELL_HINT}.`);
  const timeout = args.timeout_sec ? Math.min(args.timeout_sec * 1000, 120000) : ADB_TIMEOUT_MS;
  const out = await adb(withSerial(args.serial, ['shell', args.command]), { timeout });
  return text(out.toString().trim() || '(empty output)');
}

async function logcat(args) {
  const serial = args.serial;
  const lines = Math.min(args.lines || 200, 2000);
  const raw = (args.filter || '').trim();
  let out;

  if (!raw) {
    out = (await adb(withSerial(serial, ['logcat', '-d', '-t', String(lines)]), { timeout: 20000 })).toString();
  } else if (/[:*]/.test(raw)) {
    // filterspec: filter the WHOLE buffer, tail on the device. With -t N
    // logcat cuts the buffer to N raw lines before filtering (empty output).
    // Without *:S unmatched tags are not silenced.
    const spec = raw.split(/\s+/);
    if (!spec.some(x => x.startsWith('*'))) spec.push('*:S');
    const cmd = `logcat -d ${spec.map(sq).join(' ')} 2>/dev/null | tail -n ${lines}`;
    out = (await adb(withSerial(serial, ['shell', cmd]), { timeout: 20000 })).toString();
  } else {
    // substring: case-insensitive grep ON THE DEVICE. Some firmware (Fire OS)
    // ships a BSD grep that matches everything after the binary bytes of the
    // crash buffer, so toybox grep is used when present. The trailing `:`
    // makes zero matches an empty result, not exit 1.
    const cmd = `G="grep"; command -v toybox >/dev/null 2>&1 && toybox grep --help >/dev/null 2>&1 && G="toybox grep"; ` +
      `logcat -d 2>/dev/null | $G -iF -- ${sq(raw)} | tail -n ${lines}; :`;
    out = (await adb(withSerial(serial, ['shell', cmd]), { timeout: 20000 })).toString();
  }
  return text(out.trim().slice(-64000) || '(empty)');
}

// ------------------------------------------------------------- reconnecting

const LOST_RE = /device '[^']*' not found|device offline/i;

/**
 * After a tool failed with "device not found" or "offline" for a remembered
 * address: one reconnect (disconnect first when offline). Returns null when
 * this does not apply, else { ok, addr }.
 */
async function reconnectRemembered(serial, message) {
  const addr = rememberable(serial);
  if (!addr || !LOST_RE.test(String(message || '')) || !readKnown().includes(addr)) return null;
  try {
    if (/offline/i.test(message)) await adb(['disconnect', addr], { timeout: 10000 }).catch(() => {});
    const out = (await adb(['connect', addr], { timeout: 10000 })).toString();
    return { ok: !/failed to connect|unable to connect|cannot connect/i.test(out), addr };
  } catch {
    return { ok: false, addr };
  }
}

module.exports = {
  configure, devices, connect, pair, disconnect, shell, logcat,
  rememberable, readKnown, readEntries, remember, forget, reconnectRemembered, KNOWN_FILE,
  CONNECT_TIMING, markSameDevice,
};
