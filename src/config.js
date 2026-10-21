'use strict';
/**
 * brickproof-adb — configuration: config file, environment and flags. No
 * network, no adb; writes only in ensureStateDir() and writeSetting().
 *
 * The server works without any file. A file is looked up at env
 * BRICKPROOF_CONFIG (must exist), then <config_dir>/config.json, then none;
 * `brickproof-adb set` writes it.
 * Precedence: flags (and the stdio directory arguments) > env > file > defaults.
 * On Windows, with file_roots set by no source, loadConfig() reads where the
 * Downloads folder is from the registry (powershell.exe, 15 s at most).
 *
 * The settings directories follow the operating system:
 *   Linux    config $XDG_CONFIG_HOME/brickproof-adb (~/.config/brickproof-adb)
 *            state  $XDG_STATE_HOME/brickproof-adb  (~/.local/state/brickproof-adb)
 *   macOS    both   ~/Library/Application Support/brickproof-adb
 *   Windows  config %APPDATA%\brickproof-adb, state %LOCALAPPDATA%\brickproof-adb
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = 'brickproof-adb';

const DEFAULTS = {
  port: 3200,
  host: '127.0.0.1',
  allowed_hosts: [],
  log_requests: false,
  allow_shell: false,
  allow_uninstall: false,
  devices: [],
  scan_subnets: [],
  adb_path: 'adb',
};

const KEYS = new Set(['$comment', 'port', 'host', 'allowed_hosts', 'log_requests', 'allow_shell', 'allow_uninstall',
  'devices', 'file_roots', 'scan_subnets', 'store', 'state_dir', 'adb_path']);

// The environment variable of each key that has one.
const ENV_OF = {
  log_requests: 'BRICKPROOF_LOG_REQUESTS', allow_shell: 'BRICKPROOF_ALLOW_SHELL', allow_uninstall: 'BRICKPROOF_ALLOW_UNINSTALL',
  devices: 'BRICKPROOF_DEVICES', file_roots: 'BRICKPROOF_FILE_ROOTS', scan_subnets: 'BRICKPROOF_SCAN_SUBNETS',
  store: 'BRICKPROOF_STORE', state_dir: 'BRICKPROOF_STATE_DIR', adb_path: 'BRICKPROOF_ADB',
};

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// An unset value: absent, empty, or a placeholder a launcher left unresolved
// (an optional field of a desktop extension's form that was not filled in).
function envValue(env, name) {
  const v = env[name];
  if (v === undefined || v === '' || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(v)) return undefined;
  return v;
}

function isPort(n) {
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

// Path functions of the given platform, so the directory rules can be tested
// for every operating system on any of them.
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** config_dir and state_dir defaults for a platform. */
function platformDirs({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const P = pathFor(platform);
  if (platform === 'win32') {
    const roaming = envValue(env, 'APPDATA') || P.join(homedir, 'AppData', 'Roaming');
    const local = envValue(env, 'LOCALAPPDATA') || P.join(homedir, 'AppData', 'Local');
    return { configDir: P.join(roaming, APP_DIR), stateDir: P.join(local, APP_DIR) };
  }
  if (platform === 'darwin') {
    const dir = P.join(homedir, 'Library', 'Application Support', APP_DIR);
    return { configDir: dir, stateDir: dir };
  }
  // XDG: a relative value is invalid and ignored.
  const xdg = name => {
    const v = envValue(env, name);
    return v && P.isAbsolute(v) ? v : undefined;
  };
  return {
    configDir: P.join(xdg('XDG_CONFIG_HOME') || P.join(homedir, '.config'), APP_DIR),
    stateDir: P.join(xdg('XDG_STATE_HOME') || P.join(homedir, '.local', 'state'), APP_DIR),
  };
}

// ------------------------------------------------- Windows: the Downloads folder

const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';

// Prints the raw Downloads value of User Shell Folders, then of Shell Folders,
// one line each: base64 of the UTF-16 text, or "-". The output is ASCII
// whatever the console code page, so a localized, non-ASCII folder name
// arrives intact; reg.exe prints in the OEM code page instead.
const SHELL_FOLDERS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "foreach ($n in 'User Shell Folders', 'Shell Folders') {",
  '  $v = $null',
  "  $k = Get-Item -LiteralPath ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\' + $n)",
  `  if ($k) { $v = $k.GetValue('${DOWNLOADS_GUID}', $null, 'DoNotExpandEnvironmentNames') }`,
  "  if ($v -is [string] -and $v -ne '') { [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($v)) } else { '-' }",
  '}',
].join('\n');

