'use strict';
/**
 * device.js — facts read off the device itself.
 *
 * The protected set is derived from the device, never kept as a list of
 * package names: a list protects only the devices it was written against,
 * while a query finds an account stack it has never heard of.
 *
 * Sources differ between firmwares, so each one is probed on its own. A probe
 * that fails must leave a line in notes: a failed source must not look like an
 * absent one. "No role service on this platform" and "the role query failed"
 * are different lines.
 *
 * Probes in use, and why each has its form:
 * - roles: `dumpsys role` (`cmd role` has no getter on SDK 30/31);
 * - installer: resolve-activity with a content:// URI (SDK 29+), file:// as
 *   the fallback; every derived value must look like a package name;
 * - locale: marker-split output, so an empty value stays empty (Fire OS 7 has
 *   an empty ro.product.locale);
 * - density: `wm density` physical and override read separately, the override
 *   wins when set.
 */

const { adbSh } = require('./adb.js');

// The core of the set. Small and conservative on purpose: everything else is
// read off the device.
const CORE_PROTECTED = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.shell',
  'com.android.keychain',
  'com.android.packageinstaller',
  'com.google.android.packageinstaller',
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  // The unicode input channel of this server: disabling it breaks adb_text.
  'com.android.adbkeyboard',
];

const CORE_PREFIXES = [
  'com.android.providers.',   // settings, media, downloads, telephony...
  'com.android.inputmethod.',
];

/**
 * Name heuristics — only in addition to what is derived, never instead.
 * Narrow on purpose: a bare 'sso' matches `pacprocessor` (proce-sso-r).
 */
const ACCOUNT_HINTS = [
  /(^|\.)dcp(\.|$)/i,        // com.amazon.dcp, com.amazon.dcp.contracts.*
  /identity\.auth/i,         // com.amazon.identity.auth.device.authorization
  /ottsso/i,                 // com.amazon.tv.ottssocompanionapp
  /ssocompanion/i,
  /accountmanager/i,
  /(^|\.)accounts?(\.|$)/i,
  /\bgsf\b|android\.gms$/i,  // the Google stack
];

// An Android package name: letters, digits, underscores, at least one dot, no
// spaces. Keeps "No activity found", "Unknown command: ..." and other error
// text out of the set.
const PKG_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

// Looks like BCP-47: ru, en-US, sr-Latn-RS, es-419.
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?$/;

const MARK = '@@';

function looksLikePackage(s) {
  const v = String(s || '').trim();
  return !!v && v !== 'null' && v.length <= 255 && PKG_RE.test(v);
}

function pkgOf(component) {
  const s = String(component || '').trim();
  if (!s || s === 'null') return null;
  return s.split('/')[0].trim() || null;
}

/**
 * Split output marked with lines @@key@@. A split with one capture group gives
 * [preamble, key, value, key, ...], so an empty value is unambiguous, which a
 * single regex over the whole output is not.
 */
function splitMarked(out) {
  const parts = String(out).split(new RegExp(`^${MARK}([a-z0-9_]+)${MARK}[ \\t]*\\r?$`, 'm'));
  const map = {};
  for (let i = 1; i < parts.length; i += 2) {
    map[parts[i]] = String(parts[i + 1] === undefined ? '' : parts[i + 1]).trim();
  }
  return map;
}

function markedCommand(queries) {
  return Object.entries(queries)
    .map(([k, c]) => `echo "${MARK}${k}${MARK}"; ${c} 2>/dev/null`)
    .join('; ') + `; echo "${MARK}end${MARK}"`;
}

