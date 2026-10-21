'use strict';
/**
 * apps.js — the `adb_app` tool: package operations with guard rails.
 *
 *  1. dry_run defaults to true for everything that changes state.
 *  2. The protected set is derived from the device (device.js) and is a
 *     refusal in code, not a warning in a description. Any overlap means
 *     nothing is applied at all: a partial run is worse than a refusal.
 *  3. An account canary after EVERY batch. Losing the device registration is
 *     a latent failure: the system boots and apps run, and it only shows in
 *     the store.
 *  4. Everything applied goes into a snapshot, so one call rolls it back.
 *  5. `uninstall --user 0` sits behind three locks: the allow_uninstall
 *     setting, an explicit mode in the call and a successful APK backup. A
 *     system package comes back with `cmd package install-existing`; a
 *     sideloaded one only from its backup.
 *  6. A network guard on destructive actions: a package that serves a client
 *     outside the device right now (LISTEN plus an inbound ESTABLISHED from a
 *     non-loopback address) is not disabled, removed, stopped or cleared
 *     without `force_network`.
 *
 * ⚠ The guard has its own flag, apart from `force`. `force` exists to go on
 * after a failed APK backup; one flag for both would lift the guard as a side
 * effect of a decision about backups.
 *
 * Snapshot store layout: <store>/<key>/state.json and <store>/<key>/apk/...,
 * where <key> is the device (`<ro.product.model>_<ro.serialno>`), so one
 * device over USB, ip:5555 and wireless debugging shares one snapshot. A
 * missing, "unknown" or shared serial falls back to the connection serial.
 * Backups recorded since are relative to the device directory; older absolute
 * ones are read as they are, and every one is checked against the store
 * before an install.
 */

const fs = require('fs');
const path = require('path');
const {
  adb, adbSh, withSerial, sq, text, json,
  coerceArray, coerceBool, coerceObject, ensureDir, sanitizeSerial, renameWithRetry,
} = require('./adb.js');
const { checkHostPath } = require('./hostpath.js');
const {
  getProps, listPackages, accountSnapshot, protectedSet,
  netListeners, servingHits, servingRefusal, resumedActivity, splitMarked, markedCommand,
  CORE_PROTECTED, CORE_PREFIXES,
} = require('./device.js');

const DEFAULT_BATCH = 5;

// dry_run when it is not passed, per action: what changes packages or wipes
// data reports first; stop and backup act at once.
const DRY_RUN_DEFAULT = { disable: true, uninstall: true, enable: true, restore: true, clear: true, stop: false, backup: false };
// Actions that only read.
const READ_ONLY_ACTIONS = new Set(['list', 'info', 'protected', 'state']);

/** The dry_run in force for an action: as passed, else its default; null for an action without one. */
function dryRunOf(action, args) {
  const dflt = DRY_RUN_DEFAULT[action];
  return dflt === undefined ? null : coerceBool(args.dry_run, dflt);
}

const DEFAULT_HINTS = {
  allow_shell: 'run `brickproof-adb set allow_shell on` and restart the server',
  allow_uninstall: 'run `brickproof-adb set allow_uninstall on` and restart the server',
};

const OPTS = { allowShell: false, allowUninstall: false, store: null, fileRoots: [], hints: DEFAULT_HINTS };

function configure({ allowShell = false, allowUninstall = false, store = null, fileRoots = [], hints = {} } = {}) {
  OPTS.hints = { ...DEFAULT_HINTS, ...hints };
  OPTS.allowShell = allowShell === true;
  OPTS.allowUninstall = allowUninstall === true;
  OPTS.store = store;
  OPTS.fileRoots = fileRoots.slice();
}

// ------------------------------------------------------------------- store

// ro.serialno values shared by many devices: a key built on one of them could
// send a rollback to another device. Compared in upper case.
const SHARED_SERIALS = new Set([
  'UNKNOWN', 'NULL', '0123456789ABCDEF', '0123456789', '1234567890', '123456789ABCDEF', '1234567890ABCDEF',
  '00000000', '000000000000', '0000000000000000',
]);

function deviceSerialUsable(s) {
  const v = String(s || '').trim();
  return !!v && !SHARED_SERIALS.has(v.toUpperCase());
}

const CONNECTION_NOTE = 'the snapshot is bound to this connection, not to the device: ro.serialno is empty, unknown or shared by many devices, ' +
  'so another connection to the same device (USB, ip:5555, wireless debugging) will not find it';

const IDENTITY_TTL_MS = 5 * 60 * 1000;
const identityCache = new Map(); // connection serial -> { value, ts }

/** The connection serial: as given, else `adb get-serialno` (one device connected). */
async function connectionSerial(serial) {
  if (serial) return String(serial);
  const out = String(await adb(['get-serialno'])).trim();
  if (!out || out === 'unknown')
    throw new Error('adb get-serialno returned no serial - is a device connected? Call adb_devices, then pass serial.');
  return out;
}

/**
 * The snapshot key of the device behind a connection: { key, source:
 * 'device'|'connection', connection, connectionKey, model, serialno }. Cached
 * per connection serial for IDENTITY_TTL_MS.
 */
async function deviceIdentity(serial) {
  const conn = await connectionSerial(serial);
  const cached = identityCache.get(conn);
  if (cached && Date.now() - cached.ts < IDENTITY_TTL_MS) return cached.value;
  const m = splitMarked(await adbSh(serial || conn, markedCommand({
    model: 'getprop ro.product.model',
    serialno: 'getprop ro.serialno',
  })));
  const value = identityFrom(conn, m.model, m.serialno);
  identityCache.set(conn, { value, ts: Date.now() });
  return value;
}

/** Pure: the key from the connection serial and the two properties. */
function identityFrom(conn, model, serialno) {
  const md = String(model || '').trim();
  const sn = String(serialno || '').trim();
  const connectionKey = sanitizeSerial(conn);
  if (deviceSerialUsable(sn))
    return { key: sanitizeSerial(`${md}_${sn}`), source: 'device', connection: conn, connectionKey, model: md, serialno: sn };
  return { key: connectionKey, source: 'connection', connection: conn, connectionKey, model: md, serialno: sn };
}

/**
 * The store root of a call: the `store` setting, or the `store` parameter when
 * it equals the setting or lies inside file_roots (the same check as the file
 * tools).
 */
