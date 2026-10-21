'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../src/config.js');
const { tmpDir, writeJson } = require('./helpers.js');

// An absolute path on this platform.
const abs = (...p) => path.resolve(path.sep, ...p);

test('settings directories per OS', () => {
  assert.deepEqual(C.platformDirs({ platform: 'linux', env: {}, homedir: '/home/me' }),
    { configDir: '/home/me/.config/brickproof-adb', stateDir: '/home/me/.local/state/brickproof-adb' });
  assert.deepEqual(C.platformDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/conf', XDG_STATE_HOME: '/x/state' }, homedir: '/home/me' }),
    { configDir: '/x/conf/brickproof-adb', stateDir: '/x/state/brickproof-adb' });
  assert.deepEqual(C.platformDirs({ platform: 'linux', env: { XDG_CONFIG_HOME: 'relative' }, homedir: '/home/me' }).configDir,
    '/home/me/.config/brickproof-adb', 'a relative XDG value is ignored');
  assert.deepEqual(C.platformDirs({ platform: 'darwin', env: {}, homedir: '/Users/me' }), {
    configDir: '/Users/me/Library/Application Support/brickproof-adb',
    stateDir: '/Users/me/Library/Application Support/brickproof-adb',
  });
  assert.deepEqual(C.platformDirs({ platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, homedir: 'C:\\Users\\me' }), {
    configDir: 'C:\\Users\\me\\AppData\\Roaming\\brickproof-adb',
    stateDir: 'C:\\Users\\me\\AppData\\Local\\brickproof-adb',
  });
  assert.deepEqual(C.platformDirs({ platform: 'win32', env: {}, homedir: 'C:\\Users\\me' }), {
    configDir: 'C:\\Users\\me\\AppData\\Roaming\\brickproof-adb',
    stateDir: 'C:\\Users\\me\\AppData\\Local\\brickproof-adb',
  });
});

// loadConfig with a home that has no config file, so only what the test passes
// counts; the registry of the machine running the tests is not read.
function load(home, env = {}, flags = {}) {
  return C.loadConfig({ env: { HOME: home, ...env }, homedir: home, flags, cwd: home, shellFolders: () => null });
}

test('defaults: shell and uninstall off, no file roots, store under state_dir, adb from PATH', () => {
  const home = tmpDir();
  const { settings: s, sources } = load(home);
  const dirs = C.platformDirs({ env: { HOME: home }, homedir: home });
  assert.equal(s.port, 3200);
  assert.equal(s.host, '127.0.0.1');
  assert.equal(s.allow_shell, false);
  assert.equal(s.allow_uninstall, false);
  assert.equal(s.log_requests, false);
  assert.deepEqual(s.devices, []);
  assert.deepEqual(s.file_roots, []);
  assert.deepEqual(s.allowed_hosts, []);
  assert.equal(s.state_dir, dirs.stateDir);
  assert.equal(s.store, path.join(dirs.stateDir, 'snapshots'));
  assert.equal(s.adb_path, 'adb');
  assert.equal(sources.store, 'default: <state_dir>/snapshots');
});