/** Basic device properties, in one call. */
async function getProps(serial) {
  const out = await adbSh(serial, markedCommand({
    sdk: 'getprop ro.build.version.sdk',
    abilist: 'getprop ro.product.cpu.abilist',
    abi: 'getprop ro.product.cpu.abi',
    model: 'getprop ro.product.model',
    // Locale chain: what the user set (the app runs in it, and splits are
    // chosen by it), then the factory value, then language+region.
    locale_persist: 'getprop persist.sys.locale',
    locale_product: 'getprop ro.product.locale',
    locale_language: 'getprop ro.product.locale.language',
    locale_region: 'getprop ro.product.locale.region',
    // Density: physical and override separately (see the header).
    density_physical: 'wm density | sed -n "s/^ *Physical density: *\\([0-9][0-9]*\\).*/\\1/p" | head -1',
    density_override: 'wm density | sed -n "s/^ *Override density: *\\([0-9][0-9]*\\).*/\\1/p" | head -1',
    density_prop: 'getprop ro.sf.lcd_density',
  }));

  const m = splitMarked(out);
  const num = v => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const sdk = parseInt(m.sdk, 10);

  // Locale: the first candidate that looks like BCP-47. Garbage is skipped.
  const localeCandidates = [
    m.locale_persist,
    m.locale_product,
    (m.locale_language && m.locale_region) ? `${m.locale_language}-${m.locale_region}` : '',
    m.locale_language,
  ];
  let locale = '';
  for (const c of localeCandidates) {
    const v = String(c || '').trim();
    if (v && LOCALE_RE.test(v)) { locale = v; break; }
  }

  const densityPhysical = num(m.density_physical) || num(m.density_prop);
  const densityOverride = num(m.density_override);

  const abilist = String(m.abilist || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!abilist.length && m.abi) abilist.push(String(m.abi).trim());

  const notes = [];
  if (!locale) notes.push('device locale not determined - config.<locale> is skipped when installing splits');
  if (!densityPhysical) notes.push('screen density not determined - config.<density> is skipped');
  if (densityOverride && densityPhysical && densityOverride !== densityPhysical)
    notes.push(`Override density ${densityOverride} is set over physical ${densityPhysical} - splits are chosen by the override`);

  return {
    sdk: Number.isFinite(sdk) ? sdk : 0,
    abilist,
    locale,
    model: m.model || '',
    density: densityOverride || densityPhysical || null,
    density_physical: densityPhysical || null,
    density_override: densityOverride || null,
    notes,
  };
}

/** Every installed package plus the system and disabled subsets. */
async function listPackages(serial) {
  const out = await adbSh(serial, markedCommand({
    all: 'pm list packages',
    system: 'pm list packages -s',
    disabled: 'pm list packages -d',
  }));

  const m = splitMarked(out);
  const section = key => String(m[key] || '').split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('package:'))
    .map(l => l.slice('package:'.length).trim())
    .filter(Boolean);

  const all = section('all');
  return {
    all,
    system: new Set(section('system')),
    disabled: new Set(section('disabled')),
  };
}

/**
 * Account snapshot — the canary of package removal.
 *
 * Only the count and the types: account names from `dumpsys account` never
 * reach the output (personal data, and the before/after comparison does not
 * need them).
 */
async function accountSnapshot(serial) {
  let out = '';
  try {
    out = await adbSh(serial,
      'dumpsys account 2>/dev/null | sed -n "s/.*Account {.*type=\\([^}]*\\)}.*/\\1/p"');
  } catch {
    return { available: false, count: null, types: [] };
  }
  const types = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (!types.length) {
    // Empty means either "no accounts" or "dumpsys is not available to the
    // shell"; the header tells them apart.
    let head = '';
    try { head = await adbSh(serial, 'dumpsys account 2>/dev/null | head -n 2'); } catch { /* ignore */ }
    if (!/User UserInfo|Accounts:/i.test(head)) return { available: false, count: null, types: [] };
  }
  const byType = {};
  for (const t of types) byType[t] = (byType[t] || 0) + 1;
  return { available: true, count: types.length, types: byType };
}

/**
 * Role holders through `dumpsys role` (the role service has no getter in
 * `cmd role`). The service exists from SDK 29; its absence on older firmware
 * is a fact about the platform, noted separately from a failed query.
 *
 * Every role is taken: a role means "this package performs a system function",
 * the role list is vendor-specific, and picking the "important" ones is the
 * mistake this set exists to avoid.
 */
async function roleHolders(serial, sdk) {
  if (!(sdk >= 29))
    return { holders: [], detail: {}, note: `no role service on this platform (SDK ${sdk || '?'} < 29) - roles were not queried, which is normal` };

  let out = '';
  try {
    out = await adbSh(serial, 'dumpsys role');
  } catch (e) {
    return { holders: [], detail: {}, note: `⚠ dumpsys role failed (${e.message}) - roles NOT included in the protected set` };
  }

  if (!/ROLE STATE|roles=|name=android\.app\.role/i.test(out))
    return { holders: [], detail: {}, note: '⚠ dumpsys role returned no role state - roles NOT included in the protected set' };

  // Blocks of the form { name=android.app.role.HOME \n holders=pkg[,pkg] }.
  // Cut at block boundaries, not with a fixed-size window: the last role has
  // no following name=, and a window would silently lose its holder.
  const detail = {};
  const holders = new Set();
  for (const chunk of String(out).split(/(?=name=android\.app\.role\.)/)) {
    const rm = /^name=(android\.app\.role\.[A-Z_0-9]+)/.exec(chunk);
    if (!rm) continue;
    const hm = /holders=([^\r\n}]+)/.exec(chunk);
    if (!hm) continue;
    const list = hm[1].split(',').map(s => s.trim()).filter(looksLikePackage);
    if (!list.length) continue;
    detail[rm[1].replace('android.app.role.', '')] = list;
    list.forEach(p => holders.add(p));
  }

  if (!holders.size)
    return { holders: [], detail: {}, note: 'dumpsys role answered, but the device has no role holders' };

  return { holders: Array.from(holders).sort(), detail, note: null };
}