function storeRoot(args) {
  if (!OPTS.store) throw new Error('the snapshot store is not set (setting store)');
  if (args.store === undefined || args.store === null || args.store === '') return OPTS.store;
  return checkHostPath(String(args.store), { roots: OPTS.fileRoots, exact: [OPTS.store], setting: 'store', what: 'store' });
}

/** Where this call's snapshot lives: { root, id, dir, legacyDir }. */
async function storeContext(args, serial) {
  const root = storeRoot(args);
  const id = await deviceIdentity(serial);
  const dir = path.join(root, id.key);
  const legacy = path.join(root, id.connectionKey);
  return { root, id, dir, legacyDir: id.source === 'device' && legacy !== dir ? legacy : null, readFrom: null };
}

function keyReport(ctx) {
  const r = { key: ctx.id.key, source: ctx.id.source };
  if (ctx.id.source === 'connection') r.note = CONNECTION_NOTE;
  if (ctx.readFrom && ctx.readFrom !== path.join(ctx.dir, 'state.json')) r.read_from = ctx.readFrom;
  return r;
}

function statePath(ctx) {
  return path.join(ctx.dir, 'state.json');
}

// { found: false } | { found: true, state } | { found: true, broken: why }
function readStateFile(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { found: false }; throw e; }
  try {
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object' || !Array.isArray(state.entries)) throw new Error('no list of entries');
    return { found: true, state };
  } catch (e) {
    return { found: true, broken: e.message };
  }
}

class BrokenStateError extends Error {
  constructor(message, moved) {
    super(message);
    this.name = 'BrokenStateError';
    this.moved = moved;
  }
}

/** A name for a damaged state.json that no other file has: state.json.broken-<UTC time>[-n]. */
function brokenName(p, now = new Date()) {
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  let name = `${p}.broken-${stamp}`;
  for (let n = 2; fs.existsSync(name); n++) name = `${p}.broken-${stamp}-${n}`;
  return name;
}

/** The damaged snapshot files kept in a device directory. */
function brokenFiles(dir) {
  try { return fs.readdirSync(dir).filter(n => n.startsWith('state.json.broken-')).sort().map(n => path.join(dir, n)); }
  catch { return []; }
}

/**
 * The snapshot: the device directory, else the connection directory of a 1.x
 * layout (read only; the first write carries its entries over into the
 * device directory and leaves the old one untouched).
 */
function readState(ctx) {
  const empty = () => ({ device: ctx.id.key, key_source: ctx.id.source, updated: null, entries: [] });
  const own = readStateFile(statePath(ctx));
  if (own.found && own.broken) {
    // Moved aside, never overwritten or removed; this call does nothing.
    const p = statePath(ctx);
    const dest = brokenName(p);
    fs.renameSync(p, dest);
    throw new BrokenStateError(`The snapshot file ${p} is damaged (${own.broken}); it was moved to ${dest}. ` +
      'Its rollback entries are not used automatically, and calling again starts an empty snapshot. Nothing was done on the device.', dest);
  }
  if (own.found) {
    ctx.readFrom = statePath(ctx);
    return own.state;
  }
  if (ctx.legacyDir) {
    const p = path.join(ctx.legacyDir, 'state.json');
    const old = readStateFile(p);
    // A damaged file of the old layout is left where it is and not used.
    if (old.found && old.broken) ctx.legacyBroken = p;
    if (old.found && old.state) {
      ctx.readFrom = p;
      return { ...old.state, device: ctx.id.key, key_source: ctx.id.source };
    }
  }
  return empty();
}

/**
 * Write the snapshot through a uniquely named temporary file: a torn write
 * must not leave broken JSON, it is the only source of a rollback. When the
 * rename keeps failing, the error names the temporary file, which still holds
 * the state.
 */
async function writeState(ctx, state, renameOpts) {
  const p = statePath(ctx);
  ensureDir(ctx.dir);
  state.device = ctx.id.key;
  state.key_source = ctx.id.source;
  state.updated = new Date().toISOString();
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  try {
    await renameWithRetry(tmp, p, renameOpts);
  } catch (e) {
    throw new Error(`${p} could not be written (${e.code || e.message}). The snapshot state is kept in ${tmp}: ` +
      'rename it to state.json before the next adb_app call, otherwise action=restore does not see the latest changes.');
  }
  ctx.readFrom = p;
  return p;
}

/** A backup directory as recorded in state.json: relative to the device directory, POSIX separators. */
function backupRef(ctx, absDir) {
  return path.relative(ctx.dir, absDir).split(path.sep).join('/');
}

/**
 * The absolute backup directory of an entry, checked against the store. A
 * relative value is under the device directory; an absolute one (1.x) is
 * taken as it is.
 */
function backupDirOf(ctx, entry) {
  const b = entry.backup;
  if (!b) return null;
  const abs = path.isAbsolute(b) ? b : path.join(ctx.dir, ...String(b).split('/'));
  return checkHostPath(abs, { roots: [ctx.root], setting: 'store', what: `backup of ${entry.package}` });
}

// ------------------------------------------------------------------ helpers

/**
 * Version and ABI of a package. ⚠ No `grep -m2`: `primaryCpuAbi=` and
 * `versionCode=` come first and would cut `versionName=` off. The first
 * versionCode is taken: a "Hidden system packages" block may follow with the
 * OLD version of an updated system package.
 */
async function packageVersion(serial, pkg) {
  const out = await adbSh(serial,
    `dumpsys package ${sq(pkg)} 2>/dev/null | grep -E "versionCode=|versionName=|primaryCpuAbi=" | head -n 20`);
  const code = (out.match(/versionCode=(\d+)/) || [])[1] || '0';
  const abi = (out.match(/primaryCpuAbi=(\S+)/) || [])[1] || '';
  // versionName takes the rest of the line and may contain spaces ("1.0
  // beta"), but some firmware appends other fields after it.
  let name = ((out.match(/versionName=(.*)/) || [])[1] || '').trim();
  if (/\s[A-Za-z_]\w*=/.test(name)) name = name.split(/\s+/)[0];
  return { versionCode: code, versionName: name, primaryCpuAbi: abi };
}

async function packagePaths(serial, pkg) {
  const out = await adbSh(serial, `pm path ${sq(pkg)} 2>/dev/null`);
  return out.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('package:'))
    .map(l => l.slice('package:'.length).trim())
    .filter(Boolean);
}