test('order: flags > env > file > defaults', () => {
  const home = tmpDir();
  const file = writeJson(path.join(home, 'c.json'), {
    port: 3300, host: '0.0.0.0', allow_shell: true, allow_uninstall: true, log_requests: true,
    devices: ['192.0.2.5'], file_roots: [abs('srv', 'a')], store: abs('srv', 'store'), state_dir: abs('srv', 'state'), adb_path: abs('opt', 'adb'),
  });
  const fromFile = load(home, { BRICKPROOF_CONFIG: file }).settings;
  assert.equal(fromFile.port, 3300);
  assert.equal(fromFile.allow_shell, true);
  assert.deepEqual(fromFile.devices, ['192.0.2.5']);
  assert.deepEqual(fromFile.file_roots, [abs('srv', 'a')]);
  assert.equal(fromFile.store, abs('srv', 'store'));
  assert.equal(fromFile.state_dir, abs('srv', 'state'));
  assert.equal(fromFile.adb_path, abs('opt', 'adb'));

  const env = {
    BRICKPROOF_CONFIG: file, BRICKPROOF_ALLOW_SHELL: 'false', BRICKPROOF_ALLOW_UNINSTALL: '0', BRICKPROOF_LOG_REQUESTS: 'false',
    BRICKPROOF_DEVICES: '192.0.2.6:5555, 192.0.2.7', BRICKPROOF_FILE_ROOTS: [abs('b'), abs('c')].join(path.delimiter),
    BRICKPROOF_STORE: abs('env-store'), BRICKPROOF_STATE_DIR: abs('env-state'), BRICKPROOF_ADB: abs('env', 'adb'),
  };
  const { settings: s, sources } = load(home, env, { port: 4000 });
  assert.equal(s.port, 4000);
  assert.equal(sources.port, 'flag --port');
  assert.equal(s.host, '0.0.0.0', 'host only from flag or file');
  assert.equal(s.allow_shell, false);
  assert.equal(sources.allow_shell, 'env BRICKPROOF_ALLOW_SHELL');
  assert.equal(s.allow_uninstall, false);
  assert.equal(s.log_requests, false);
  assert.deepEqual(s.devices, ['192.0.2.6:5555', '192.0.2.7']);
  assert.deepEqual(s.file_roots, [abs('b'), abs('c')]);
  assert.equal(s.store, abs('env-store'));
  assert.equal(s.state_dir, abs('env-state'));
  assert.equal(s.adb_path, abs('env', 'adb'));
});

test('store defaults to <state_dir>/snapshots of whatever state_dir is in force', () => {
  const home = tmpDir();
  assert.equal(load(home, { BRICKPROOF_STATE_DIR: abs('st') }).settings.store, path.join(abs('st'), 'snapshots'));
});

test('lists in the environment: devices by commas and/or spaces, file roots by path.delimiter, empty items dropped', () => {
  assert.deepEqual(C.splitDevices('192.0.2.5:5555,192.0.2.6  192.0.2.7:40001 ,, '), ['192.0.2.5:5555', '192.0.2.6', '192.0.2.7:40001']);
  assert.deepEqual(C.splitRoots('/a::/b:', ':'), ['/a', '/b']);
  assert.deepEqual(C.splitRoots('C:\\a;;D:\\b;', ';'), ['C:\\a', 'D:\\b']);
  const home = tmpDir();
  assert.throws(() => load(home, { BRICKPROOF_FILE_ROOTS: 'relative/dir' }), /env BRICKPROOF_FILE_ROOTS: every entry must be an absolute path/);
});

test('booleans in the environment: true/1, false/0, anything else is an error', () => {
  assert.equal(C.envBool({ X: 'TRUE' }, 'X'), true);
  assert.equal(C.envBool({ X: '1' }, 'X'), true);
  assert.equal(C.envBool({ X: 'false' }, 'X'), false);
  assert.equal(C.envBool({ X: '0' }, 'X'), false);
  assert.equal(C.envBool({ X: '' }, 'X'), undefined);
  assert.throws(() => C.envBool({ X: 'yes' }, 'X'), /env X must be true or false \(or 1 \/ 0\), got "yes"/);
});

test('a relative adb_path is resolved, a bare name is left for PATH', () => {
  const home = tmpDir();
  assert.equal(load(home, { BRICKPROOF_ADB: 'adb.exe' }).settings.adb_path, 'adb.exe');
  assert.equal(load(home, { BRICKPROOF_ADB: path.join('tools', 'adb') }).settings.adb_path, path.join(home, 'tools', 'adb'));
});

test('file errors: missing BRICKPROOF_CONFIG, bad JSON with a position, unknown keys and bad values listed', () => {
  const home = tmpDir();
  assert.throws(() => load(home, { BRICKPROOF_CONFIG: path.join(home, 'nope.json') }), /config file from env BRICKPROOF_CONFIG not found/);
  const bad = path.join(home, 'bad.json');
  fs.writeFileSync(bad, '{\n  "port": 1,\n  oops\n}');
  assert.throws(() => load(home, { BRICKPROOF_CONFIG: bad }), /bad\.json: not valid JSON at line 3/);
  const wrong = writeJson(path.join(home, 'wrong.json'), {
    vault: '/x', allow_shell: 'yes', devices: ['192.0.2.5 192.0.2.6'], file_roots: ['rel'], port: 70000, store: 'rel', allowed_hosts: ['h:1'],
  });
  assert.throws(() => load(home, { BRICKPROOF_CONFIG: wrong }), err => {
    for (const s of ['unknown key "vault"', '"allow_shell" must be true or false', '"devices": "192.0.2.5 192.0.2.6" must be one host',
      '"file_roots": "rel" must be an absolute path', '"port" must be an integer 0-65535', '"store" must be an absolute path',
      '"allowed_hosts": "h:1" must be a host name without a port'])
      assert.ok(err.message.includes(s), `${s}\n${err.message}`);
    return err.name === 'ConfigError';
  });
});