/**
 * A hex address from /proc/net/tcp in readable form. Each 32-bit word is
 * little-endian. IPv4-mapped addresses (::ffff:a.b.c.d) collapse to IPv4,
 * which is how LAN connections appear in tcp6.
 */
function decodeAddr(hex) {
  const h = String(hex || '').toUpperCase();
  if (h.length === 8) {
    return (h.match(/../g) || []).reverse().map(b => parseInt(b, 16)).join('.');
  }
  if (h.length === 32) {
    const words = h.match(/.{8}/g);
    if (words[0] === '00000000' && words[1] === '00000000' && words[2] === 'FFFF0000')
      return decodeAddr(words[3]);
    const bytes = words.flatMap(w => (w.match(/../g) || []).reverse());
    const parts = [];
    for (let i = 0; i < 16; i += 2) parts.push((bytes[i] + bytes[i + 1]).toLowerCase());
    return parts.join(':').replace(/(^|:)0+([0-9a-f])/g, '$1$2');
  }
  return h;
}

function isLoopback(addr) {
  return /^127\./.test(addr) || addr === '::1' || addr === '0:0:0:0:0:0:0:1';
}

/**
 * Packages holding LISTENING TCP sockets.
 *
 * The account canary looks inside the device; a service something outside the
 * device relies on can die while accounts and the launcher look fine. A
 * listening socket is direct evidence that a package serves someone, without
 * knowing the vendor or the package names.
 *
 * ⚠ Only LISTEN counts. An ESTABLISHED row with a high local port is an
 * outbound connection of the app (any player or VPN client has dozens);
 * what strengthens the signal is an inbound connection to the listening port
 * from a non-loopback address.
 *
 * A uid is not a package: many packages can share one (sharedUserId,
 * android.uid.system = 1000). A uid spread over more than SHARED_UID_LIMIT
 * packages is attributed to none of them and reported in `unattributed`.
 */
async function netListeners(serial) {
  let out = '';
  try {
    out = await adbSh(serial, markedCommand({
      uidmap: 'pm list packages -U',
      tcp: 'cat /proc/net/tcp /proc/net/tcp6',
    }));
  } catch (e) {
    return { ok: false, byPackage: {}, byUid: {}, unattributed: [],
      note: `⚠ listening sockets not collected (${e.message}) - the network signal is NOT included in the protected set` };
  }

  const m = splitMarked(out);
  if (!String(m.tcp || '').trim())
    return { ok: false, byPackage: {}, byUid: {}, unattributed: [],
      note: '⚠ /proc/net/tcp is empty or not readable by the shell - the network signal is NOT included in the protected set' };

  const byUid = {};
  for (const line of String(m.uidmap || '').split('\n')) {
    const mm = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim());
    if (mm) (byUid[mm[2]] = byUid[mm[2]] || []).push(mm[1]);
  }

  const listening = {};   // uid -> Set(port)
  const established = []; // {uid, lport, peer}
  for (const line of String(m.tcp || '').split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || !/^\d+:$/.test(f[0])) continue;
    const [lAddr, lPortHex] = f[1].split(':');
    const [rAddr, rPortHex] = f[2].split(':');
    const state = f[3];
    const uid = f[7];
    const lport = parseInt(lPortHex, 16);
    if (state === '0A') {
      (listening[uid] = listening[uid] || new Set()).add(lport);
    } else if (state === '01') {
      established.push({ uid, lport, peer: decodeAddr(rAddr), rport: parseInt(rPortHex, 16) });
    }
    void lAddr;
  }

  const SHARED_UID_LIMIT = 3;
  const byPackage = {};
  const unattributed = [];

  for (const [uid, ports] of Object.entries(listening)) {
    const owners = byUid[uid] || [];
    const portList = Array.from(ports).sort((a, b) => a - b);

    const external = [];
    for (const e of established) {
      if (e.uid !== uid || !ports.has(e.lport)) continue;
      if (isLoopback(e.peer)) continue;   // a client on the device itself is not an outside dependency
      const tag = `${e.peer} -> :${e.lport}`;
      if (!external.includes(tag)) external.push(tag);
    }

    if (!owners.length || owners.length > SHARED_UID_LIMIT) {
      unattributed.push({
        uid,
        ports: portList,
        serving: external,
        owners: owners.length,
        why: owners.length
          ? `${owners.length} packages share this uid - /proc/net/tcp does not show which one is listening`
          : 'no installed package owns this uid (system daemon outside the package model)',
      });
      continue;
    }

    for (const pkg of owners) {
      const entry = byPackage[pkg] || { ports: [], serving: [] };
      entry.ports = Array.from(new Set([...entry.ports, ...portList])).sort((a, b) => a - b);
      for (const tag of external) if (!entry.serving.includes(tag)) entry.serving.push(tag);
      byPackage[pkg] = entry;
    }
  }

  const note = unattributed.length
    ? `ℹ network signal: ${unattributed.length} listening uid${unattributed.length === 1 ? '' : 's'} not attributed to a package ` +
      `(shared uid, or a daemon outside the package model) - these sockets are NOT included in the protected set, see net_unattributed`
    : null;

  return { ok: true, byPackage, byUid, unattributed, note };
}