/**
 * Pull every APK of a package into the store; returns the directory and its
 * manifest. Works for system packages too, but those usually cannot be
 * installed back as user apps (platform signature, shared uid): their
 * rollback is pm enable or cmd package install-existing.
 */
async function backupPackage(serial, pkg, ctx, props) {
  const remote = await packagePaths(serial, pkg);
  if (!remote.length) throw new Error(`pm path returned nothing for ${pkg} - package not installed?`);
  const ver = await packageVersion(serial, pkg);
  const dir = path.join(ctx.dir, 'apk', pkg, ver.versionCode || '0');
  ensureDir(dir);

  const files = [];
  for (const r of remote) {
    const base = path.posix.basename(r);
    const local = path.join(dir, base);
    await adb(withSerial(serial, ['pull', r, local]), { timeout: 180000 });
    const size = fs.existsSync(local) ? fs.statSync(local).size : 0;
    if (!size) throw new Error(`Backup ${pkg}: file ${base} pulled empty`);
    files.push({ name: base, size, device_path: r });
  }

  const manifest = {
    package: pkg,
    versionName: ver.versionName,
    versionCode: ver.versionCode,
    primaryCpuAbi: ver.primaryCpuAbi,
    splits: files.map(f => f.name),
    files,
    device: { serial, model: props.model, sdk: props.sdk, density: props.density, locale: props.locale, abilist: props.abilist },
    pulled_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { dir, manifest };
}

async function installFromBackupDir(serial, dir) {
  const apks = fs.readdirSync(dir).filter(f => f.endsWith('.apk')).map(f => path.join(dir, f));
  if (!apks.length) throw new Error(`No .apk in ${dir}`);
  const verb = apks.length > 1 ? 'install-multiple' : 'install';
  const out = await adb(withSerial(serial, [verb, '-r', '-t', '-g', ...apks]), { timeout: 180000 });
  return out.toString().trim() || `${verb}: ${apks.length} file(s) OK`;
}

// ------------------------------------------------------------------ canary

/** "The system is still whole", between batches, against the baseline taken before the first. */
async function canaryCheck(serial, baseline) {
  const result = { ok: true, problems: [] };

  const acc = await accountSnapshot(serial);
  result.accounts = acc;
  if (baseline.accounts.available && acc.available && acc.count < baseline.accounts.count) {
    result.ok = false;
    result.problems.push(
      `account count went from ${baseline.accounts.count} to ${acc.count} - device registration lost`);
  }

  try {
    const home = await adbSh(serial,
      'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1');
    result.launcher = home.trim();
    if (!result.launcher || /no activity|null/i.test(result.launcher)) {
      result.ok = false;
      result.problems.push('the launcher no longer resolves - the device would be left without a home screen');
    }
  } catch (e) {
    result.ok = false;
    result.problems.push(`launcher could not be checked: ${e.message}`);
  }

  return result;
}

// ------------------------------------------------------------ network guard

/**
 * Refuse when any of the packages serves a client outside the device right
 * now. The signal lives in device.js; here only the decision.
 *
 * A tier of its own, not part of the protected set: the set answers "may this
 * package be lost" (disable/uninstall), the guard "does live work break right
 * now", which applies to force-stop and clear as well.
 *
 * Checked BEFORE the protected set: its refusal names the port and the peer.
 * force_network lifts only the guard; `force` (failed APK backup) never does.
 *
 * When the signal itself could not be read, the guard reports that it is
 * blind: neither a silent pass nor a refusal of everything.
 */
async function networkGuard(serial, packages, what, forceNetwork, netSnapshot) {
  let net = netSnapshot;
  if (!net) {
    try {
      net = await netListeners(serial);
    } catch (e) {
      net = { ok: false, byPackage: {}, byUid: {}, unattributed: [],
        note: `network signal not collected (${e.message}) - the guard did NOT run` };
    }
  }

  const hits = servingHits(net, packages);
  if (hits.length && !forceNetwork) throw new Error(servingRefusal(hits, what));

  return {
    hits,
    overridden: hits,          // non-empty only with force_network: otherwise it threw
    blind: net.ok === false,
    note: net.note || null,
    net,
  };
}

/** The guard in the JSON output. A blind guard must be visible. */
function guardReport(guard) {
  if (guard.blind)
    return { status: 'blind', note: guard.note, checked: false,
      why: 'the signal could not be read from the device - the destructive action runs without the network check' };
  if (guard.overridden.length)
    return { status: 'overridden', checked: true, overridden: guard.overridden, note: guard.note,
      why: 'the network guard was lifted by force_network=true' };
  return { status: 'not_serving', checked: true, note: guard.note };
}

// ------------------------------------------------------------------ actions

async function actList(serial, args) {
  const pkgs = await listPackages(serial);
  const filter = String(args.filter || 'user').toLowerCase();
  const q = args.q ? String(args.q).toLowerCase() : null;

  let list;
  if (filter === 'all') list = pkgs.all;
  else if (filter === 'system') list = pkgs.all.filter(p => pkgs.system.has(p));
  else if (filter === 'disabled') list = pkgs.all.filter(p => pkgs.disabled.has(p));
  else list = pkgs.all.filter(p => !pkgs.system.has(p));

  if (q) list = list.filter(p => p.toLowerCase().includes(q));
  list = list.sort();

  const lines = list.map(p => {
    const flags = [pkgs.system.has(p) ? 'system' : 'user'];
    if (pkgs.disabled.has(p)) flags.push('DISABLED');
    return `${p} [${flags.join(',')}]`;
  });
  return text(
    `filter=${filter}${q ? ` q=${q}` : ''} - ${list.length} of ${pkgs.all.length} packages\n\n` +
    (lines.join('\n') || '(none)'));
}

async function actInfo(serial, args) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error('action=info requires packages');
  const pkgs = await listPackages(serial);
  const out = [];
  for (const p of packages) {
    if (!pkgs.all.includes(p)) { out.push({ package: p, installed: false }); continue; }
    const ver = await packageVersion(serial, p);
    out.push({
      package: p,
      installed: true,
      system: pkgs.system.has(p),
      disabled: pkgs.disabled.has(p),
      ...ver,
      paths: await packagePaths(serial, p),
    });
  }
  return json(out);
}

