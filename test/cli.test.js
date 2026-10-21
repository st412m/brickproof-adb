'use strict';
// The CLI as a user runs it: --version, check --offline, token, serve.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('../src/config.js');
const { tmpDir, CLI, isolatedEnv } = require('./helpers.js');

const VERSION = require('../package.json').version;

function runCli(args, env) {
  return new Promise(resolve => {
    execFile(process.execPath, [CLI, ...args], { env, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
}

test('--version and --help', async () => {
  const home = tmpDir();
  const v = await runCli(['--version'], isolatedEnv(home));
  assert.equal(v.stdout, `${VERSION}\n`);
  const h = await runCli(['--help'], isolatedEnv(home));
  assert.match(h.stdout, /brickproof-adb check \[--offline\]/);
  const bad = await runCli(['nope'], isolatedEnv(home));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown command "nope"/);
});

test('check --offline without adb: the image pipeline runs, adb is a problem, exit 1', async () => {
  const home = tmpDir();
  const r = await runCli(['check', '--offline'], isolatedEnv(home));
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^brickproof-adb \d+\.\d+\.\d+ \(node /);
  assert.match(r.stdout, /\n {2}3840x2160 -> 1024x576 in \d+ ms, JPEG \d+ bytes, mean 0\.\d{3} sd 0\.\d{3}\n/);
  assert.match(r.stdout, /\n {2}1080x2400 -> 461x1024 in \d+ ms/);
  assert.match(r.stdout, /\n {2}1080x2340 -> 473x1024 in \d+ ms, .* \(dark\)\n/);
  assert.match(r.stdout, /problems:\n {2}adb_path .* does not exist or cannot be run\. Run `brickproof-adb get-adb`/);
  assert.ok(!/devices:/.test(r.stdout), 'no device listing with --offline');
  const want = expectedDefault(home, r.stdout);
  if (want.dir) assert.ok(r.stdout.includes(`file_roots (${want.source}):\n  ${want.dir} — `), r.stdout);
  else if (want.dir === null) assert.ok(r.stdout.includes(`file_roots: none (${want.source}) — adb_push, adb_pull and adb_install refuse until it is set`), r.stdout);
  assert.match(r.stdout, /\nstore: .* \(default: <state_dir>\/snapshots\) — /);
});

/**
 * What the CLI started in this test home should take as the default file
 * root: { dir, source }. On Windows the registry may name a folder outside
 * the home (a moved Downloads folder). A registry read that failed in the
 * child must be said in `out`, with its reason; then <home>\Downloads is the
 * fallback. dir undefined: the child read the registry and this test's own
 * read failed, so the folder cannot be compared.
 */
function expectedDefault(home, out) {
  const fallback = path.join(home, 'Downloads');
  const failed = /the registry could not be read: (.+?); (.+?) (used|not found)/.exec(out);
  if (failed) {
    assert.match(failed[1], /^(timed out after 15 s|powershell\.exe .+)$/, 'the reason');
    assert.equal(failed[2], fallback);
    const used = failed[3] === 'used';
    return { dir: used ? fallback : null, source: `default: the registry could not be read: ${failed[1]}; ${fallback} ${failed[3]}` };
  }
  const own = C.findDownloads({ env: isolatedEnv(home), homedir: home });
  if (own.registryError) return { dir: undefined };
  return own.dir ? { dir: own.dir, source: 'default' } : { dir: null, source: 'default: no Downloads folder found' };
}

test('check: a missing file root is a problem', async () => {
  const home = tmpDir();
  const r = await runCli(['check', '--offline'], isolatedEnv(home, { BRICKPROOF_FILE_ROOTS: path.join(home, 'nope') }));
  assert.match(r.stdout, /file_root .*nope: missing/);
});

test('a bad config stops the start with the list of problems', async () => {
  const home = tmpDir();
  const cfg = path.join(home, 'c.json');
  fs.writeFileSync(cfg, JSON.stringify({ allow_shell: 'yes', nope: 1 }));
  const r = await runCli(['check'], isolatedEnv(home, { BRICKPROOF_CONFIG: cfg }));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid config\n {2}unknown key "nope"\n {2}"allow_shell" must be true or false/);
});

test('token: none yet, --new prints the two lines, then token shows them', async () => {
  const home = tmpDir();
  const env = isolatedEnv(home);
  const none = await runCli(['token'], env);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no token yet/);
  const n = await runCli(['token', '--new'], env);
  assert.equal(n.code, 0);
  const lines = n.stdout.trim().split('\n');
  assert.match(lines[0], /^\/private_[0-9a-f]{64}\/mcp$/);
  assert.match(lines[1], /^Authorization: Bearer [0-9a-f]{64}$/);
  const again = await runCli(['token'], env);
  assert.equal(again.stdout, n.stdout);
  const { stateDir } = C.platformDirs({ env, homedir: home });
  assert.ok(fs.existsSync(path.join(stateDir, 'token')));
});

test('serve: generates a token, answers on the secret path, stops on SIGTERM', async () => {
  const home = tmpDir();
  const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { env: isolatedEnv(home) });
  let stderr = '';
  const ready = new Promise((resolve, reject) => {
    child.stderr.on('data', c => {
      stderr += c;
      if (/shown once/.test(stderr)) resolve();
    });
    child.on('exit', code => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  await ready;
  const port = /on 127\.0\.0\.1:(\d+),/.exec(stderr)[1];
  const p = /claude\.ai connector path: (\/private_[0-9a-f]{64}\/mcp)/.exec(stderr)[1];
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.tools.length, 18);
  assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })).status, 404);
  child.removeAllListeners('exit');
  const exited = new Promise(r2 => child.on('exit', r2));
  child.kill('SIGTERM');
  await exited;
  assert.match(stderr, new RegExp(`^brickproof-adb ${VERSION.replace(/\./g, '\\.')} on 127\\.0\\.0\\.1:\\d+, allow_shell off`, 'm'));
});