/**
 * Which of the given packages serve a client outside the device right now.
 * Pure: works on a netListeners() snapshot.
 *
 * One criterion with two halves: the package LISTENs, and the same local port
 * has an ESTABLISHED connection from a non-loopback address. A listening
 * socket alone is no reason (it would make every torrent client undisableable),
 * an ESTABLISHED row alone is usually outbound, and a loopback peer is a
 * client on the device itself.
 *
 * ⚠ Sockets of a shared uid cannot be attributed, but passing them silently
 * would be the very gap the guard closes: when such a uid serves an outside
 * client and the target package is in it, that is a hit with attributed:
 * false. force_network lifts it like any other hit, and the refusal says the
 * link is unproven.
 */
function servingHits(net, packages) {
  const want = new Set((packages || []).filter(Boolean));
  const hits = [];
  if (!net || !want.size) return hits;

  for (const [pkg, info] of Object.entries(net.byPackage || {})) {
    if (!want.has(pkg)) continue;
    const serving = (info && info.serving) || [];
    if (!serving.length) continue;
    hits.push({
      package: pkg,
      attributed: true,
      ports: (info.ports || []).slice(),
      serving: serving.slice(),
    });
  }

  const byUid = net.byUid || {};
  for (const u of (net.unattributed || [])) {
    if (!u.serving || !u.serving.length) continue;
    for (const pkg of (byUid[u.uid] || [])) {
      if (!want.has(pkg)) continue;
      if (hits.some(h => h.package === pkg)) continue;
      hits.push({
        package: pkg,
        attributed: false,
        uid: u.uid,
        owners: (byUid[u.uid] || []).length,
        ports: (u.ports || []).slice(),
        serving: u.serving.slice(),
      });
    }
  }

  return hits.sort((a, b) => a.package.localeCompare(b.package));
}

/** The network guard refusal: one text for disable, uninstall, stop and clear. */
function servingRefusal(hits, what) {
  const lines = hits.map(h => h.attributed
    ? `  · ${h.package} - listening on ${h.ports.length > 1 ? 'ports' : 'port'} ${h.ports.join(', ')}, ` +
      `currently serving ${h.serving.join(', ')}`
    : `  · ${h.package} - uid ${h.uid} is listening on ${h.ports.join(', ')} and currently serving ` +
      `${h.serving.join(', ')}. ${h.owners} packages share this uid; /proc/net does not show ` +
      `which one holds the socket, and there is no evidence it is NOT ${h.package}`);

  const unproven = hits.some(h => !h.attributed);

  return `REFUSED (${what}): the package is currently serving a client outside the device.\n` +
    lines.join('\n') + '\n' +
    (unproven
      ? 'Some hits are unproven: the socket belongs to a shared uid and cannot be tied to one package.\n'
      : '') +
    'Nothing was applied. Repeat with force_network: true to override; ' +
    '`force` does not lift this guard.';
}

