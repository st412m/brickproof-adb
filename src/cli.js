'use strict';
// The commands; src/main.js runs them. Nothing happens on require(). stdout
// belongs to the MCP protocol in stdio mode: logs go to stderr only.

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const C = require('./config');
const { VERSION, PNGJS_VERSION, JPEG_JS_VERSION } = require('./version');

const USAGE = `brickproof-adb ${VERSION}

Usage:
  brickproof-adb [<folder>...]       MCP server on stdio; the folders, when given,
                                     are file_roots
  brickproof-adb serve [--port 3200] [--host 127.0.0.1] [--token-file F]
                                     MCP server over Streamable HTTP
  brickproof-adb set <key> [<value>...]
                                     write a setting into the settings file;
                                     no value: back to the default
  brickproof-adb get-adb [--accept-license]
                                     download Google's platform-tools (adb)
  brickproof-adb token [--new]       print the connector path and the Bearer line;
                                     --new replaces the token
  brickproof-adb check [--offline]   settings, adb, the image pipeline, file roots,
                                     store; connected devices unless --offline
  brickproof-adb --version | --help
`;

function say(msg) {
  process.stderr.write(`brickproof-adb: ${msg}\n`);
}

function usageError(msg) {
  say(`${msg}\n\n${USAGE}`);
  return 2;
}

function load(flags) {
  return C.loadConfig({ flags });
}

// The adb the server will use (only files are checked) and init().
function initServer(loaded) {
  const PT = require('./platform-tools');
  const adb = PT.resolveAdbPath(loaded.settings, loaded.sources);
  const S = require('./server');
  S.init(loaded.settings, { hints: C.settingHints(loaded), adbPath: adb.path });
  return { S, adb };
}

// What runs before either transport serves: stale temp dirs from a killed
// process are removed, the devices of the settings and the remembered ones
// are connected in the background (a failure is a line in stderr, not a start
// failure).
function startBackground(s) {
  const A = require('./adb');
  for (const dir of A.sweepTempDirs()) say(`removed a stale temporary directory: ${dir}`);
  const session = require('./session');
  const all = [...new Set([...s.devices, ...session.readKnown()])];
  if (!all.length) return;
  (async () => {
    for (const d of all) {
      try {
        const r = await session.connect({ host: d });
        say(`adb connect ${d}: ${r[0].text.split('\n')[0]}`);
      } catch (e) {
        say(`adb connect ${d} failed (adb_connect can retry): ${e.message.split('\n')[0]}`);
      }
    }
  })();
}

function rootsText(s, src) {
  if (!s.file_roots.length) return 'none';
  return s.file_roots.join(', ') + (String(src.file_roots).startsWith('default') ? ' (default)' : '');
}

// The start lines that follow the first one: a doubtful Downloads folder.
function startWarnings(loaded) {
  return loaded.downloadsWarning ? [`brickproof-adb: warning: ${loaded.downloadsWarning}`] : [];
}