// An am/intent token: the same limit as extras keys and the action, so no
// arbitrary `am` flags come in through a call.
const AM_TOKEN_RE = /^[A-Za-z0-9_.]+$/;

// A disabled shell must not come back as the ability to dial through an
// intent. Whether such an intent would place a call is not tested on hardware
// (the test would be a real call); the refusal stands regardless. With
// allow_shell on there is no refusal: adb_shell can dial anyway.
const CALL_ACTIONS = new Set([
  'android.intent.action.CALL',
  'android.intent.action.CALL_PRIVILEGED',
  'android.intent.action.CALL_EMERGENCY',
]);

/**
 * extras → `am start` flags: string → --es, boolean → --ez, int32 integer →
 * --ei, larger integer → --el, anything else refused by key name. A JSON
 * string of an object is accepted (coerceObject).
 */
function extrasToAmFlags(extras) {
  const obj = coerceObject(extras);
  const flags = [];
  for (const [k, v] of Object.entries(obj)) {
    if (!AM_TOKEN_RE.test(k)) throw new Error(`extras.${k}: key name must match [A-Za-z0-9_.]+`);
    if (typeof v === 'boolean') flags.push('--ez', sq(k), sq(String(v)));
    else if (typeof v === 'string') flags.push('--es', sq(k), sq(v));
    else if (typeof v === 'number' && Number.isInteger(v)) {
      const isInt32 = v >= -2147483648 && v <= 2147483647;
      flags.push(isInt32 ? '--ei' : '--el', sq(k), sq(String(v)));
    } else {
      throw new Error(`extras.${k}: unsupported value type (${typeof v}) - allowed: string, boolean, integer`);
    }
  }
  return flags;
}

/**
 * The output of `am start -W` for an intent launch.
 *
 * ⚠ The -W format differs between SDK 28 and 36 (LaunchState/WaitTime/
 * TotalTime come and go), so it is read line by line by prefix, never with
 * one regex over the whole output. /Error|Exception/i over the whole text
 * would fire on a URI containing "error" in the echo line, and "Warning: ...
 * delivered to currently running top-most instance" contains "Activity not
 * started" while being a success. The echo line `Starting: Intent { ... }` is
 * not read at all: it holds the URI and extras as given.
 */