/**
 * Packages that REGISTER an account authenticator. `dumpsys account` prints
 *   AuthenticatorDescription {type=com.example.account},
 *   ComponentInfo{com.example.auth/com.example.auth.AuthenticationService}
 * so the package serving each account type is read, not guessed from its name
 * (an authenticator package may carry no account-like word at all).
 */
async function authProviders(serial) {
  let out = '';
  try {
    out = await adbSh(serial, 'dumpsys account 2>/dev/null | grep AuthenticatorDescription');
  } catch (e) {
    return { byPackage: {}, note: `⚠ authenticator providers not collected (${e.message}) - the signal is NOT included in the protected set` };
  }

  const byPackage = {};
  const re = /AuthenticatorDescription\s*\{\s*type=([^}]*)\}[\s\S]{0,40}?ComponentInfo\{([^/}]+)\//g;
  let mm;
  while ((mm = re.exec(out)) !== null) {
    const type = mm[1].trim();
    const pkg = mm[2].trim();
    if (!looksLikePackage(pkg)) continue;
    const list = byPackage[pkg] = byPackage[pkg] || [];
    if (type && !list.includes(type)) list.push(type);
  }

  if (!Object.keys(byPackage).length)
    return { byPackage: {}, note: '⚠ dumpsys account lists no authenticator - the signal is NOT included in the protected set' };

  return { byPackage, note: null };
}

/**
 * Derive the protected set from the device. Each source is probed separately,
 * does not take the others down, and leaves a note when it did not work.
 */