test('the config file in the config directory is found without BRICKPROOF_CONFIG', () => {
  const home = tmpDir();
  const { configDir } = C.platformDirs({ env: { HOME: home }, homedir: home });
  writeJson(path.join(configDir, 'config.json'), { allow_shell: true, $comment: 'x' });
  const r = load(home);
  assert.equal(r.settings.allow_shell, true);
  assert.equal(r.file, path.join(configDir, 'config.json'));
});

// ------------------------------------------------------------ file_roots default

test('file_roots default: the downloads folder, only when no source sets file_roots and it exists', () => {
  const home = tmpDir();
  const dl = path.join(home, 'Downloads');
  fs.mkdirSync(dl);
  const r = load(home);
  assert.deepEqual(r.settings.file_roots, [dl]);
  assert.equal(r.sources.file_roots, 'default');
  // set to nothing (an empty value counts as set)
  assert.deepEqual(load(home, { BRICKPROOF_FILE_ROOTS: '' }).settings.file_roots, []);
  assert.equal(load(home, { BRICKPROOF_FILE_ROOTS: '' }).sources.file_roots, 'env BRICKPROOF_FILE_ROOTS');
  // set elsewhere
  assert.deepEqual(load(home, { BRICKPROOF_FILE_ROOTS: abs('x') }).settings.file_roots, [abs('x')]);
  assert.deepEqual(load(home, {}, { file_roots: [abs('y')] }).settings.file_roots, [abs('y')]);
  assert.equal(load(home, {}, { file_roots: [abs('y')] }).sources.file_roots, 'arguments');
  // no downloads folder: none
  const bare = tmpDir();
  assert.deepEqual(load(bare).settings.file_roots, []);
  assert.equal(load(bare).sources.file_roots, 'default: no Downloads folder found');
});