async function parseAmStartOutput(serial, out, ctx) {
  const lines = String(out || '').split('\n').map(l => l.trim()).filter(Boolean);
  const nonEcho = lines.filter(l => !/^Starting:\s*Intent\s*\{/.test(l));
  const rawOut = String(out || '').trim();

  // 1. No handler.
  if (nonEcho.some(l => /^Error:\s*Activity not started, unable to resolve Intent/.test(l)))
    throw new Error(`No handler for this intent (action=${ctx.action}).\n${rawOut}`);

  // 2. Delivered to the running instance: a success, checked BEFORE the
  //    general errors because it says "Activity not started".
  const delivered = nonEcho.find(l =>
    /^Warning:\s*Activity not started, intent has been delivered to currently running top-most instance/.test(l));
  if (delivered)
    return text(`Delivered to the already running instance (${ctx.pkg || ctx.action}).\n${delivered}`);

  // 3. A chooser dialog: the tool opened it, the tool closes it with ONE
  //    KEYCODE_BACK and reads the resumed activity again. Still on top: say
  //    so and send no more keys.
  const activityLine = nonEcho.find(l => /^Activity:\s*/.test(l));
  if (activityLine && /ResolverActivity|ChooserActivity/.test(activityLine)) {
    await adb(withSerial(serial, ['shell', 'input keyevent KEYCODE_BACK']));
    await new Promise(r => setTimeout(r, 500));
    const after = await resumedActivity(serial);
    if (after.raw && /ResolverActivity|ChooserActivity/.test(after.raw))
      return text(`Several handlers; the chooser dialog is still on top: ${after.raw}`);
    return text(`Several handlers; the chooser dialog was closed - pass packages.\n${activityLine}`);
  }

  // 4. Other errors: a line starting with `Error:` or containing "Exception"
  //    (a substring, not \bException\b: java.lang.SecurityException has no
  //    word boundary before "Exception"). Lines starting with `Starting:` or
  //    `Activity:` are skipped: a component such as pkg/.ExceptionHandlerActivity
  //    is a name, not a diagnosis.
  const errPool = nonEcho.filter(l => !/^Starting:/.test(l) && !/^Activity:/.test(l));
  const errLine = errPool.find(l => /^Error:/.test(l) || l.includes('Exception'));
  if (errLine) throw new Error(`am start refused: ${errLine}\n${rawOut}`);

  // 5. Status: ok, or no Status line: confirm by the resumed activity.
  await new Promise(r => setTimeout(r, 1200));
  const after = await resumedActivity(serial);
  const okByResumed = ctx.pkg ? !!(after.raw && after.raw.includes(ctx.pkg)) : !!after.component;

  const head = `intent (action=${ctx.action}${ctx.pkg ? `, -p ${ctx.pkg}` : ''})`;
  if (okByResumed)
    return text(`Launched via ${head}.\n${rawOut ? rawOut + '\n' : ''}Confirmed in the foreground: ${after.raw}`);

  return text(
    `⚠ ${head} was sent without error, but the package is not in the foreground.\n` +
    `On top now: ${after.raw || '(not determined - neither ResumedActivity nor mCurrentFocus)'}\n${rawOut}`);
}

/**
 * Intent / deep-link launch, chosen by the presence of uri or intent_action.
 * packages is optional: one value goes to `-p` (narrows the resolver and
 * avoids the chooser); more than one is a refusal.
 */
async function actLaunchIntent(serial, args, packages) {
  if (packages.length > 1)
    throw new Error(`action=launch with uri/intent_action accepts at most one package (used as -p), got: ${packages.join(', ')}`);
  const pkg = packages[0] || null;

  const action = String(args.intent_action || 'android.intent.action.VIEW');
  if (!AM_TOKEN_RE.test(action))
    throw new Error(`intent_action \"${action}\" does not match [A-Za-z0-9_.]+`);

  if (CALL_ACTIONS.has(action) && !OPTS.allowShell)
    throw new Error(
      `intent_action=${action} refused: the server option allow_shell is off. ` +
      `If this is intended, ${OPTS.hints.allow_shell}, then use adb_shell.`);

  const extraFlags = extrasToAmFlags(args.extras);

  const parts = ['am', 'start', '-W', '-a', sq(action)];
  if (args.uri) parts.push('-d', sq(String(args.uri)));
  if (pkg) parts.push('-p', sq(pkg));
  parts.push(...extraFlags);
  const cmd = `${parts.join(' ')} 2>&1`;

  let out = '';
  try {
    out = await adbSh(serial, cmd, { timeout: 20000 });
  } catch (e) {
    // A -W timeout is not a failed launch: report it and check the resumed
    // activity. Other failures (device gone) are passed on.
    if (!/timeout|killed/i.test(e.message)) throw e;
    out = 'am -W did not answer in time (call timeout) - checking what started against the resumed activity.';
  }

  return parseAmStartOutput(serial, out, { pkg, action });
}

async function actLaunch(serial, args) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);

  if (args.uri || args.intent_action) return actLaunchIntent(serial, args, packages);

  const pkg = packages[0];
  if (!pkg) throw new Error('action=launch requires packages');
  // Launching a package by name:
  //  · monkey with the LAUNCHER category refuses silently (rc != 0, no
  //    events); the only sign of a real launch is "Events injected".
  //  · TV apps declare MAIN with LEANBACK_LAUNCHER, not LAUNCHER.
  //  · Some activities resolve only for MAIN without any category.
  //  · ⚠ `resolve-activity -a MAIN` can return the system chooser
  //    (android/com.android.internal.app.ResolverActivity), which fits the
  //    package/activity shape: the activity must BELONG to the package, or
  //    the tool starts the wrong thing and reports success.
  const CATS = ['android.intent.category.LAUNCHER', 'android.intent.category.LEANBACK_LAUNCHER'];
  const tried = [];

  for (const cat of CATS) {
    const out = await adbSh(serial, `monkey -p ${sq(pkg)} -c ${cat} 1 2>&1 | tail -n 3`);
    if (/Events injected:\s*[1-9]/.test(out))
      return text(`Launched ${pkg} (monkey, ${cat.split('.').pop()})\n${out.trim()}`);
    tried.push(`monkey ${cat.split('.').pop()}: no events injected`);
  }

  // Fallback: ask the system for the main activity and start it explicitly.
  let act = '';
  for (const q of [`-a android.intent.action.MAIN -c ${CATS[0]}`,
                   `-a android.intent.action.MAIN -c ${CATS[1]}`,
                   '-a android.intent.action.MAIN']) {
    const r = (await adbSh(serial,
      `cmd package resolve-activity --brief ${q} ${sq(pkg)} 2>/dev/null | tail -n 1`)).trim();
    if (!/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(r)) { tried.push(`resolve ${q}: ${r || 'empty'}`); continue; }
    if (r.split('/')[0] !== pkg) {
      // ResolverActivity and other foreign activities are not this package.
      tried.push(`resolve ${q}: ${r} - activity of another package, discarded`);
      continue;
    }
    act = r;
    break;
  }

  if (!act)
    throw new Error(
      `Cannot launch ${pkg}: the main activity does not resolve.\n` +
      tried.map(t => `  · ${t}`).join('\n') +
      `\nTry \`adb_shell cmd package query-activities -a android.intent.action.MAIN\`; ` +
      `the package may have no launchable activity at all (service, provider, overlay).`);

  const started = await adbSh(serial, `am start -n ${sq(act)} 2>&1`);
  if (/Error|Exception/i.test(started))
    throw new Error(`Cannot launch ${pkg} via ${act}: ${started.trim()}`);

  // Neither monkey nor am is taken at its word: the resumed activity is
  // checked (mCurrentFocus alone is null on some devices even with the
  // launcher up, so it is only the second opinion).
  await new Promise(r => setTimeout(r, 1200));
  const { raw: seen, resumedLine: resumed, focusLine: focus } = await resumedActivity(serial);

  if (resumed.includes(pkg) || focus.includes(pkg))
    return text(
      `Launched ${pkg} via ${act} (monkey did not inject: ${tried[0]}).\n` +
      `Package confirmed in the foreground.`);

  // Started without error but not on top: usually the activity closed itself
  // (a setup wizard checking its condition), less often it needs more time.
  return text(
    `⚠ ${pkg}: activity ${act} started without error, but it is not in the foreground.\n` +
    `On top now: ${seen || '(not determined - neither ResumedActivity nor mCurrentFocus)'}\n` +
    `The usual cause is that the activity closed itself (setup wizard, placeholder screen); ` +
    `less often it needed more time. Take adb_screenshot if this matters.`);
}

async function actStopOrClear(serial, args, action) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error(`action=${action} requires packages`);
  const dryRun = dryRunOf(action, args);  // clear wipes data: dry_run by default
  const forceNetwork = coerceBool(args.force_network, false);

  // The network guard covers stop and clear too: the protected set is checked
  // only for disable/uninstall, and a force-stop of the package that holds an
  // integration's channel cuts it just the same, until the service restarts.
  // `pm clear` also wipes the data (a remote's pairing). ⚠ stop defaults to
  // dry_run=false.
  const guard = await networkGuard(serial, packages, action === 'stop' ? 'force-stop' : 'clear', forceNetwork);

  if (dryRun) {
    return text(`dry_run: ${action} for ${packages.length} package${packages.length === 1 ? '' : 's'}:\n` +
      packages.map(p => `  ${p}`).join('\n') +
      (guard.overridden.length
        ? `\n\n⚠ force_network=true overrides the network guard for: ` +
          guard.overridden.map(h => `${h.package} (${h.serving.join(', ')})`).join('; ')
        : '') +
      (guard.blind ? `\n\n⚠ ${guard.note}` : '') +
      `\n\nRepeat with dry_run=false to apply.`);
  }

  const done = [];
  if (guard.overridden.length)
    done.push(`⚠ force_network=true: the network guard is overridden for ` +
      guard.overridden.map(h => `${h.package} (${h.serving.join(', ')})`).join('; '));
  if (guard.blind) done.push(`⚠ ${guard.note}`);

  for (const p of packages) {
    const cmd = action === 'stop' ? `am force-stop ${sq(p)}` : `pm clear ${sq(p)}`;
    const out = await adbSh(serial, `${cmd} 2>&1`);
    done.push(`${p}: ${out.trim() || 'ok'}`);
  }
  return text(done.join('\n'));
}