/** { user, shell } of the script's output; null for a value that is absent. */
function parseShellFolders(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const value = line => {
    if (!line || line === '-' || !/^[A-Za-z0-9+/]+={0,2}$/.test(line)) return null;
    const buf = Buffer.from(line, 'base64');
    return buf.length && buf.length % 2 === 0 ? buf.toString('utf16le') : null;
  };
  return { user: value(lines[0]), shell: value(lines[1]) };
}

/** %NAME% replaced from the environment, names in any case; unknown ones stay. */
function expandWindowsEnv(value, env) {
  return value.replace(/%([^%]+)%/g, (all, name) => {
    const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
    return key !== undefined && env[key] !== undefined && env[key] !== '' ? env[key] : all;
  });
}

// The longest the registry read may take: powershell.exe starts slowly on a
// busy or freshly booted machine.
const REGISTRY_TIMEOUT_MS = 15000;

// A Windows PowerShell script: { stdout } or { error: why it failed }. The
// script goes in as UTF-16 (-EncodedCommand), so no quoting or code page
// touches it.
function runPowerShellResult(script, { env = process.env, timeout = REGISTRY_TIMEOUT_MS } = {}) {
  try {
    const root = envValue(env, 'SystemRoot') || envValue(env, 'SYSTEMROOT') || envValue(env, 'windir') || 'C:\\Windows';
    const ps = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const r = require('child_process').spawnSync(ps,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { encoding: 'ascii', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.error) return { error: r.error.code === 'ETIMEDOUT' ? `timed out after ${+(timeout / 1000).toFixed(3)} s` : `powershell.exe could not run: ${r.error.code || r.error.message}` };
    if (r.status !== 0) return { error: r.signal ? `powershell.exe was stopped by ${r.signal}` : `powershell.exe exited with code ${r.status}` };
    return { stdout: r.stdout };
  } catch (e) { return { error: `powershell.exe could not run: ${e.code || e.message}` }; }
}

// The stdout of a Windows PowerShell script, or null on any failure.
function runPowerShell(script, opts) {
  const r = runPowerShellResult(script, opts);
  return r.error ? null : r.stdout;
}

/**
 * The Downloads values of the registry, { user, shell }, or { error } when
 * they cannot be read (REGISTRY_TIMEOUT_MS at most).
 */
function readShellFolders({ env = process.env } = {}) {
  const r = runPowerShellResult(SHELL_FOLDERS_SCRIPT, { env });
  return r.error ? { error: r.error } : parseShellFolders(r.stdout);
}

/**
 * The user's downloads folder. Windows: the Downloads value of User Shell
 * Folders (with %VAR% expanded), then of Shell Folders, then <home>\Downloads;
 * the first that is a directory. macOS: ~/Downloads. Linux: XDG_DOWNLOAD_DIR
 * (environment, else ~/.config/user-dirs.dirs, where a localized system names
 * it), else ~/Downloads. null when it does not exist.
 */
function downloadsDir(opts = {}) {
  return findDownloads(opts).dir;
}

/**
 * downloadsDir() with the reason a Windows registry read failed:
 * { dir, registryError, fallback }; fallback is <home>/Downloads, the place
 * looked at last.
 */
function findDownloads({ platform = process.platform, env = process.env, homedir = os.homedir(), isDir = isDirectory,
  readFile = p => fs.readFileSync(p, 'utf8'), shellFolders = readShellFolders } = {}) {
  const P = pathFor(platform);
  const fallback = P.join(homedir, 'Downloads');
  let dir = fallback;
  let registryError = null;
  if (platform === 'win32') {
    const sf = shellFolders({ env }) || {};
    if (sf.error) registryError = sf.error;
    for (const v of [sf.user, sf.shell]) {
      if (typeof v !== 'string' || !v) continue;
      const e = expandWindowsEnv(v, env);
      if (P.isAbsolute(e) && isDir(e)) return { dir: e, registryError, fallback };
    }
  }
  if (platform !== 'win32' && platform !== 'darwin') {
    const expand = v => v.replace(/^\$HOME(?=\/|$)/, homedir).replace(/^~(?=\/|$)/, homedir);
    let xdg = envValue(env, 'XDG_DOWNLOAD_DIR');
    if (!xdg) {
      const confHome = envValue(env, 'XDG_CONFIG_HOME') && P.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : P.join(homedir, '.config');
      try {
        const text = readFile(P.join(confHome, 'user-dirs.dirs'));
        const m = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"([^"]*)"\s*$/m.exec(text);
        if (m) xdg = m[1];
      } catch {}
    }
    if (xdg) {
      const e = expand(xdg);
      // A value equal to $HOME means "no downloads folder".
      if (P.isAbsolute(e) && P.resolve(e) !== P.resolve(homedir)) dir = e;
    }
  }
  return { dir: isDir(dir) ? dir : null, registryError, fallback };
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ------------------------------------------------------------- subnets (CIDR)

function ipToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function isPrivateIp(n) {
  return (n >>> 24) === 10 || (n >>> 20) === ((172 << 4) | 1) || (n >>> 16) === ((192 << 8) | 168);
}

/** "192.0.2.0/24" -> { base, prefix } or a problem string. Private ranges only, no wider than /22. */
function parseSubnet(s) {
  const m = /^([\d.]+)\/(\d{1,2})$/.exec(String(s).trim());
  if (!m) return `"${s}" is not a subnet in CIDR form (e.g. 192.168.77.0/24)`;
  const ip = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix > 32) return `"${s}" is not a valid subnet`;
  if (prefix < 22) return `"${s}" is wider than /22`;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const base = (ip & mask) >>> 0;
  if (!isPrivateIp(base)) return `"${s}" is not a private range (10/8, 172.16/12, 192.168/16)`;
  return { base, prefix, text: `${intToIp(base)}/${prefix}` };
}

// An entry of allowed_hosts: a host name or address without scheme, port or
// path; an IPv6 address in brackets. null when it is valid.
function hostNameProblem(h) {
  if (typeof h !== 'string' || h === '') return 'every entry must be a non-empty string';
  if (h.includes('/')) return `"${h}" must be a host name, without a scheme or a path`;
  const v6 = /^\[[0-9A-Fa-f:.]+\]$/.test(h);
  if (!v6 && h.includes(':')) return `"${h}" must be a host name without a port (an IPv6 address goes in brackets)`;
  let parsed;
  try { parsed = new URL(`http://${h}`); } catch { return `"${h}" is not a valid host name`; }
  if (!parsed.hostname || parsed.port || parsed.username || parsed.pathname !== '/' || parsed.search || parsed.hash)
    return `"${h}" is not a valid host name`;
  return null;
}

// An entry of devices: ip, ip:port or a host name, no spaces. null when valid.
function deviceProblem(d) {
  if (typeof d !== 'string' || d === '') return 'every entry must be a non-empty string';
  if (/[\s,]/.test(d)) return `"${d}" must be one host (ip or ip:port), without spaces or commas`;
  return null;
}