test('downloadsDir per OS; Linux reads XDG_DOWNLOAD_DIR from user-dirs.dirs', () => {
  const yes = () => true;
  assert.equal(C.downloadsDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\me', isDir: yes, shellFolders: () => null }), 'C:\\Users\\me\\Downloads');
  assert.equal(C.downloadsDir({ platform: 'darwin', env: {}, homedir: '/Users/me', isDir: yes }), '/Users/me/Downloads');
  assert.equal(C.downloadsDir({ platform: 'darwin', env: {}, homedir: '/Users/me', isDir: () => false }), null);
  const files = {};
  const readFile = p => { if (files[p] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p]; };
  const linux = (env = {}) => C.downloadsDir({ platform: 'linux', env, homedir: '/home/me', isDir: yes, readFile });
  assert.equal(linux(), '/home/me/Downloads', 'no user-dirs.dirs');
  files['/home/me/.config/user-dirs.dirs'] = '# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/Рабочий стол"\nXDG_DOWNLOAD_DIR="$HOME/Загрузки"\n';
  assert.equal(linux(), '/home/me/Загрузки');
  assert.equal(linux({ XDG_DOWNLOAD_DIR: '/data/dl' }), '/data/dl');
  files['/x/conf/user-dirs.dirs'] = 'XDG_DOWNLOAD_DIR="/srv/in"\n';
  assert.equal(linux({ XDG_CONFIG_HOME: '/x/conf' }), '/srv/in', 'user-dirs.dirs of XDG_CONFIG_HOME');
  files['/home/me/.config/user-dirs.dirs'] = 'XDG_DOWNLOAD_DIR="$HOME/"\n';
  assert.equal(linux(), '/home/me/Downloads', '$HOME itself means none: ~/Downloads');
  assert.equal(C.downloadsDir({ platform: 'linux', env: {}, homedir: '/home/me', isDir: () => false, readFile }), null);
});

// What the registry script prints for a value: base64 of its UTF-16 text.
const b64 = s => Buffer.from(s, 'utf16le').toString('base64');

test('Windows registry output: base64 of UTF-16 per line, "-" for none; non-ASCII intact', () => {
  assert.deepEqual(C.parseShellFolders(`${b64('%USERPROFILE%\\Downloads')}\r\n${b64('C:\\Users\\me\\Downloads')}\r\n`),
    { user: '%USERPROFILE%\\Downloads', shell: 'C:\\Users\\me\\Downloads' });
  assert.deepEqual(C.parseShellFolders(`${b64('D:\\Загрузки')}\n-\n`), { user: 'D:\\Загрузки', shell: null });
  assert.deepEqual(C.parseShellFolders('-\n-\n'), { user: null, shell: null });
  assert.deepEqual(C.parseShellFolders(''), { user: null, shell: null });
  assert.deepEqual(C.parseShellFolders('not base64!\nQQ==\n'), { user: null, shell: null }, 'garbage and an odd byte count are no value');
});

test('Windows %VAR% expansion: any case, unknown names stay', () => {
  const env = { USERPROFILE: 'C:\\Users\\me', OneDrive: 'E:\\Облако' };
  assert.equal(C.expandWindowsEnv('%USERPROFILE%\\Downloads', env), 'C:\\Users\\me\\Downloads');
  assert.equal(C.expandWindowsEnv('%userprofile%\\Downloads', env), 'C:\\Users\\me\\Downloads');
  assert.equal(C.expandWindowsEnv('%ONEDRIVE%\\Загрузки', env), 'E:\\Облако\\Загрузки');
  assert.equal(C.expandWindowsEnv('%NOPE%\\Downloads', env), '%NOPE%\\Downloads');
  assert.equal(C.expandWindowsEnv('D:\\Downloads', env), 'D:\\Downloads');
});

test('Windows downloadsDir: User Shell Folders, then Shell Folders, then <home>\\Downloads, the first directory', () => {
  const env = { USERPROFILE: 'C:\\Users\\me' };
  const dl = (sf, dirs) => C.downloadsDir({ platform: 'win32', env, homedir: 'C:\\Users\\me', isDir: p => dirs.includes(p), shellFolders: () => sf });
  const home = 'C:\\Users\\me\\Downloads';
  assert.equal(dl({ user: 'D:\\Загрузки', shell: 'D:\\Загрузки' }, ['D:\\Загрузки', home]), 'D:\\Загрузки', 'a moved folder wins over <home>\\Downloads');
  assert.equal(dl({ user: '%USERPROFILE%\\Downloads', shell: null }, [home]), home, '%USERPROFILE% expanded');
  assert.equal(dl({ user: 'E:\\gone', shell: 'D:\\Downloads' }, ['D:\\Downloads', home]), 'D:\\Downloads', 'User Shell Folders missing on disk: Shell Folders');
  assert.equal(dl({ user: 'relative\\dl', shell: null }, ['relative\\dl', home]), home, 'not absolute: ignored');
  assert.equal(dl(null, [home]), home, 'the registry cannot be read: <home>\\Downloads');
  assert.equal(dl({ user: null, shell: null }, [home]), home);
  assert.equal(dl(null, []), null, 'no directory: no default');
  let asked = 0;
  C.downloadsDir({ platform: 'darwin', env: {}, homedir: '/Users/me', isDir: () => true, shellFolders: () => { asked++; return null; } });
  C.loadConfig({ env: { HOME: tmpDir(), BRICKPROOF_FILE_ROOTS: '' }, homedir: tmpDir(), platform: 'win32', shellFolders: () => { asked++; return null; } });
  assert.equal(asked, 0, 'only on Windows and only when file_roots is not set');
});

test('Windows PowerShell transport: a non-ASCII path comes back intact', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  // The limit of the start itself (REGISTRY_TIMEOUT_MS).
  const r = C.runPowerShellResult("[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('D:\\Загрузки\\Ünïcødé'))\n'-'");
  assert.equal(r.error, undefined, 'powershell.exe ran');
  assert.deepEqual(C.parseShellFolders(r.stdout), { user: 'D:\\Загрузки\\Ünïcødé', shell: null });
  const real = C.readShellFolders();
  assert.ok(typeof real.error === 'string' || ('user' in real && 'shell' in real), 'the real registry read never throws');
  assert.equal(C.REGISTRY_TIMEOUT_MS, 15000);
  const slow = C.runPowerShellResult('Start-Sleep -Seconds 5', { timeout: 50 });
  assert.equal(slow.error, 'timed out after 0.05 s', 'a timeout names itself');
});