/**
 * Where a package in the protected set comes from, by the keys of `sources`
 * (protectedSet in device.js): a string is the package itself, an array holds
 * it, an object has it as a key; roles gets the role names from roles_detail.
 * The core of the set (CORE_PROTECTED / CORE_PREFIXES) is in no source key
 * and is marked `core` and `core (<prefix>*)`.
 */
function protectedSourcesOf(pkg, sources) {
  const src = sources || {};
  const found = [];
  for (const [key, val] of Object.entries(src)) {
    if (key === 'roles_detail') continue;
    let hit = false;
    if (typeof val === 'string') hit = val === pkg;
    else if (Array.isArray(val)) hit = val.includes(pkg);
    else if (val && typeof val === 'object') hit = Object.prototype.hasOwnProperty.call(val, pkg);
    if (!hit) continue;
    if (key === 'roles') {
      const names = Object.entries(src.roles_detail || {})
        .filter(([, holders]) => Array.isArray(holders) && holders.includes(pkg))
        .map(([role]) => role);
      found.push(names.length ? `roles (${names.join(', ')})` : 'roles');
    } else {
      found.push(key);
    }
  }
  if (CORE_PROTECTED.includes(pkg)) found.push('core');
  for (const pref of CORE_PREFIXES) {
    if (pkg.startsWith(pref)) found.push(`core (${pref}*)`);
  }
  return found;
}

/**
 * The protected-set refusal. ⚠ The first and the last lines are fixed: the
 * documentation and the agent's habits rely on them. Between them one line
 * per refused package with ITS sources only.
 */
function formatProtectedRefusal(hit, sources) {
  return (
    `REFUSED: the list contains protected packages - ${hit.join(', ')}.\n` +
    hit.map(p => {
      const from = protectedSourcesOf(p, sources);
      return `  ${p} — ${from.length ? from.join(', ') : 'source not recorded'}`;
    }).join('\n') + '\n' +
    'The full set with every source: adb_app action=protected\n' +
    'Nothing was applied. Remove them from the list by hand; the tool has no override.');
}

/** disable / uninstall — the one truly dangerous action. */
async function actRemove(serial, args) {
  const packages = coerceArray(args.packages || args.package).filter(Boolean);
  if (!packages.length) throw new Error('action requires packages');

  const mode = String(args.mode || 'disable').toLowerCase();
  if (!['disable', 'uninstall'].includes(mode))
    throw new Error(`mode must be disable or uninstall, got: ${mode}`);
  if (mode === 'uninstall' && !OPTS.allowUninstall)
    throw new Error(
      'mode=uninstall is refused: the server option allow_uninstall is off. ' +
      `If removal is really needed rather than reversible disabling (mode=disable), ${OPTS.hints.allow_uninstall}.`);

  const dryRun = dryRunOf('disable', args);
  const doCanary = coerceBool(args.canary, true);
  const doBackup = coerceBool(args.backup, mode === 'uninstall');
  const force = coerceBool(args.force, false);               // only about a failed APK backup
  const forceNetwork = coerceBool(args.force_network, false); // only about the network guard
  const batchSize = Math.max(1, Math.min(parseInt(args.batch_size, 10) || DEFAULT_BATCH, 25));

  const props = await getProps(serial);
  const pkgs = await listPackages(serial);
  const prot = await protectedSet(serial, { props, packages: pkgs });

  const unknown = packages.filter(p => !pkgs.all.includes(p));
  if (unknown.length)
    throw new Error(`Not installed on the device: ${unknown.join(', ')}`);

  // The network guard BEFORE the protected set: its refusal names the port and
  // the live client. The /proc/net snapshot comes from protectedSet.
  const guard = await networkGuard(serial, packages, mode, forceNetwork, prot.net);

  const hit = packages.filter(p => prot.packages.includes(p));
  if (hit.length) throw new Error(formatProtectedRefusal(hit, prot.sources));

  // Advisories for USER packages with external-connectivity signals: not a
  // refusal (the APK backup makes them reversible), but not silence either:
  // the consequence shows only outside the device, where the canary does not
  // look.
  const advisories = (prot.advisories || []).filter(a => packages.includes(a.package));

  const plan = packages.map(p => ({
    package: p,
    system: pkgs.system.has(p),
    already_disabled: pkgs.disabled.has(p),
    action: mode,
    warnings: advisories.filter(a => a.package === p).map(a => `${a.signal}: ${a.detail}`),
    backup: doBackup && !pkgs.system.has(p) ? 'yes (user package)'
      : doBackup ? 'yes (system package - the APK is saved, but it is restored via install-existing)' : 'no',
    rollback: mode === 'disable' ? 'pm enable'
      : pkgs.system.has(p) ? 'cmd package install-existing' : 'install from the APK backup',
  }));

  const baseline = { accounts: await accountSnapshot(serial) };
  const ctx = await storeContext(args, serial);

  if (dryRun) {
    return json({
      dry_run: true,
      mode,
      batch_size: batchSize,
      canary: doCanary,
      store: ctx.dir,
      snapshot_key: keyReport(ctx),
      baseline_accounts: baseline.accounts,
      protected_count: prot.packages.length,
      protected_sources: prot.sources,
      protected_notes: prot.notes,
      network_guard: guardReport(guard),
      advisories,
      plan,
      hint: advisories.length
        ? 'Advisories present - read them before continuing. Repeat with dry_run=false. Rollback: adb_app action=restore.'
        : 'Repeat with dry_run=false. Rollback: adb_app action=restore.',
    });
  }

  if (mode === 'uninstall' && !doBackup && !force)
    throw new Error('mode=uninstall with backup=false requires force=true - otherwise rollback is not possible for every package');

  const state = readState(ctx);
  const report = { mode, applied: [], failed: [], stopped: false, canary: [] };
  report.snapshot_key = keyReport(ctx);
  report.network_guard = guardReport(guard);
  if (advisories.length) report.advisories = advisories;

  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);
    const batchApplied = [];

    const changes = [];
    for (const p of batch) {
      let backupDir = null;
      if (doBackup) {
        try {
          backupDir = (await backupPackage(serial, p, ctx, props)).dir;
        } catch (e) {
          if (!force) {
            report.failed.push({ package: p, error: `backup failed (${e.message}) - stopping; repeat with force=true if this is intended` });
            continue;
          }
        }
      }
      const cmd = mode === 'disable'
        ? `pm disable-user --user 0 ${sq(p)} 2>&1`
        : `pm uninstall --user 0 ${sq(p)} 2>&1`;
      changes.push({ package: p, change: mode, backupDir, run: () => adbSh(serial, cmd) });
    }

    for (const r of await applyVerified(serial, changes)) {
      if (!r.ok) { report.failed.push({ package: r.package, error: r.error }); continue; }
      const entry = {
        package: r.package, mode, system: pkgs.system.has(r.package), backup: r.backupDir ? backupRef(ctx, r.backupDir) : null,
        ts: new Date().toISOString(), result: r.out,
      };
      if (r.warning) entry.warning = r.warning;
      state.entries = state.entries.filter(e => e.package !== r.package);
      state.entries.push(entry);
      batchApplied.push(entry);
      report.applied.push(entry);
    }

    await writeState(ctx, state);

    if (doCanary) {
      const c = await canaryCheck(serial, baseline);
      report.canary.push({ after_batch: Math.floor(i / batchSize) + 1, ...c });
      if (!c.ok) {
        // Roll back THIS batch only, and stop.
        const rolledBack = [];
        for (const r of await applyVerified(serial, batchApplied.map(e => restoreChange(serial, e, ctx)))) {
          if (r.ok) {
            state.entries = state.entries.filter(x => x.package !== r.package);
            rolledBack.push(r.package);
          } else {
            report.failed.push({ package: r.package, error: `rollback failed: ${r.error}` });
          }
        }
        await writeState(ctx, state);
        report.stopped = true;
        report.rolled_back = rolledBack;
        report.reason = c.problems.join('; ');
        break;
      }
    }
  }

  report.state_file = statePath(ctx);
  report.next = 'Check the device by eye: home screen, store, account sign-in. ' +
    'Check again after a reboot - some failures only show up on the next boot.';
  return json(report);
}