async function protectedSet(serial, opts = {}) {
  const props = opts.props || await getProps(serial);
  const sources = {};
  const notes = [];

  /** Probe a source, validate it, record a failure in notes. */
  async function derive(key, cmd, extract, humanName) {
    let out;
    try {
      out = await adbSh(serial, cmd);
    } catch (e) {
      notes.push(`⚠ ${humanName}: probe failed (${e.message}) - source NOT included in the protected set`);
      return;
    }
    const raw = extract(out);
    const pkg = pkgOf(raw);
    if (!looksLikePackage(pkg)) {
      // An empty answer usually means the subsystem does not exist on this
      // device (no WebView provider on a watch); garbage means it could not be
      // determined. The notes say which.
      const empty = !String(raw || '').trim();
      notes.push(empty
        ? `ℹ ${humanName}: the subsystem is absent on this device (empty answer) - source not applicable, not included in the protected set`
        : `⚠ ${humanName}: not determined (answer: ${JSON.stringify(String(raw || '').slice(0, 80))}) - source NOT included in the protected set`);
      return;
    }
    sources[key] = pkg;
  }

  const lastLine = out => String(out).trim().split('\n').filter(Boolean).pop() || '';

  // Launcher: resolve-activity exists from SDK 28.
  await derive('launcher',
    'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null',
    lastLine, 'launcher');

  // Package installer: content:// works on SDK 29+; file:// does not resolve
  // there and stays as the fallback for older firmware.
  {
    const variants = [
      'cmd package resolve-activity --brief -a android.intent.action.INSTALL_PACKAGE -d content://x/y.apk 2>/dev/null',
      'cmd package resolve-activity --brief -a android.intent.action.INSTALL_PACKAGE -d file:///x.apk 2>/dev/null',
    ];
    let found = null;
    for (const v of variants) {
      try {
        const pkg = pkgOf(lastLine(await adbSh(serial, v)));
        if (looksLikePackage(pkg)) { found = pkg; break; }
      } catch { /* try the next form */ }
    }
    if (found) sources.installer = found;
    else notes.push('⚠ package installer: not determined via content:// or file:// - source NOT included in the protected set');
  }

  // Active IME
  await derive('ime', 'settings get secure default_input_method',
    out => String(out).trim(), 'active IME');

  // WebView provider
  await derive('webview', 'dumpsys webviewupdate 2>/dev/null | head -n 12',
    out => {
      const m = String(out).match(/Current WebView package \(name, version\):\s*\(([^,\s)]+)/);
      return m ? m[1] : '';
    }, 'WebView provider');

  // Roles
  const roles = await roleHolders(serial, props.sdk);
  if (roles.holders.length) {
    sources.roles = roles.holders;
    sources.roles_detail = roles.detail;
  }
  if (roles.note) notes.push(roles.note);

  const pkgs = opts.packages || await listPackages(serial);

  // Listening sockets and authenticator providers, two derived signals.
  //
  // The line is drawn by reversibility, not importance:
  //  • a system package goes into the set (hard to bring back, its loss is
  //    hard to notice);
  //  • a user package gets an advisory, not a refusal: its APK can be backed
  //    up and installed again.
  // Without that line the network signal would make every torrent server or
  // VPN client undisableable, and the authenticator signal every file manager
  // that registers one.
  //
  // ⚠ A user package that serves an outside client right now is still stopped
  // by the network guard in apps.js, which applies regardless of system/user.
  const advisories = [];
  const net = await netListeners(serial);
  if (net.note) notes.push(net.note);
  const auth = await authProviders(serial);
  if (auth.note) notes.push(auth.note);

  const netSystem = {}, authSystem = {};
  for (const [pkg, info] of Object.entries(net.byPackage)) {
    const where = `listening on port${info.ports.length > 1 ? 's' : ''} ${info.ports.join(', ')}` +
      (info.serving.length ? `; currently serving ${info.serving.join(', ')}` : '');
    if (pkgs.system.has(pkg)) netSystem[pkg] = info;
    else advisories.push({ package: pkg, signal: 'net_listener', system: false, detail: `${where} - something outside the device may depend on it` });
  }
  for (const [pkg, types] of Object.entries(auth.byPackage)) {
    const where = `registers an account authenticator: ${types.join(', ')}`;
    if (pkgs.system.has(pkg)) authSystem[pkg] = types;
    else advisories.push({ package: pkg, signal: 'authenticator', system: false, detail: `${where} - disabling it can take the linked accounts with it` });
  }
  if (Object.keys(netSystem).length) sources.net_listener = netSystem;
  if (net.unattributed && net.unattributed.length) sources.net_unattributed = net.unattributed;
  if (Object.keys(authSystem).length) sources.authenticator = authSystem;

  // Account stack by name, a supplementary source: it catches libraries that
  // register no authenticator themselves and so are invisible above.
  const accountLike = pkgs.all.filter(p => ACCOUNT_HINTS.some(re => re.test(p)));
  if (accountLike.length) sources.account_like = accountLike;

  const set = new Set(CORE_PROTECTED);
  for (const p of pkgs.all) {
    if (CORE_PREFIXES.some(pref => p.startsWith(pref))) set.add(p);
  }
  for (const key of ['launcher', 'installer', 'ime', 'webview']) {
    if (sources[key]) set.add(sources[key]);
  }
  for (const p of roles.holders) set.add(p);
  for (const p of Object.keys(netSystem)) set.add(p);
  for (const p of Object.keys(authSystem)) set.add(p);
  for (const p of accountLike) set.add(p);

  if (accountLike.length)
    notes.push('account_like is a package-name heuristic (supplementary source) - check it by eye in dry_run');
  if (advisories.length)
    notes.push(`${advisories.length} user package${advisories.length === 1 ? '' : 's'} with external-connectivity signals - not protected (reversible via APK backup), see advisories`);
  for (const n of (props.notes || [])) notes.push(n);

  return {
    packages: Array.from(set).sort(),
    sources,
    advisories,
    notes,
    // The raw network snapshot, for the guard in apps.js, so /proc/net is not
    // read twice in one call. Not part of action=protected: sources already
    // show the same.
    net,
  };
}

/**
 * What is on top now: used by both launch paths and by verify on adb_tap,
 * adb_swipe and adb_key, so it lives here and apps.js and ui.js never require
 * each other.
 *
 * The grep pattern (`mResumedActivity|ResumedActivity`) is the one accepted on
 * devices; `topResumedActivity` (SDK 36) does not match it. The component is
 * extracted by a separate regex; none found is null, not a guess.
 */
async function resumedActivity(serial) {
  const resumedLine = (await adbSh(serial,
    'dumpsys activity activities 2>/dev/null | grep -m1 -E "mResumedActivity|ResumedActivity"')).trim();
  const focusLine = (await adbSh(serial,
    'dumpsys window 2>/dev/null | grep -m1 mCurrentFocus')).trim();
  const raw = resumedLine || focusLine;
  const m = /([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/.exec(raw);
  return { raw, component: m ? m[1] : null, resumedLine, focusLine };
}

module.exports = {
  CORE_PROTECTED, CORE_PREFIXES, ACCOUNT_HINTS, PKG_RE, LOCALE_RE,
  getProps, listPackages, accountSnapshot, protectedSet, roleHolders,
  netListeners, servingHits, servingRefusal, authProviders, decodeAddr, isLoopback,
  pkgOf, looksLikePackage, splitMarked, markedCommand, resumedActivity,
};