test('a registry read that failed is said: in the source of file_roots and in a warning for the start', () => {
  const home = tmpDir();
  const dl = path.join(home, 'Downloads');
  const load = (extra = {}) => C.loadConfig({ env: { HOME: home }, homedir: home, cwd: home, platform: 'win32',
    shellFolders: () => ({ error: 'timed out after 15 s' }), ...extra });
  const none = load();
  assert.deepEqual(none.settings.file_roots, []);
  assert.equal(none.sources.file_roots, `default: the registry could not be read: timed out after 15 s; ${path.win32.join(home, 'Downloads')} not found`);
  assert.equal(none.downloadsWarning, `the Downloads folder is uncertain: the registry could not be read: timed out after 15 s; ${path.win32.join(home, 'Downloads')} not found; set file_roots to choose the folder`);
  fs.mkdirSync(dl);
  const used = load({ isDir: p => p === path.win32.join(home, 'Downloads') });
  assert.deepEqual(used.settings.file_roots, [path.resolve(path.win32.join(home, 'Downloads'))]);
  assert.equal(used.sources.file_roots, `default: the registry could not be read: timed out after 15 s; ${path.win32.join(home, 'Downloads')} used`);
  const ok = C.loadConfig({ env: { HOME: home }, homedir: home, cwd: home, platform: 'win32', shellFolders: () => null, isDir: () => false });
  assert.equal(ok.sources.file_roots, 'default: no Downloads folder found');
  assert.equal(ok.downloadsWarning, null);
  const set = load({ env: { HOME: home, BRICKPROOF_FILE_ROOTS: '' } });
  assert.equal(set.downloadsWarning, null, 'file_roots set: the registry is not read');
  assert.deepEqual(C.findDownloads({ platform: 'win32', env: {}, homedir: 'C:\\Users\\me', isDir: () => false, shellFolders: () => ({ error: 'x' }) }),
    { dir: null, registryError: 'x', fallback: 'C:\\Users\\me\\Downloads' });
});

test('an unresolved ${user_config.x} or empty value of a launcher counts as not set', () => {
  const home = tmpDir();
  const s = load(home, { BRICKPROOF_DEVICES: '${user_config.devices}', BRICKPROOF_ADB: '', BRICKPROOF_ALLOW_SHELL: '${user_config.allow_shell}', BRICKPROOF_FILE_ROOTS: '${user_config.file_roots}' });
  assert.deepEqual(s.settings.devices, []);
  assert.equal(s.settings.adb_path, 'adb');
  assert.equal(s.settings.allow_shell, false);
  assert.equal(s.sources.file_roots, 'default: no Downloads folder found');
});

test('scan_subnets: private CIDR no wider than /22, from env or file', () => {
  assert.deepEqual(C.parseSubnet('192.168.77.77/24'), { base: C.ipToInt('192.168.77.0'), prefix: 24, text: '192.168.77.0/24' });  // scan-secrets:allow (made-up address)
  assert.equal(C.parseSubnet('10.0.0.0/22').text, '10.0.0.0/22');
  assert.equal(C.parseSubnet('172.20.5.0/24').text, '172.20.5.0/24');
  assert.match(C.parseSubnet('10.0.0.0/16'), /wider than \/22/);
  assert.match(C.parseSubnet('192.0.2.0/24'), /not a private range/);
  assert.match(C.parseSubnet('172.32.0.0/24'), /not a private range/);
  assert.match(C.parseSubnet('nope'), /not a subnet in CIDR form/);
  const home = tmpDir();
  assert.deepEqual(load(home, { BRICKPROOF_SCAN_SUBNETS: '192.168.77.0/24, 10.1.2.3/24' }).settings.scan_subnets, ['192.168.77.0/24', '10.1.2.0/24']);  // scan-secrets:allow (made-up address)
  assert.throws(() => load(home, { BRICKPROOF_SCAN_SUBNETS: '8.8.8.0/24' }), /env BRICKPROOF_SCAN_SUBNETS: "8\.8\.8\.0\/24" is not a private range/);
});