// The rollback of a snapshot entry as a change for applyVerified().
function restoreChange(serial, entry, ctx) {
  if (entry.mode === 'disable')
    return { package: entry.package, change: 'enable', run: () => adbSh(serial, `pm enable ${sq(entry.package)} 2>&1`) };
  if (entry.system)
    return { package: entry.package, change: 'install', run: () => adbSh(serial, `cmd package install-existing --user 0 ${sq(entry.package)} 2>&1`) };
  return {
    package: entry.package, change: 'install', run: async () => {
      if (!entry.backup) throw new Error(`no APK backup for ${entry.package} - nothing to restore from`);
      return installFromBackupDir(serial, backupDirOf(ctx, entry));
    },
  };
}

// The text pm prints is not the result on every firmware: some firmware
// answers `pm disable-user` with a warning and applies it only sometimes. So
// a package change counts by the package list read after it, once per batch.
const TOOK_EFFECT = {
  disable: (pkgs, p) => pkgs.all.includes(p) && pkgs.disabled.has(p),
  uninstall: (pkgs, p) => !pkgs.all.includes(p),
  enable: (pkgs, p) => pkgs.all.includes(p) && !pkgs.disabled.has(p),
  install: (pkgs, p) => pkgs.all.includes(p),
};
const NOT_DONE = {
  disable: 'not disabled: the device still lists it as enabled',
  uninstall: 'not removed: the device still lists it as installed',
  enable: 'not enabled: the device does not list it as an enabled package',
  install: 'not restored: the device does not list it as installed',
};
const SUSPECT_OUTPUT = /illegal|warning|failure|exception|error/i;

/**
 * Run each change ({ package, change, run() → device output, ...extra }) in
 * order, then read the package list once and judge every change by it.
 * Returns the changes with { ok, out, error?, warning? }. When the list cannot
 * be read, the device output decides, and an applied change says it was not
 * verified.
 */
async function applyVerified(serial, changes) {
  if (!changes.length) return [];
  const runs = [];
  for (const { run, ...c } of changes) {
    try { runs.push({ ...c, out: String(await run()).trim(), runError: null }); }
    catch (e) { runs.push({ ...c, out: '', runError: e.message }); }
  }
  let pkgs = null, listError = null;
  try { pkgs = await listPackages(serial); } catch (e) { listError = e.message; }
  return runs.map(({ runError, ...r }) => {
    const said = runError || r.out;
    if (!pkgs) {
      if (runError || /Failure|Exception|Error/i.test(r.out)) return { ...r, ok: false, error: said };
      return { ...r, ok: true, warning: `not verified: the package list could not be read afterwards (${listError})` };
    }
    if (TOOK_EFFECT[r.change](pkgs, r.package)) {
      const odd = runError || (SUSPECT_OUTPUT.test(r.out) ? r.out : '');
      return odd ? { ...r, ok: true, warning: `the device answered "${odd}", but the change took effect` } : { ...r, ok: true };
    }
    return { ...r, ok: false, error: `${NOT_DONE[r.change]}${said ? `; device output: ${said}` : ''}` };
  });
}

function describeBackup(ctx, e) {
  try { return backupDirOf(ctx, e) || '(no backup)'; } catch (err) { return `${e.backup} (refused: ${err.message})`; }
}

async function actEnableOrRestore(serial, args, action) {
  const ctx = await storeContext(args, serial);
  const state = readState(ctx);
  const asked = coerceArray(args.packages || args.package).filter(Boolean);
  const dryRun = dryRunOf(action, args);

  let targets;
  if (action === 'enable' && asked.length) {
    // a direct enable, even for a package that is not in the snapshot
    targets = asked.map(p => {
      const known = state.entries.find(e => e.package === p);
      return known || { package: p, mode: 'disable', system: true, backup: null };
    });
  } else {
    targets = asked.length ? state.entries.filter(e => asked.includes(e.package)) : state.entries.slice();
    if (asked.length) {
      const missing = asked.filter(p => !state.entries.some(e => e.package === p));
      if (missing.length) throw new Error(`Not in the snapshot: ${missing.join(', ')}. Use action=enable for a direct enable.`);
    }
  }

  if (!targets.length)
    return text('The snapshot is empty - nothing to restore.' + (ctx.id.source === 'connection' ? `\nNote: ${CONNECTION_NOTE}.` : ''));

  if (dryRun) {
    return json({
      dry_run: true,
      state_file: ctx.readFrom || statePath(ctx),
      snapshot_key: keyReport(ctx),
      plan: targets.map(e => ({
        package: e.package,
        was: e.mode,
        how: e.mode === 'disable' ? 'pm enable'
          : e.system ? 'cmd package install-existing' : `install from ${describeBackup(ctx, e)}`,
      })),
      hint: 'Repeat with dry_run=false.',
    });
  }

  const done = [], failed = [];
  for (const r of await applyVerified(serial, targets.map(e => restoreChange(serial, e, ctx)))) {
    if (!r.ok) { failed.push({ package: r.package, error: r.error }); continue; }
    state.entries = state.entries.filter(x => x.package !== r.package);
    done.push({ package: r.package, result: r.out, ...(r.warning ? { warning: r.warning } : {}) });
  }
  await writeState(ctx, state);
  return json({ restored: done, failed, state_file: statePath(ctx), snapshot_key: keyReport(ctx) });
}