// Validates the parsed file and returns its settings; defaults are not filled
// in here.
function parseConfig(raw, file) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${file}: must be a JSON object`);
  for (const k of Object.keys(raw)) if (!KEYS.has(k)) problems.push(`unknown key "${k}"`);

  const c = raw.$comment;
  if (c !== undefined && typeof c !== 'string' && !(Array.isArray(c) && c.every(s => typeof s === 'string')))
    problems.push('"$comment" must be a string or an array of strings');
  for (const k of ['store', 'state_dir']) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || !path.isAbsolute(raw[k])) problems.push(`"${k}" must be an absolute path`);
  }
  if (raw.port !== undefined && !isPort(raw.port)) problems.push('"port" must be an integer 0-65535');
  if (raw.host !== undefined && (typeof raw.host !== 'string' || !raw.host)) problems.push('"host" must be a non-empty string');
  for (const k of ['log_requests', 'allow_shell', 'allow_uninstall']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') problems.push(`"${k}" must be true or false`);
  }
  if (raw.adb_path !== undefined && (typeof raw.adb_path !== 'string' || !raw.adb_path)) problems.push('"adb_path" must be a non-empty string');
  if (raw.allowed_hosts !== undefined) {
    if (!Array.isArray(raw.allowed_hosts)) problems.push('"allowed_hosts" must be an array of host names');
    else for (const h of raw.allowed_hosts) {
      const why = hostNameProblem(h);
      if (why) problems.push(`"allowed_hosts": ${why}`);
    }
  }
  if (raw.devices !== undefined) {
    if (!Array.isArray(raw.devices)) problems.push('"devices" must be an array of hosts');
    else for (const d of raw.devices) {
      const why = deviceProblem(d);
      if (why) problems.push(`"devices": ${why}`);
    }
  }
  if (raw.file_roots !== undefined) {
    if (!Array.isArray(raw.file_roots)) problems.push('"file_roots" must be an array of absolute paths');
    else for (const r of raw.file_roots) {
      if (typeof r !== 'string' || !path.isAbsolute(r)) problems.push(`"file_roots": ${JSON.stringify(r)} must be an absolute path`);
    }
  }
  if (raw.scan_subnets !== undefined) {
    if (!Array.isArray(raw.scan_subnets)) problems.push('"scan_subnets" must be an array of subnets');
    else for (const s of raw.scan_subnets) {
      const r = parseSubnet(s);
      if (typeof r === 'string') problems.push(`"scan_subnets": ${r}`);
    }
  }
  if (problems.length) throw new ConfigError(`${file}: invalid config\n  ${problems.join('\n  ')}`);
  return raw;
}

function configCandidates({ env = process.env, cwd = process.cwd(), platform = process.platform, homedir = os.homedir() } = {}) {
  const list = [];
  const fromEnv = envValue(env, 'BRICKPROOF_CONFIG');
  if (fromEnv) list.push({ path: path.resolve(cwd, fromEnv), source: 'env BRICKPROOF_CONFIG', required: true });
  const { configDir } = platformDirs({ platform, env, homedir });
  list.push({ path: path.join(configDir, 'config.json'), source: 'config directory' });
  return list;
}

function readConfigFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new ConfigError(`${file}: cannot read (${e.code || e.message})`); }
  try { return JSON.parse(text.replace(/^﻿/, '')); }
  catch (e) {
    // The engine message may quote a slice of the file; only the position is
    // reported.
    const m = /position (\d+)/.exec(e.message);
    let where = '';
    if (m) {
      const before = text.slice(0, Number(m[1]));
      where = ` at line ${before.split('\n').length}, column ${Number(m[1]) - before.lastIndexOf('\n')}`;
    }
    throw new ConfigError(`${file}: not valid JSON${where}`);
  }
}

// A boolean from the environment: true/1 or false/0, anything else is an error.
function envBool(env, name) {
  const v = envValue(env, name);
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  throw new ConfigError(`env ${name} must be true or false (or 1 / 0), got ${JSON.stringify(v.slice(0, 40))}`);
}

/** BRICKPROOF_FILE_ROOTS: absolute paths separated by path.delimiter; empty items dropped. */
function splitRoots(value, delimiter = path.delimiter) {
  return String(value).split(delimiter).map(s => s.trim()).filter(Boolean);
}

/** BRICKPROOF_DEVICES, BRICKPROOF_SCAN_SUBNETS: separated by commas and/or whitespace; empty items dropped. */
function splitDevices(value) {
  return String(value).split(/[\s,]+/).filter(Boolean);
}

/**
 * Resolved settings with the source of each in `sources`. `flags` holds the
 * command-line values: port, host (serve) and file_roots (the directory
 * arguments of stdio).
 */
function loadConfig({ env = process.env, cwd = process.cwd(), platform = process.platform, homedir = os.homedir(), flags = {}, isDir = isDirectory,
  shellFolders = readShellFolders } = {}) {
  const candidates = configCandidates({ env, cwd, platform, homedir });
  let hit = null;
  for (const c of candidates) {
    if (fs.existsSync(c.path)) { hit = c; break; }
    if (c.required) throw new ConfigError(`config file from env BRICKPROOF_CONFIG not found: ${c.path}`);
  }
  const file = hit ? parseConfig(readConfigFile(hit.path), hit.path) : {};
  const fileSrc = hit ? `config ${hit.path}` : null;
  const dirs = platformDirs({ platform, env, homedir });

  const settings = {};
  const sources = {};
  const pick = (key, ...options) => {
    for (const [value, source] of options) {
      if (value !== undefined) { settings[key] = value; sources[key] = source; return; }
    }
  };
  const fromEnv = (name, convert = v => v) => (envValue(env, name) !== undefined ? convert(env[name]) : undefined);

  pick('port', [flags.port, 'flag --port'], [file.port, fileSrc], [DEFAULTS.port, 'default']);
  pick('host', [flags.host, 'flag --host'], [file.host, fileSrc], [DEFAULTS.host, 'default']);
  pick('allowed_hosts', [file.allowed_hosts, fileSrc], [DEFAULTS.allowed_hosts, 'default']);
  for (const key of ['log_requests', 'allow_shell', 'allow_uninstall'])
    pick(key, [envBool(env, ENV_OF[key]), `env ${ENV_OF[key]}`], [file[key], fileSrc], [DEFAULTS[key], 'default']);

  pick('devices', [fromEnv('BRICKPROOF_DEVICES', splitDevices), 'env BRICKPROOF_DEVICES'], [file.devices, fileSrc], [DEFAULTS.devices, 'default']);

  const envSubnets = fromEnv('BRICKPROOF_SCAN_SUBNETS', splitDevices);
  if (envSubnets) {
    const bad = envSubnets.map(parseSubnet).filter(r => typeof r === 'string');
    if (bad.length) throw new ConfigError(`env BRICKPROOF_SCAN_SUBNETS: ${bad.join('; ')}`);
  }
  pick('scan_subnets', [envSubnets, 'env BRICKPROOF_SCAN_SUBNETS'], [file.scan_subnets, fileSrc], [DEFAULTS.scan_subnets, 'default']);
  settings.scan_subnets = settings.scan_subnets.map(s => parseSubnet(s).text);

  // file_roots: an empty value counts as set (to nothing), unlike the other
  // lists. Not set by any source: the downloads folder, when it exists.
  const envRootsRaw = env.BRICKPROOF_FILE_ROOTS;
  const envRoots = envRootsRaw === undefined || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(envRootsRaw) ? undefined : splitRoots(envRootsRaw);
  if (envRoots) {
    const bad = envRoots.filter(r => !path.isAbsolute(r));
    if (bad.length) throw new ConfigError(`env BRICKPROOF_FILE_ROOTS: every entry must be an absolute path (separator "${path.delimiter}"): ${bad.map(b => JSON.stringify(b)).join(', ')}`);
  }
  const flagRoots = flags.file_roots && flags.file_roots.length ? flags.file_roots.map(r => path.resolve(cwd, r)) : undefined;
  const found = flagRoots || envRoots || file.file_roots ? null : findDownloads({ platform, env, homedir, isDir, shellFolders });
  const downloads = found && found.dir;
  // A failed registry read is said, not passed over: the folder found, or not
  // found, may not be the one the system has for Downloads.
  const registryNote = found && found.registryError
    ? `the registry could not be read: ${found.registryError}; ${found.fallback} ${downloads ? 'used' : 'not found'}`
    : null;
  pick('file_roots',
    [flagRoots, 'arguments'],
    [envRoots, 'env BRICKPROOF_FILE_ROOTS'],
    [file.file_roots, fileSrc],
    [downloads ? [downloads] : undefined, registryNote ? `default: ${registryNote}` : 'default'],
    [[], registryNote ? `default: ${registryNote}` : 'default: no Downloads folder found']);
  settings.file_roots = settings.file_roots.map(r => path.resolve(r));

  pick('state_dir',
    [fromEnv('BRICKPROOF_STATE_DIR', v => path.resolve(cwd, v)), 'env BRICKPROOF_STATE_DIR'],
    [file.state_dir !== undefined ? path.resolve(file.state_dir) : undefined, fileSrc],
    [dirs.stateDir, 'default']);
  pick('store',
    [fromEnv('BRICKPROOF_STORE', v => path.resolve(cwd, v)), 'env BRICKPROOF_STORE'],
    [file.store !== undefined ? path.resolve(file.store) : undefined, fileSrc],
    [path.join(settings.state_dir, 'snapshots'), 'default: <state_dir>/snapshots']);

  // A bare name ("adb") is looked up on PATH by the system; a path with a
  // directory part is resolved against the working directory. The default is
  // not a path: the adb search of platform-tools.js decides.
  const adbOf = v => (/[\\/]/.test(v) ? path.resolve(cwd, v) : v);
  pick('adb_path',
    [fromEnv('BRICKPROOF_ADB', adbOf), 'env BRICKPROOF_ADB'],
    [file.adb_path !== undefined ? adbOf(file.adb_path) : undefined, fileSrc],
    [DEFAULTS.adb_path, 'default']);

  return {
    settings,
    sources,
    settingsUi: envValue(env, 'BRICKPROOF_SETTINGS_UI') || null,
    file: hit ? hit.path : null,
    fileSource: hit ? hit.source : null,
    searched: candidates.map(c => c.path),
    configDir: dirs.configDir,
    writeTarget: candidates[0].path,
    // For a warning line at start: why the Downloads folder may be wrong.
    downloadsWarning: registryNote ? `the Downloads folder is uncertain: ${registryNote}; set file_roots to choose the folder` : null,
  };
}

// The BRICKPROOF_SETTINGS_UI of the Docker image (Dockerfile).
const CONTAINER_UI = 'the environment of the container';

/**
 * What a person does to change a setting, for refusal texts: the settings UI
 * of the launcher when there is one (BRICKPROOF_SETTINGS_UI; the container's
 * environment names the variable), else the environment variable the value
 * came from, else `brickproof-adb set`.
 */
function settingAction(key, loaded) {
  const ui = loaded && loaded.settingsUi;
  const source = loaded && loaded.sources ? loaded.sources[key] : null;
  const fromEnv = typeof source === 'string' && source.startsWith('env ');
  // The Docker image: settings are environment variables of the container.
  if (ui === CONTAINER_UI) {
    if (key === 'file_roots')
      return `mount a host folder into the container and set ${ENV_OF.file_roots} in ${CONTAINER_UI} to its path inside the container, then recreate the container (docker compose up -d)`;
    return `set ${ENV_OF[key]}=true in ${CONTAINER_UI} and recreate the container (docker compose up -d)`;
  }
  if (key === 'file_roots') {
    if (ui) return `add a folder to file_roots in ${ui}`;
    if (fromEnv) return `add a folder to the environment variable ${ENV_OF.file_roots} where the server is started, and restart it`;
    return 'run `brickproof-adb set file_roots <folder>` and restart the server';
  }
  if (ui) return `turn on ${key} in ${ui}`;
  if (fromEnv) return `set the environment variable ${ENV_OF[key]}=true where the server is started, and restart it`;
  return `run \`brickproof-adb set ${key} on\` and restart the server`;
}