test('settingAction: the settings UI, else the environment variable, else brickproof-adb set', () => {
  const ui = { settingsUi: 'the app options in Home Assistant', sources: { allow_shell: 'default' } };
  assert.equal(C.settingAction('allow_shell', ui), 'turn on allow_shell in the app options in Home Assistant');
  assert.equal(C.settingAction('file_roots', ui), 'add a folder to file_roots in the app options in Home Assistant');
  const env = { settingsUi: null, sources: { allow_uninstall: 'env BRICKPROOF_ALLOW_UNINSTALL', file_roots: 'env BRICKPROOF_FILE_ROOTS' } };
  assert.equal(C.settingAction('allow_uninstall', env), 'set the environment variable BRICKPROOF_ALLOW_UNINSTALL=true where the server is started, and restart it');
  assert.match(C.settingAction('file_roots', env), /environment variable BRICKPROOF_FILE_ROOTS/);
  const none = { settingsUi: null, sources: { allow_shell: 'default' } };
  assert.equal(C.settingAction('allow_shell', none), 'run `brickproof-adb set allow_shell on` and restart the server');
  assert.equal(C.settingAction('file_roots', none), 'run `brickproof-adb set file_roots <folder>` and restart the server');
  // The Docker image: the variables of the container, whatever the source.
  const docker = { settingsUi: 'the environment of the container', sources: { allow_shell: 'default', file_roots: 'default: no Downloads folder found' } };
  assert.equal(C.settingAction('allow_shell', docker), 'set BRICKPROOF_ALLOW_SHELL=true in the environment of the container and recreate the container (docker compose up -d)');
  assert.equal(C.settingAction('allow_uninstall', docker), 'set BRICKPROOF_ALLOW_UNINSTALL=true in the environment of the container and recreate the container (docker compose up -d)');
  assert.equal(C.settingAction('file_roots', docker), 'mount a host folder into the container and set BRICKPROOF_FILE_ROOTS in the environment of the container to its path inside the container, then recreate the container (docker compose up -d)');
});

test('the Docker image sets the settings UI that the container texts key on', () => {
  const m = /^ENV .*\bBRICKPROOF_SETTINGS_UI="([^"]+)"/m.exec(fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8'));
  assert.ok(m, 'ENV BRICKPROOF_SETTINGS_UI in the Dockerfile');
  assert.match(C.settingAction('allow_shell', { settingsUi: m[1], sources: {} }), /^set BRICKPROOF_ALLOW_SHELL=true in /);
});

test('writeSetting: creates the file, writes typed values, keeps other keys, no value removes the key', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'sub', 'config.json');
  C.writeSetting(file, 'allow_shell', ['on']);
  C.writeSetting(file, 'devices', ['192.0.2.5,192.0.2.6:5555', '192.0.2.7']);
  C.writeSetting(file, 'file_roots', ['rel', abs('a')], { cwd: dir });
  C.writeSetting(file, 'port', ['3300']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
    { allow_shell: true, devices: ['192.0.2.5', '192.0.2.6:5555', '192.0.2.7'], file_roots: [path.join(dir, 'rel'), abs('a')], port: 3300 });
  const r = C.writeSetting(file, 'allow_shell', []);
  assert.equal(r.removed, true);
  assert.equal('allow_shell' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
  assert.throws(() => C.writeSetting(file, 'allow_shell', ['maybe']), /allow_shell takes on or off, got "maybe"/);
  assert.throws(() => C.writeSetting(file, 'nope', ['1']), /unknown setting "nope"; settings: port, host/);
  assert.throws(() => C.writeSetting(file, 'scan_subnets', ['1.2.3.0/24']), /not a private range/);
  assert.throws(() => C.writeSetting(file, 'port', ['x']), /port must be an integer/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.json'], 'no temporary file left');
});
