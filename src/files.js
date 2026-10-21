'use strict';
/**
 * files.js — installing and removing APKs, file transfer with the device.
 *
 * Bundles (.apks/.xapk/.apkm) are unpacked on the host and the splits are
 * chosen from the device's actual properties. `adb install` refuses a bundle,
 * and the device may have no `unzip`.
 *
 * ⚠ The ZIP reader is our own: the host may have no `unzip` either (Windows,
 * a minimal container), a bundle is a plain ZIP and Node has zlib.
 *
 * ⚠ Three split naming conventions are in use and all are recognised:
 *   bundletool  splits/base-master.apk, base-arm64_v8a.apk, base-ru.apk
 *   APKMirror   com.foo.apk + config.arm64_v8a.apk + config.ru.apk
 *   pulled      base.apk + split_config.arm64_v8a.apk
 *
 * ⚠ A wrong ABI is FATAL (the app does not start), a wrong density is not:
 * density splits fail softly and the resource comes from the base APK. So no
 * ABI match is a refusal, no density match only a skipped split.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { adb, withSerial, text, coerceArray, makeTempDir } = require('./adb.js');
const { checkHostPath } = require('./hostpath.js');
const { getProps } = require('./device.js');

const BUNDLE_EXT = /\.(apks|xapk|apkm)$/i;

let FILE_ROOTS = [];
let ROOTS_HINT;

function configure({ fileRoots = [], rootsHint } = {}) {
  FILE_ROOTS = fileRoots.slice();
  ROOTS_HINT = rootsHint;
}

function hostPath(p, what) {
  return checkHostPath(p, { roots: FILE_ROOTS, setting: 'file_roots', what, emptyHint: ROOTS_HINT });
}

// Android density buckets; tvdpi is common on TV boxes.
const DENSITY_BUCKETS = {
  ldpi: 120, mdpi: 160, tvdpi: 213, hdpi: 240,
  xhdpi: 320, xxhdpi: 480, xxxhdpi: 640,
};
const DENSITY_ANY = new Set(['nodpi', 'anydpi']);

const KNOWN_ABIS = new Set([
  'armeabi', 'armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64', 'mips', 'mips64',
]);

const normAbi = s => String(s || '').replace(/_/g, '-').replace(/^x86-64$/, 'x86_64');

// ───────────────────────── minimal ZIP reader ─────────────────────────

function findEOCD(buf) {
  const maxBack = Math.min(buf.length, 65557); // 22 + the longest comment
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** The ZIP entries, from the central directory. */
function zipEntries(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('not a ZIP: End of Central Directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff)
    throw new Error('ZIP64 bundles are not supported');

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50)
      throw new Error(`corrupt ZIP central directory at entry ${i}`);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const attr = buf.readUInt32LE(off + 38);   // external attributes: the unix mode in the high 16 bits
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, size, local, attr });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function zipRead(buf, e) {
  if (buf.readUInt32LE(e.local) !== 0x04034b50)
    throw new Error(`corrupt local header: ${e.name}`);
  const nameLen = buf.readUInt16LE(e.local + 26);
  const extraLen = buf.readUInt16LE(e.local + 28);
  const start = e.local + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported compression method ${e.method} in ${e.name}`);
}

/**
 * The file name a bundle entry is written under: its last segment by either
 * separator. Empty, ".", "..", or a name with ":" or NUL is refused, so an
 * entry such as `a\..\..\x.apk` cannot leave the temporary directory on
 * Windows.
 */
function safeEntryName(name) {
  const base = String(name).split(/[\\/]/).pop();
  if (!base || base === '.' || base === '..' || /[:\0]/.test(base))
    throw new Error(`unsafe file name in the bundle: ${JSON.stringify(String(name)).slice(0, 120)}`);
  return base;
}

// ──────────────────── classifying and choosing splits ────────────────────

/**
 * The split qualifier of a file name; null for the base APK (base, master,
 * universal, or the package name itself).
 */
function qualifierOf(entryName) {
  const file = entryName.split('/').pop();
  const stem = file.replace(/\.apk$/i, '');

  // base.apk / <pkg>.apk / universal.apk / *-master.apk are bases
  if (/^(base|universal)$/i.test(stem)) return null;
  if (/-master$/i.test(stem)) return null;

  // config.<q> / split_config.<q> / split_config_<q>
  let m = /(?:^|[._-])config[._-](.+)$/i.exec(stem);
  if (m) return m[1];

  // bundletool: <module>-<q>
  m = /^[A-Za-z0-9_]+-(.+)$/.exec(stem);
  if (m) return m[1];

  return null; // the whole package name => base
}

function classify(q) {
  if (!q) return { kind: 'base' };
  const abi = normAbi(q);
  if (KNOWN_ABIS.has(abi)) return { kind: 'abi', value: abi };
  const low = q.toLowerCase();
  if (DENSITY_BUCKETS[low] !== undefined) return { kind: 'density', value: low };
  if (DENSITY_ANY.has(low)) return { kind: 'density_any', value: low };
  // locale: ru, en, pt_BR, b+sr+Latn
  if (/^[a-z]{2,3}([_-][A-Za-z]{2,4})?$/.test(q) || /^b\+/.test(q))
    return { kind: 'locale', value: q.replace(/^b\+/, '').replace(/\+/g, '-') };
  return { kind: 'unknown', value: q };
}

/**
 * Choose the splits for a device. props: what device.getProps returns
 * (abilist/density/locale).
 */
function chooseSplits(names, props, opts = {}) {
  const items = names.map(n => ({ name: n, ...classify(qualifierOf(n)) }));

  const bases = items.filter(i => i.kind === 'base');
  const chosen = [];
  const notes = [];

  // universal.apk alone is a standalone build: no splits needed
  const universal = names.find(n => /(^|\/)universal\.apk$/i.test(n));
  const hasSplits = items.some(i => ['abi', 'density', 'locale'].includes(i.kind));
  if (universal && !hasSplits) {
    return { chosen: [universal], notes: ['bundle holds only universal.apk - installed as a plain APK'], items };
  }

  if (!bases.length) throw new Error('no base APK in the bundle (base/master/<package>.apk)');
  // Every master module (install-time feature modules) goes in whole
  chosen.push(...bases.map(b => b.name));

  // ── ABI: a mistake here is fatal, so a miss is a refusal ──
  const abiItems = items.filter(i => i.kind === 'abi');
  if (abiItems.length) {
    const want = (opts.abi ? [normAbi(opts.abi)] : (props.abilist || []).map(normAbi));
    const hit = want.map(a => abiItems.find(i => i.value === a)).find(Boolean);
    if (!hit) {
      throw new Error(
        (opts.abi
          ? `no split for ABI "${opts.abi}" (device reports: ${(props.abilist || []).join(', ') || 'ABI unknown'}). `
          : `no split for any ABI of the device (${(props.abilist || []).join(', ') || 'ABI unknown'}). `) +
        `Available: ${abiItems.map(i => i.value).join(', ')}. Install cancelled.`);
    }
    chosen.push(hit.name);
    notes.push(`ABI: ${hit.value} (device: ${(props.abilist || []).join(', ')})`);
  }

  // ── Density: a miss is not fatal, the base APK has the resource ──
  const densItems = items.filter(i => i.kind === 'density');
  if (densItems.length) {
    const target = Number(opts.density || props.density) || null;
    if (!target) {
      notes.push('device density not determined - density split skipped (resources come from the base APK)');
    } else {
      let best = null, bestDelta = Infinity;
      for (const i of densItems) {
        const d = Math.abs(DENSITY_BUCKETS[i.value] - target);
        if (d < bestDelta) { best = i; bestDelta = d; }
      }
      chosen.push(best.name);
      notes.push(bestDelta === 0
        ? `density: ${best.value} (${target} dpi, exact match)`
        : `density: ${best.value} - no exact bucket for ${target} dpi in the bundle, nearest used (a density mismatch is not fatal)`);
    }
  }
  for (const i of items.filter(i => i.kind === 'density_any')) chosen.push(i.name);

  // ── Locales: the device language plus everything asked for ──
  const locItems = items.filter(i => i.kind === 'locale');
  if (locItems.length) {
    const wanted = new Set();
    const devLang = String(props.locale || '').split('-')[0].toLowerCase();
    if (devLang) wanted.add(devLang);
    for (const l of coerceArray(opts.locales || [])) {
      const s = String(l || '').split(/[-_]/)[0].toLowerCase();
      if (s) wanted.add(s);
    }
    const picked = locItems.filter(i => wanted.has(String(i.value).split(/[-_]/)[0].toLowerCase()));
    chosen.push(...picked.map(i => i.name));
    if (picked.length)
      notes.push(`locales: ${picked.map(i => i.value).join(', ')} (device language: ${devLang || '?'})`);
    else
      notes.push(`locales: no matching split (device language: ${devLang || '?'}; bundle has: ${locItems.map(i => i.value).join(', ')}) - strings come from the base APK`);
  }

  const unknown = items.filter(i => i.kind === 'unknown');
  if (unknown.length)
    notes.push(`not recognised, skipped: ${unknown.map(i => i.value).join(', ')}`);

  return { chosen: Array.from(new Set(chosen)), notes, items };
}

/** Unpack a bundle into a temporary directory and choose the splits. */
function unpackBundle(bundlePath, props, opts) {
  const buf = fs.readFileSync(bundlePath);
  const entries = zipEntries(buf).filter(e => /\.apk$/i.test(e.name) && !e.name.endsWith('/'));
  if (!entries.length) throw new Error('no .apk inside the bundle');

  // standalones/ are builds for old devices without split support; next to
  // splits/ they only confuse the choice.
  const hasSplitsDir = entries.some(e => /(^|\/)splits\//i.test(e.name));
  const usable = hasSplitsDir
    ? entries.filter(e => !/(^|\/)standalones\//i.test(e.name))
    : entries;

  const sel = chooseSplits(usable.map(e => e.name), props, opts);
  const names = sel.chosen.map(name => ({ name, file: safeEntryName(name) }));

  const dir = makeTempDir('apks-');
  const files = [];
  try {
    for (const { name, file } of names) {
      const e = usable.find(x => x.name === name);
      const out = path.join(dir, file);
      fs.writeFileSync(out, zipRead(buf, e));
      files.push(out);
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, files, notes: sel.notes, total: usable.length };
}

/**
 * dry_run of adb_install. Only an explicit false installs: the boolean, or the
 * string "false" from clients that send booleans as strings. Everything else,
 * absence included, reports without installing. coerceBool would not do here:
 * it turns everything but "true" into false, so `1`, "0" or "yes" would
 * install. implicit: the parameter was not passed at all.
 */
function installDryRun(v) {
  const implicit = v === undefined || v === null || v === '';
  const explicitFalse = v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'false');
  return { dryRun: !explicitFalse, implicit };
}

const DRY_RUN_TAIL = 'dry_run - nothing installed. Repeat with dry_run=false.';
const DRY_RUN_DEFAULT_NOTE = 'dry_run was not passed - adb_install only reports unless dry_run=false.';

function dryRunFooter(dr) {
  return (dr.implicit ? `${DRY_RUN_DEFAULT_NOTE}\n` : '') + DRY_RUN_TAIL;
}

function deviceLine(props) {
  return `Device: SDK ${props.sdk}, ABI ${(props.abilist || []).join(',') || '?'}, ` +
    `${props.density || '?'} dpi, locale ${props.locale || '?'}`;
}

// ───────────────────────── installable files ─────────────────────────
// adb_install without apk_path: what can be installed, without adb. The
// server never downloads APKs: a person puts them into a file_roots folder.

const INSTALLABLE = /\.(apk|apks|xapk|apkm)$/i;
const LIST_LIMIT = 50;
const DEPTH_HINT = 'Only the top level and one level of subfolders are listed; for a deeper folder pass dir.';

function localTime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sizeText(n) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Installable files in `bases` and one folder level below them. Hidden
 * entries (a leading dot) are skipped; every entry passes the host path check,
 * so a symlink or junction that leads out of the roots is not followed.
 * Returns [{ path, size, mtime }], newest first.
 */
function findInstallables(bases, roots) {
  const seen = new Set();
  const found = [];
  const inRoots = p => { try { checkHostPath(p, { roots }); return true; } catch { return false; } };
  const scan = (dir, depth) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      if (!inRoots(full)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) { if (depth === 0) scan(full, 1); continue; }
      if (!st.isFile() || !INSTALLABLE.test(name) || seen.has(full)) continue;
      seen.add(full);
      found.push({ path: full, size: st.size, mtime: st.mtime });
    }
  };
  for (const b of bases) scan(b, 0);
  return found.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
}

function listInstallables(args) {
  if (!FILE_ROOTS.length)
    throw new Error(`adb_install has no folder to list: file_roots is empty, so no folder on this computer is open to the tools. To open one, ${ROOTS_HINT || 'run `brickproof-adb set file_roots <folder>` and restart the server'}.`);
  const bases = args.dir !== undefined && args.dir !== null && String(args.dir).trim() !== ''
    ? [hostPath(String(args.dir), 'dir')]
    : FILE_ROOTS.slice();
  const where = bases.join(', ');
  const files = findInstallables(bases, FILE_ROOTS);
  if (!files.length)
    return text(`No .apk, .apks, .xapk or .apkm file in ${where} (the folder itself and one folder below). ` +
      `Download or copy the file into one of these folders, then call adb_install again; nothing was installed.\n${DEPTH_HINT}`);
  const shown = files.slice(0, LIST_LIMIT).map(f => `  ${f.path}  ${sizeText(f.size)}  ${localTime(f.mtime)}`);
  const more = files.length > LIST_LIMIT ? `\n  …and ${files.length - LIST_LIMIT} more` : '';
  return text(`Installable files in ${where} (the folder itself and one folder below), newest first:\n${shown.join('\n')}${more}\n` +
    `Nothing was installed. Install one with adb_install apk_path=<path from this list>; it reports first unless dry_run=false.\n${DEPTH_HINT}`);
}

async function install(args) {
  const rawPaths = coerceArray(args.apk_path).filter(p => typeof p === 'string' && p.trim() !== '');
  if (rawPaths.length === 0) return listInstallables(args);
  const dr = installDryRun(args.dry_run);

  // ── a bundle ──
  if (rawPaths.length === 1 && BUNDLE_EXT.test(rawPaths[0])) {
    const bundle = hostPath(rawPaths[0], 'apk_path');
    if (!fs.existsSync(bundle)) throw new Error(`Bundle not found: ${bundle}`);

    const props = await getProps(args.serial);
    let tmp = null;
    try {
      tmp = unpackBundle(bundle, props, { abi: args.abi, density: args.density, locales: args.locales });

      const head =
        `Bundle: ${path.basename(bundle)} (${tmp.total} apk inside)\n` +
        `${deviceLine(props)}\n` +
        `Chose ${tmp.files.length}: ${tmp.files.map(f => path.basename(f)).join(', ')}\n` +
        tmp.notes.map(n => `  · ${n}`).join('\n');

      if (dr.dryRun)
        return text(`${head}\n\n${dryRunFooter(dr)}`);

      const verb = tmp.files.length > 1 ? 'install-multiple' : 'install';
      const out = await adb(withSerial(args.serial, [verb, '-r', '-t', '-g', ...tmp.files]), { timeout: 300000 });
      return text(`${head}\n\n${verb}: ${out.trim() || 'OK'}`);
    } finally {
      if (tmp && tmp.dir) fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
  }

  // ── plain APKs / a list of splits ──
  const apks = rawPaths.map(p => {
    const r = hostPath(p, 'apk_path');
    if (!fs.existsSync(r)) throw new Error(`APK not found: ${r}`);
    return r;
  });
  const verb = apks.length > 1 ? 'install-multiple' : 'install';

  // The paths are checked above, so the report and the install refuse alike.
  if (dr.dryRun) {
    const props = await getProps(args.serial);
    const lines = apks.map(p => `  ${p} (${fs.statSync(p).size} bytes)`);
    return text(
      `APK: ${apks.length} file${apks.length === 1 ? '' : 's'}\n${lines.join('\n')}\n` +
      `${deviceLine(props)}\n` +
      `Would run: ${verb} -r -t -g ${apks.map(p => path.basename(p)).join(' ')} ` +
      `on ${args.serial || 'the only connected device'}\n\n${dryRunFooter(dr)}`);
  }

  const out = await adb(withSerial(args.serial, [verb, '-r', '-t', '-g', ...apks]), { timeout: 180000 });
  return text(out.trim() || `${verb}: ${apks.length} file(s) OK`);
}

async function uninstall(args) {
  const a = ['uninstall'];
  if (args.keep_data === true || args.keep_data === 'true') a.push('-k');
  a.push(args.package);
  // Counted by the package list afterwards, as adb_app counts its changes.
  const [r] = await require('./apps.js').applyVerified(args.serial, [
    { package: args.package, change: 'uninstall', run: () => adb(withSerial(args.serial, a), { timeout: 60000 }) },
  ]);
  // Without a package list the device's own error stays as it is (a lost
  // device is recognised by it).
  if (!r.ok) throw new Error(/^not removed/.test(r.error) ? `${args.package}: ${r.error}` : r.error);
  return text(r.out + (r.warning ? `\nWarning: ${r.warning}` : ''));
}

async function push(args) {
  const src = hostPath(args.host_path, 'host_path');
  if (!fs.existsSync(src)) throw new Error(`File not found: ${src}`);
  const size = fs.statSync(src).size;
  // adb push prints its statistics to stderr when stdout is not a TTY
  const r = await adb(withSerial(args.serial, ['push', src, args.device_path]), { timeout: 120000, withStderr: true });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  return text(out || `Pushed ${src} -> ${args.device_path} (${size} bytes)`);
}

async function pull(args) {
  const dst = hostPath(args.host_path, 'host_path');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await adb(withSerial(args.serial, ['pull', args.device_path, dst]), { timeout: 120000, withStderr: true });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  let size = 0;
  try { const st = fs.statSync(dst); size = st.isFile() ? st.size : 0; } catch { /* ignore */ }
  return text(out || `Pulled ${args.device_path} -> ${dst}${size ? ` (${size} bytes)` : ''}`);
}

module.exports = {
  configure, install, uninstall, push, pull, findInstallables, LIST_LIMIT,
  zipEntries, zipRead, qualifierOf, classify, chooseSplits, unpackBundle, safeEntryName,
  installDryRun, DRY_RUN_TAIL, DRY_RUN_DEFAULT_NOTE,
};