/** The action texts of the settings refusals name, for server.init(). */
function settingHints(loaded) {
  return {
    allow_shell: settingAction('allow_shell', loaded),
    allow_uninstall: settingAction('allow_uninstall', loaded),
    file_roots: settingAction('file_roots', loaded),
  };
}

// ---------------------------------------------------------------- set command

const SETTABLE = ['port', 'host', 'allowed_hosts', 'log_requests', 'allow_shell', 'allow_uninstall', 'devices', 'file_roots',
  'scan_subnets', 'store', 'state_dir', 'adb_path'];
const LISTS = new Set(['allowed_hosts', 'devices', 'file_roots', 'scan_subnets']);
const BOOLS = new Set(['log_requests', 'allow_shell', 'allow_uninstall']);

/** The JSON value of `set <key> <words...>`; throws ConfigError with a hint. */
function settingValue(key, words, cwd = process.cwd()) {
  if (!SETTABLE.includes(key)) throw new ConfigError(`unknown setting "${key}"; settings: ${SETTABLE.join(', ')}`);
  if (BOOLS.has(key)) {
    if (words.length !== 1) throw new ConfigError(`${key} takes one value: on or off`);
    const w = words[0].toLowerCase();
    if (w === 'on' || w === 'true') return true;
    if (w === 'off' || w === 'false') return false;
    throw new ConfigError(`${key} takes on or off, got "${words[0]}"`);
  }
  if (LISTS.has(key)) {
    const items = key === 'file_roots' ? words : words.flatMap(splitDevices);
    return key === 'file_roots' ? items.map(w => path.resolve(cwd, w)) : items;
  }
  if (words.length !== 1) throw new ConfigError(`${key} takes one value`);
  if (key === 'port') {
    if (!/^\d+$/.test(words[0])) throw new ConfigError('port must be an integer 0-65535');
    return Number(words[0]);
  }
  if (key === 'store' || key === 'state_dir') return path.resolve(cwd, words[0]);
  if (key === 'adb_path') return /[\\/]/.test(words[0]) ? path.resolve(cwd, words[0]) : words[0];
  return words[0];
}