test('set: writes the settings file, says where and that a restart is needed; warns when env overrides', async () => {
  const home = tmpDir();
  const env = isolatedEnv(home);
  const { configDir } = C.platformDirs({ env, homedir: home });
  const file = path.join(configDir, 'config.json');
  const on = await runCli(['set', 'allow_shell', 'on'], env);
  assert.equal(on.code, 0, on.stderr);
  assert.equal(on.stdout, `allow_shell = true written to ${file}\nA running server uses the change after a restart (over stdio: restart the client, such as Claude Desktop).\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { allow_shell: true });

  const over = await runCli(['set', 'allow_uninstall', 'on'], { ...env, BRICKPROOF_ALLOW_UNINSTALL: 'false' });
  assert.match(over.stdout, /\nwarning: env BRICKPROOF_ALLOW_UNINSTALL is set and overrides the settings file: the server keeps using false until it is removed\n/);

  const back = await runCli(['set', 'allow_shell'], env);
  assert.match(back.stdout, /^allow_shell removed from .*config\.json: the default applies \(now false\)\n/);
  const bad = await runCli(['set', 'allow_shell', 'yes'], env);
  assert.equal(bad.code, 1);
  assert.equal(bad.stderr, 'brickproof-adb: allow_shell takes on or off, got "yes"\n');
  const roots = await runCli(['set', 'file_roots', path.join(home, 'a'), path.join(home, 'b')], env);
  assert.match(roots.stdout, /^file_roots = \[.*\] written to/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).file_roots, [path.join(home, 'a'), path.join(home, 'b')]);
});

test('stdio takes folders as file_roots; the downloads folder is the default; the start line says which', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'Downloads'));
  const start = async (args, extra = {}) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: isolatedEnv(home, extra) });
    let stderr = '';
    child.stderr.on('data', c => (stderr += c));
    child.stdin.end();
    await new Promise(r => child.on('exit', r));
    return stderr;
  };
  const first = await start([]);
  const want = expectedDefault(home, first);
  if (want.dir) assert.ok(first.includes(`file roots ${want.dir} (default)`), first);
  if (want.source && want.source.includes('registry')) assert.match(first, /\nbrickproof-adb: warning: the Downloads folder is uncertain: the registry could not be read: /);
  const dir = path.join(home, 'phone files');
  assert.match(await start([dir, '${user_config.file_roots}', '']), new RegExp(`file roots ${dir.replace(/[\\.]/g, '\\$&')}, store`));
  assert.match(await start([], { BRICKPROOF_FILE_ROOTS: '' }), /file roots none, store/);
  const r = await runCli(['nope-not-a-folder'], isolatedEnv(home));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command "nope-not-a-folder"/);
});

test('.mcpb: an empty file_roots field passes no folder, so the Downloads default applies', async () => {
  const manifest = require('../manifest.json');
  assert.equal(manifest.user_config.file_roots.default, undefined, 'no default in the form');
  const { args, env: menv } = manifest.server.mcp_config;
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'Downloads'));
  const root = path.resolve(__dirname, '..');
  // How a launcher may render an empty field: the placeholder left as it is,
  // an empty string, or no argument at all.
  for (const empty of [x => x, () => '', () => null]) {
    const argv = args.map(a => a.replace('${__dirname}', root)).map(a => (a.includes('${user_config.') ? empty(a) : a)).filter(a => a !== null);
    const env = isolatedEnv(home, Object.fromEntries(Object.entries(menv).filter(([k]) => k !== 'BRICKPROOF_SETTINGS_UI').map(([k, v]) => [k, empty(v) ?? ''])));
    const child = spawn(process.execPath, argv, { env });
    let stderr = '';
    child.stderr.on('data', c => (stderr += c));
    child.stdin.end();
    await new Promise(r => child.on('exit', r));
    const want = expectedDefault(home, stderr);
    assert.ok(want.dir === undefined || stderr.includes(`file roots ${want.dir} (default)`), `${JSON.stringify(argv.slice(1))}: ${stderr}`);
    assert.ok(!/file roots none/.test(stderr), 'a folder that exists in the home is always found');
  }
});

test('check without any adb: the places looked in name PATH', async () => {
  const home = tmpDir();
  const r = await runCli(['check', '--offline'], isolatedEnv(home, { BRICKPROOF_ADB: '', BRICKPROOF_FILE_ROOTS: '' }));
  assert.match(r.stdout, /\n {2}none found; looked in: \S.*platform-tools.adb(\.exe)?, PATH \(no adb there\), /);
});

test('check lists the settings file target and every adb looked for', async () => {
  const home = tmpDir();
  const r = await runCli(['check', '--offline'], isolatedEnv(home, { BRICKPROOF_SETTINGS_UI: 'the app options in Home Assistant' }));
  assert.match(r.stdout, /\nsettings file: none \(`brickproof-adb set` writes .*config\.json\)\n/);
  assert.match(r.stdout, /\nsettings are changed in: the app options in Home Assistant\n/);
  assert.match(r.stdout, /\nadb:\n {2}\* .*no-adb-here.*\(adb_path \(env BRICKPROOF_ADB\)\) — does not exist {2}← used\n/);
});