function settingsLine(loaded, adb) {
  const s = loaded.settings, src = loaded.sources;
  return `allow_shell ${s.allow_shell ? 'ON' : 'off'}, allow_uninstall ${s.allow_uninstall ? 'ON' : 'off'}, ` +
    `file roots ${rootsText(s, src)}, store ${s.store}, ` +
    `adb ${adb.chosen ? `${adb.path} (${adb.source}${adb.chosen.found ? '' : ', missing'})` : 'not found'}`;
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function serveCommand(rest) {
  let opts;
  try {
    opts = parseArgs({
      args: rest,
      options: { port: { type: 'string' }, host: { type: 'string' }, 'token-file': { type: 'string' } },
    }).values;
  } catch (e) {
    return usageError(e.message);
  }
  const flags = { host: opts.host };
  if (opts.port !== undefined) {
    flags.port = Number(opts.port);
    if (!/^\d+$/.test(opts.port) || flags.port > 65535) return usageError('--port must be an integer 0-65535');
  }
  if (opts.host === '') return usageError('--host must not be empty');

  const { resolveToken, connectionLines } = require('./token');
  const loaded = load(flags);
  const s = loaded.settings;
  C.ensureStateDir(s.state_dir);

  let tok;
  try {
    tok = resolveToken({ tokenFile: opts['token-file'], env: process.env, stateDir: s.state_dir });
  } catch (e) {
    if (e.name !== 'TokenError') throw e;
    say(e.message);
    return 1;
  }

  const { adb } = initServer(loaded);
  const H = require('./http');

  let server, localGuards;
  try {
    ({ server, localGuards } = await H.startHttp({
      port: s.port, host: s.host, token: tok.token, allowedHosts: s.allowed_hosts, logRequests: s.log_requests, legacyToken: tok.legacy,
    }));
  } catch (e) {
    say(`cannot listen on ${s.host}:${s.port} (${e.code || e.message})`);
    return 1;
  }

  // One write, so the lines stay together in the log.
  const port = server.address().port;
  const hosts = s.allowed_hosts;
  const hostsSuffix = localGuards && hosts.length ? `, allowed hosts ${hosts.join(', ')}` : '';
  const lines = [`brickproof-adb ${VERSION} on ${s.host}:${port}, ${settingsLine(loaded, adb)}${hostsSuffix}${H.bindNote(localGuards)}`, ...startWarnings(loaded)];
  if (!localGuards && hosts.length)
    lines.push('brickproof-adb: note: allowed_hosts is not used on a non-local bind (there are no Host/Origin checks to relax)');
  if (tok.legacy)
    lines.push(`brickproof-adb: warning: the token from ${tok.source} does not meet the token rules and is accepted only because BRICKPROOF_ALLOW_LEGACY_TOKEN=1 inside Home Assistant; clear the token option and restart to get a generated one, then update the connector`);
  if (tok.generated) {
    const [p, b] = connectionLines(tok.token);
    lines.push(
      `brickproof-adb: new token generated and saved to ${tok.file}`,
      `brickproof-adb: claude.ai connector path: ${p}`,
      `brickproof-adb: Bearer header: ${b}`,
      'brickproof-adb: shown once; `brickproof-adb token` shows it again');
  }
  process.stderr.write(lines.join('\n') + '\n');
  startBackground(s);

  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null;
}

// ---------------------------------------------------------------------------
// stdio (no command)
// ---------------------------------------------------------------------------

async function stdioCommand(args) {
  const option = args.find(a => a.startsWith('-'));
  if (option) return usageError(`unknown option ${option}`);
  // Nothing but the protocol on stdout: a stray console.log goes to stderr.
  console.log = console.error;
  console.info = console.error;
  const loaded = load({ file_roots: args });
  const s = loaded.settings;
  // A state directory that cannot be created does not stop stdio (the tools
  // that need it fail on their own); the client gets its tool list.
  try { C.ensureStateDir(s.state_dir); } catch (e) { say(`warning: ${e.message}`); }
  const { adb } = initServer(loaded);
  const { serveStdio } = require('./stdio');
  const { closed } = serveStdio();
  process.stderr.write([`brickproof-adb ${VERSION} on stdio, ${settingsLine(loaded, adb)}`, ...startWarnings(loaded)].join('\n') + '\n');
  startBackground(s);
  closed.then(() => process.exit(0));
  return null;
}

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

function setCommand(rest) {
  const [key, ...values] = rest;
  if (!key || key.startsWith('-')) return usageError(`set needs a setting name: ${C.SETTABLE.join(', ')}`);
  const target = load({}).writeTarget;
  let r;
  try {
    r = C.writeSetting(target, key, values);
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    say(e.message);
    return 1;
  }
  const now = load({});
  const out = [r.removed
    ? `${key} removed from ${r.file}: the default applies (now ${JSON.stringify(now.settings[key])})`
    : `${key} = ${JSON.stringify(r.value)} written to ${r.file}`];
  const src = now.sources[key];
  if (typeof src === 'string' && (src.startsWith('env ') || src.startsWith('flag')))
    out.push(`warning: ${src} is set and overrides the settings file: the server keeps using ${JSON.stringify(now.settings[key])} until it is removed`);
  out.push('A running server uses the change after a restart (over stdio: restart the client, such as Claude Desktop).');
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// get-adb
// ---------------------------------------------------------------------------

function ask(question) {
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.question(question, a => { answered = true; rl.close(); resolve(a); });
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}

async function getAdbCommand(rest) {
  let opts;
  try {
    opts = parseArgs({ args: rest, options: { 'accept-license': { type: 'boolean' } } }).values;
  } catch (e) {
    return usageError(e.message);
  }
  const PT = require('./platform-tools');
  const refusal = PT.getAdbRefusal();
  if (refusal) { say(refusal); return 1; }
  const s = load({}).settings;
  const url = PT.PLATFORM_ZIP[process.platform];
  const dir = path.join(s.state_dir, 'platform-tools');
  process.stdout.write(`Android SDK Platform-Tools come from Google and are subject to Google's terms:\n  ${PT.LICENSE_URL}\n` +
    `Source: ${url}\nWill be installed into: ${dir}\n`);
  if (!opts['accept-license']) {
    const a = (await ask('Accept the terms and download? [y/N] ')).trim().toLowerCase();
    if (a !== 'y' && a !== 'yes') { process.stdout.write('Nothing was downloaded.\n'); return 1; }
  }
  C.ensureStateDir(s.state_dir);
  let buf;
  try {
    buf = await PT.download(url);
  } catch (e) {
    say(`download failed: ${e.message}. Nothing was changed.`);
    return 1;
  }
  let r;
  try {
    r = PT.installPlatformTools(buf, s.state_dir);
  } catch (e) {
    say(`could not install platform-tools: ${e.message}${e.code === 'EPERM' || e.code === 'EBUSY' ? ' (an adb from that folder may be running: stop it with `adb kill-server` and try again)' : ''}. The previous state was kept.`);
    return 1;
  }
  const v = await require('./adb').adbVersionOf(r.adb);
  process.stdout.write(`Downloaded ${(buf.length / 1048576).toFixed(1)} MB, ${r.files} files.\n` +
    `adb: ${r.adb}${v.ok ? ` — ${v.build || v.protocol}` : ` — does not run (${v.error})`}\n` +
    'brickproof-adb finds it there by itself; restart a running server to use it.\n');
  return v.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

function tokenCommand(rest) {
  let opts;
  try {
    opts = parseArgs({ args: rest, options: { new: { type: 'boolean' } } }).values;
  } catch (e) {
    return usageError(e.message);
  }
  const T = require('./token');
  const s = load({}).settings;
  if (opts.new) {
    C.ensureStateDir(s.state_dir);
    const { token, file } = T.replaceToken(s.state_dir);
    process.stdout.write(T.connectionLines(token).join('\n') + '\n');
    say(`new token saved to ${file}; a running server accepts the old token until it is restarted; every connected client must be updated (connector URL or Bearer header)`);
    if (process.env.BRICKPROOF_TOKEN)
      say('warning: env BRICKPROOF_TOKEN is set and takes precedence over the saved token; unset it for the new one to take effect');
    return 0;
  }
  let tok;
  try {
    tok = T.resolveToken({ env: process.env, stateDir: s.state_dir, generate: false });
  } catch (e) {
    if (e.name !== 'TokenError') throw e;
    say(e.message);
    return 1;
  }
  process.stdout.write(T.connectionLines(tok.token).join('\n') + '\n');
  return 0;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

// "exists, writable" / "missing" / "not a directory" / "will be created".
function dirState(dir, { mayCreate = false } = {}) {
  let st;
  try { st = fs.statSync(dir); } catch { st = null; }
  if (!st) {
    if (!mayCreate) return { ok: false, text: 'missing' };
    let up = path.dirname(dir);
    while (up !== path.dirname(up) && !fs.existsSync(up)) up = path.dirname(up);
    try { fs.accessSync(up, fs.constants.W_OK); return { ok: true, text: 'will be created' }; }
    catch { return { ok: false, text: `cannot be created (${up} is not writable)` }; }
  }
  if (!st.isDirectory()) return { ok: false, text: 'not a directory' };
  try { fs.accessSync(dir, fs.constants.W_OK); return { ok: true, text: 'directory, writable' }; }
  catch { return { ok: false, text: 'directory, NOT writable' }; }
}

// The image pipeline on generated frames: the very function adb_screenshot
// uses (image.processFrame), not a copy of it.
async function imageSmoke() {
  const I = require('./image');
  const A = require('./adb');
  const cases = [
    { W: 3840, H: 2160, w: 1024, h: 576, dark: false, fill: (x, y, W, H) => [x * 255 / W | 0, y * 255 / H | 0, 128] },
    { W: 1080, H: 2400, w: 461, h: 1024, dark: false, fill: (x, y, W, H) => [(x + y) % 256, x * 255 / W | 0, y * 255 / H | 0] },
    { W: 1080, H: 2340, w: 473, h: 1024, dark: true, fill: () => [0, 0, 0] },
  ];
  const dir = A.makeTempDir('check-');
  const lines = [], problems = [];
  try {
    for (const c of cases) {
      const file = path.join(dir, `${c.W}x${c.H}.png`);
      fs.writeFileSync(file, I.makePng(c.W, c.H, (x, y) => c.fill(x, y, c.W, c.H)));
      const t0 = Date.now();
      try {
        const r = await I.processFrame(file, 1024, 70);
        const ms = Date.now() - t0;
        const dark = I.isDark(r.mean, r.sd);
        const ok = r.W === c.W && r.H === c.H && r.w === c.w && r.h === c.h && dark === c.dark && r.jpeg[0] === 0xff && r.jpeg[1] === 0xd8;
        lines.push(`  ${c.W}x${c.H} -> ${r.w}x${r.h} in ${ms} ms, JPEG ${r.jpeg.length} bytes, mean ${r.mean.toFixed(3)} sd ${r.sd.toFixed(3)}${dark ? ' (dark)' : ''}${ok ? '' : ' — UNEXPECTED'}`);
        if (!ok) problems.push(`image pipeline: ${c.W}x${c.H} gave ${r.w}x${r.h}, dark ${dark}; expected ${c.w}x${c.h}, dark ${c.dark}`);
      } catch (e) {
        lines.push(`  ${c.W}x${c.H}: FAILED (${e.message})`);
        problems.push(`image pipeline: ${c.W}x${c.H}: ${e.message}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { lines, problems };
}

async function checkCommand(rest) {
  let opts;
  try {
    opts = parseArgs({ args: rest, options: { offline: { type: 'boolean' } } }).values;
  } catch (e) {
    return usageError(e.message);
  }
  const problems = [], warnings = [];
  const out = [`brickproof-adb ${VERSION} (node ${process.versions.node}, pngjs ${PNGJS_VERSION}, jpeg-js ${JPEG_JS_VERSION}, ${process.platform}-${process.arch})`];
  const loaded = load({});
  const s = loaded.settings, src = loaded.sources;
  out.push(`settings file: ${loaded.file ? `${loaded.file} (${loaded.fileSource})` : `none (\`brickproof-adb set\` writes ${loaded.writeTarget})`}`);
  if (loaded.settingsUi) out.push(`settings are changed in: ${loaded.settingsUi}`);

  const sd = dirState(s.state_dir, { mayCreate: true });
  if (!sd.ok) problems.push(`state_dir ${s.state_dir}: ${sd.text}`);
  out.push(`state_dir: ${s.state_dir} (${src.state_dir}) — ${sd.text}`);
  const st = dirState(s.store, { mayCreate: true });
  if (!st.ok) problems.push(`store ${s.store}: ${st.text}`);
  out.push(`store: ${s.store} (${src.store}) — ${st.text}`);

  if (!s.file_roots.length) out.push(`file_roots: none (${src.file_roots}) — adb_push, adb_pull and adb_install refuse until it is set`);
  else {
    out.push(`file_roots (${src.file_roots}):`);
    for (const r of s.file_roots) {
      const d = dirState(r);
      if (!d.ok) problems.push(`file_root ${r}: ${d.text}`);
      out.push(`  ${r} — ${d.text}`);
    }
  }
  out.push(`allow_shell: ${s.allow_shell} (${src.allow_shell}), allow_uninstall: ${s.allow_uninstall} (${src.allow_uninstall}), log_requests: ${s.log_requests} (${src.log_requests})`);
  const known = require('./session');
  known.configure({ stateDir: s.state_dir });
  const remembered = known.readKnown();
  out.push(`devices connected at start: ${s.devices.length ? s.devices.join(', ') : 'none'} (settings), ${remembered.length ? remembered.join(', ') : 'none'} (remembered)`);
  out.push(`scan_subnets: ${s.scan_subnets.length ? s.scan_subnets.join(', ') : 'none (the private /24 networks of this computer)'}`);
  out.push(`serve: ${s.host}:${s.port}`);

  const T = require('./token');
  try {
    const tok = T.resolveToken({ env: process.env, stateDir: s.state_dir, generate: false });
    out.push(`token: ${tok.source}${tok.legacy ? ' (legacy, accepted inside Home Assistant only)' : ''}`);
  } catch (e) {
    if (e.name !== 'TokenError') throw e;
    if (/^no token yet/.test(e.message)) out.push('token: none yet (generated on the first `brickproof-adb serve`; stdio needs none)');
    else { problems.push(e.message); out.push('token: invalid'); }
  }

  // Every adb on the machine with its version; the one in use first found.
  const A = require('./adb');
  const PT = require('./platform-tools');
  const found = PT.resolveAdbPath(s, src);
  A.configure({ adbPath: found.path });
  out.push('adb:');
  const builds = new Set();
  let adbOk = false;
  for (const p of found.places.filter(x => x.found)) {
    const v = await A.adbVersionOf(p.path);
    const used = found.chosen && p.path === found.chosen.path;
    if (v.ok) builds.add(v.build || v.protocol);
    if (used) adbOk = v.ok;
    out.push(`  ${used ? '*' : ' '} ${p.path} (${p.source}) — ${v.ok ? `${v.build || '?'} (protocol ${v.protocol || '?'})` : `does not run (${v.error})`}${used ? '  ← used' : ''}`);
  }
  if (!found.chosen) {
    out.push(`  none found; looked in: ${PT.lookedIn(found).join(', ')}`);
    problems.push(`adb was not found. ${A.installHint()}`);
  } else if (!found.chosen.found) {
    out.push(`  * ${found.chosen.path} (${found.chosen.source}) — does not exist  ← used`);
    problems.push(`adb_path ${found.chosen.path} does not exist or cannot be run. ${A.installHint()}`);
  } else if (!adbOk) {
    problems.push(`the adb in use (${found.chosen.path}) does not run`);
  }
  if (builds.size > 1)
    warnings.push(`${builds.size} different adb versions on this machine (${[...builds].join(', ')}): two different adb restart each other's adb server, and network devices drop. Use one for everything (set adb_path).`);

  out.push('image pipeline:');
  const img = await imageSmoke();
  out.push(...img.lines);
  problems.push(...img.problems);

  if (!opts.offline && adbOk) {
    out.push('devices:');
    try {
      const d = await A.adb(['devices', '-l'], { timeout: 15000, withStderr: true });
      for (const l of String(d.stdout).split('\n').map(x => x.trimEnd()).filter(Boolean)) out.push(`  ${l}`);
      const w = A.foreignAdbWarning(d.stderr);
      if (w) out.push(`  ${w}`);
    } catch (e) {
      problems.push(`adb devices failed: ${e.message}`);
    }
  }

  if (warnings.length) out.push(`\nwarnings:\n  ${warnings.join('\n  ')}`);
  out.push(problems.length ? `\nproblems:\n  ${problems.join('\n  ')}` : '\nok');
  process.stdout.write(out.join('\n') + '\n');
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------------------

async function main(rawArgv) {
  // A launcher may leave an empty or unresolved placeholder for a form field
  // that was not filled in (a desktop extension's folders): not an argument.
  const argv = rawArgv.filter(a => a !== '' && !/^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(a));
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') { process.stdout.write(VERSION + '\n'); return 0; }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { process.stdout.write(USAGE); return 0; }

  try {
    if (cmd === 'serve') return await serveCommand(rest);
    if (cmd === 'set') return setCommand(rest);
    if (cmd === 'get-adb') return await getAdbCommand(rest);
    if (cmd === 'token') return tokenCommand(rest);
    if (cmd === 'check') return await checkCommand(rest);
    // No command, or folders: stdio. A word that is neither a command nor a
    // path is a mistake, not a folder.
    if (cmd === undefined || argv.every(a => !a.startsWith('-') && /[\\/]|^\.{1,2}$/.test(a)) || cmd.startsWith('-'))
      return await stdioCommand(argv);
  } catch (e) {
    if (e.name !== 'ConfigError') throw e;
    say(e.message);
    return 1;
  }
  return usageError(`unknown command "${cmd}"`);
}

/** Run main() and set the exit code; main.js calls it. */
function run(argv) {
  return main(argv).then(
    code => { if (code !== null) process.exitCode = code; },
    err => { say(err && err.stack || String(err)); process.exitCode = 1; },
  );
}

module.exports = { main, run, USAGE };