/**
 * `brickproof-adb set <key> [<value>...]`: write one key into the settings
 * file (created with its directory when missing); no value removes the key,
 * so the default applies. Returns { file, value, removed }.
 */
function writeSetting(file, key, words, { cwd = process.cwd() } = {}) {
  let current = {};
  if (fs.existsSync(file)) current = readConfigFile(file);
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new ConfigError(`${file}: must be a JSON object`);
  const next = { ...current };
  let value = null;
  if (!words.length) {
    if (!SETTABLE.includes(key)) throw new ConfigError(`unknown setting "${key}"; settings: ${SETTABLE.join(', ')}`);
    delete next[key];
  } else {
    value = settingValue(key, words, cwd);
    next[key] = value;
  }
  parseConfig(next, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { file, value, removed: !words.length };
}

// The state directory is created on start with mode 0700; an existing one is
// left as it is.
function ensureStateDir(dir) {
  // Not writable (a Docker volume or bind mount owned by root while the
  // process runs as another user): say what to do, not a stack trace.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const hint = owner => `state_dir ${dir} is not writable by this process` +
    (uid !== null ? ` (uid ${uid}${owner !== null ? `; the directory belongs to uid ${owner}` : ''})` : '') +
    `: make it writable for${uid !== null ? ` uid ${uid}` : ' this user'} (for a Docker volume or bind mount: chown ${uid !== null ? `${uid}:${uid}` : '<uid>:<gid>'} on it), run as its owner, or set state_dir to another directory`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS') throw new ConfigError(hint(null));
    throw e;
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    let owner = null;
    try { owner = fs.statSync(dir).uid; } catch {}
    throw new ConfigError(hint(owner));
  }
  return dir;
}

module.exports = {
  DEFAULTS, ConfigError, APP_DIR, KEYS, ENV_OF, SETTABLE,
  platformDirs, downloadsDir, findDownloads, REGISTRY_TIMEOUT_MS, parseShellFolders, expandWindowsEnv, readShellFolders, runPowerShell, runPowerShellResult, parseConfig, configCandidates, loadConfig, ensureStateDir, splitRoots, splitDevices, envBool,
  parseSubnet, ipToInt, intToIp, isPrivateIp,
  settingAction, settingHints, settingValue, writeSetting,
};