async function actBackup(serial, args) {
  const pkgs = await listPackages(serial);
  let packages = coerceArray(args.packages || args.package).filter(Boolean);
  const scope = String(args.scope || (packages.length ? 'list' : 'user')).toLowerCase();

  if (!packages.length) {
    if (scope === 'user') packages = pkgs.all.filter(p => !pkgs.system.has(p));
    else if (scope === 'all') packages = pkgs.all.slice();
    else throw new Error('action=backup requires packages or scope=user|all');
  }

  const ctx = await storeContext(args, serial);
  const dryRun = dryRunOf('backup', args);
  if (dryRun) {
    return text(`dry_run: ${packages.length} package${packages.length === 1 ? '' : 's'} will be saved to ` +
      `${path.join(ctx.dir, 'apk')}:\n` + packages.map(p => `  ${p}`).join('\n') +
      (ctx.id.source === 'connection' ? `\nNote: ${CONNECTION_NOTE}.` : ''));
  }

  const props = await getProps(serial);
  const saved = [], failed = [];
  for (const p of packages) {
    try {
      const r = await backupPackage(serial, p, ctx, props);
      saved.push({ package: p, dir: r.dir, splits: r.manifest.splits, version: r.manifest.versionName });
    } catch (e) {
      failed.push({ package: p, error: e.message });
    }
  }
  return json({ saved_count: saved.length, saved, failed, store: ctx.dir, snapshot_key: keyReport(ctx) });
}

function listBackups(dir) {
  try {
    const apkRoot = path.join(dir, 'apk');
    return fs.readdirSync(apkRoot).map(pkg => ({ package: pkg, versions: fs.readdirSync(path.join(apkRoot, pkg)) }));
  } catch { return []; }   // no backups yet
}

async function actState(serial, args) {
  const ctx = await storeContext(args, serial);
  let state, damaged = null;
  try {
    state = readState(ctx);
  } catch (e) {
    if (e.name !== 'BrokenStateError') throw e;
    state = null;
    damaged = e.message;
  }
  const out = {
    store: ctx.dir,
    snapshot_key: { ...keyReport(ctx), connection: ctx.id.connection },
    state_file: ctx.readFrom || statePath(ctx),
    state,
    backups: listBackups(ctx.dir),
  };
  if (damaged) out.damaged = damaged;
  const broken = brokenFiles(ctx.dir);
  if (broken.length)
    out.broken_files = { files: broken, note: 'damaged snapshot files moved aside; never used, overwritten or removed by the server. Read them by hand if a rollback is needed.' };
  if (ctx.legacyBroken)
    out.legacy_broken = { file: ctx.legacyBroken, note: 'a damaged snapshot file of the older layout; left where it is and not used' };
  if (ctx.legacyDir && ctx.readFrom === path.join(ctx.legacyDir, 'state.json')) {
    out.legacy_backups = listBackups(ctx.legacyDir);
    out.legacy_note = `read from the connection directory of an older layout; the next change writes these entries to ${statePath(ctx)} and leaves the old directory as it is`;
  }
  const def = path.join(ctx.root, 'default');
  if (ctx.dir !== def && fs.existsSync(def)) {
    out.default_dir = { path: def,
      note: 'a snapshot directory of ha-adb-mcp 1.x for calls made without serial; it can belong to any device and is not read. Restore from it by hand if it is this device\'s.' };
  }
  return json(out);
}

// --------------------------------------------------------------- entry point

async function adbApp(args) {
  const serial = args.serial;
  const action = String(args.action || '').toLowerCase();

  switch (action) {
    case 'list':      return actList(serial, args);
    case 'info':      return actInfo(serial, args);
    case 'launch':    return actLaunch(serial, args);
    case 'stop':      return actStopOrClear(serial, args, 'stop');
    case 'clear':     return actStopOrClear(serial, args, 'clear');
    case 'disable':   return actRemove(serial, { ...args, mode: args.mode || 'disable' });
    case 'uninstall': return actRemove(serial, { ...args, mode: 'uninstall' });
    case 'enable':    return actEnableOrRestore(serial, args, 'enable');
    case 'restore':   return actEnableOrRestore(serial, args, 'restore');
    case 'backup':    return actBackup(serial, args);
    case 'state':     return actState(serial, args);
    case 'protected': {
      const props = await getProps(serial);
      // net is the guard's raw snapshot; sources already show the same.
      const { net, ...prot } = await protectedSet(serial, { props });
      void net;
      return json({ device: props, ...prot });
    }
    default:
      throw new Error(`Unknown action: ${action || '(empty)'}. ` +
        `Allowed: list, info, protected, launch, stop, clear, disable, uninstall, enable, restore, backup, state`);
  }
}

module.exports = {
  configure, adbApp, dryRunOf, READ_ONLY_ACTIONS,
  parseAmStartOutput, extrasToAmFlags, CALL_ACTIONS, AM_TOKEN_RE,
  protectedSourcesOf, formatProtectedRefusal,
  // snapshot store
  SHARED_SERIALS, deviceSerialUsable, identityFrom, deviceIdentity, storeRoot, storeContext,
  readState, writeState, renameWithRetry, backupRef, backupDirOf, keyReport, CONNECTION_NOTE, brokenFiles, brokenName,
  applyVerified,
  _identityCache: identityCache,
};
