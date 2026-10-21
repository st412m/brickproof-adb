'use strict';
// adb.js: failure texts, typical errors, another adb, quoting through a real
// argv, coercion, serials as directory names, temp dirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const A = require('../src/adb.js');
const { tmpDir, useFakeAdb } = require('./helpers.js');

const ARGS = ['-s', '192.0.2.50:5555', 'shell', 'input text "SECRET_MARKER"'];
const TAIL = '\nstdout (tail): ';

test('describeAdbFailure: timeout, signal, maxBuffer, exit code, ENOENT; argv never in the text', () => {
  const cases = [
    [{ killed: true, signal: 'SIGTERM' }, 'adb shell timed out after 30 s and was killed (SIGTERM)'],
    [{ killed: true }, 'adb shell timed out after 30 s and was killed'],
    [{ signal: 'SIGKILL' }, 'adb shell was terminated by SIGKILL'],
    [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: false }, 'adb shell output exceeded 16 MB and was killed'],
    [{ code: 1 }, 'adb shell exited with code 1 and printed nothing'],
    [{ code: 'EACCES' }, 'adb could not start: EACCES'],
    [{}, 'adb shell failed without output'],
  ];
  for (const [err, want] of cases) {
    const msg = A.describeAdbFailure(err, '', '', ARGS);
    assert.equal(msg, want);
    assert.ok(!msg.includes('SECRET_MARKER'));
  }
  assert.equal(A.describeAdbFailure({ killed: true }, '', '', ARGS, { timeout: 2000 }), 'adb shell timed out after 2 s and was killed');
  assert.equal(A.describeAdbFailure({ code: 1 }, '', 'partial', ['shell', 'x']), `adb shell exited with code 1${TAIL}partial`);
  assert.equal(A.describeAdbFailure({ code: 1 }, '', '', []), 'adb (no subcommand) exited with code 1 and printed nothing');
});

test('describeAdbFailure: ENOENT says adb was not found and how to install it', () => {
  const msg = A.describeAdbFailure({ code: 'ENOENT' }, '', '', ARGS);
  assert.match(msg, /^adb could not start: ENOENT - adb was not found \(adb_path: ".*"\)\. Run `brickproof-adb get-adb` to download Google's platform-tools, or install them yourself \(/);
  assert.match(msg, /or set adb_path to the adb executable\.$/);
  assert.ok(!msg.includes('SECRET_MARKER'));
  for (const p of ['win32', 'darwin', 'linux']) assert.match(A.installHint(p), /platform-tools/);
});

test('describeAdbFailure: a non-empty stderr is the message, with the stdout tail', () => {
  assert.equal(A.describeAdbFailure({ code: 1 }, 'error: closed\n', '', ARGS), 'error: closed');
  assert.equal(A.describeAdbFailure({ code: 1 }, 'boom', 'out', ARGS), `boom${TAIL}out`);
  assert.equal(A.describeAdbFailure({ code: 1 }, 'boom', 'x'.repeat(3000), ARGS), `boom${TAIL}${'x'.repeat(2000)}`);
  assert.equal(A.describeAdbFailure({ code: 1 }, 'boom', Buffer.from('bin'), ARGS, { binary: true }), 'boom');
});

test('describeAdbFailure: "* daemon ..." lines are never the cause; a timeout while the server starts says to call again', () => {
  const STARTING = '* daemon not running; starting now at tcp:5037\n';
  assert.equal(A.describeAdbFailure({ killed: true, signal: 'SIGTERM' }, STARTING, '', ['mdns', 'services'], { timeout: 10000 }),
    'adb mdns timed out after 10 s: the adb server was still starting (it can take about 20 s on Windows); call again');
  assert.equal(A.describeAdbFailure({ killed: true }, STARTING, '', ARGS, { timeout: 30000 }),
    'adb shell timed out after 30 s: the adb server was still starting (it can take about 20 s on Windows); call again');
  assert.equal(A.describeAdbFailure({ code: 1 }, `${STARTING}* daemon started successfully\nerror: no devices/emulators found\n`, '', ARGS),
    A.friendlyAdbError('error: no devices/emulators found'), 'the real cause stays');
  assert.equal(A.describeAdbFailure({ code: 1 }, `${STARTING}* daemon started successfully\n`, '', ARGS), 'adb shell exited with code 1 and printed nothing');
  assert.equal(A.describeAdbFailure({ killed: true }, '', '', ARGS, { timeout: 2000 }), 'adb shell timed out after 2 s and was killed', 'no start in stderr: as before');
});

test('friendlyAdbError adds the fix; the verifier hint says adb_shell needs allow_shell', () => {
  assert.match(A.friendlyAdbError("error: device '192.0.2.9:5555' not found"), /Call adb_devices/);
  assert.match(A.friendlyAdbError('error: device offline'), /run adb_disconnect for this host, then adb_connect again/);
  assert.equal(A.friendlyAdbError('error: device unauthorized'), 'error: device unauthorized. Confirm the prompt to allow debugging on the device screen (check "Always allow").');
  assert.match(A.friendlyAdbError('Failure [INSTALL_FAILED_VERIFICATION_FAILURE]'), /via adb_shell \(needs allow_shell\): settings put global verifier_verify_adb_installs 0$/);
  assert.equal(A.friendlyAdbError('other'), 'other');
});

test('another adb: the line is recognised and becomes a warning with the fix', () => {
  const line = "adb server version (41) doesn't match this client (39); killing...\n* daemon started successfully\n";
  const w = A.foreignAdbWarning(line);
  assert.match(w, /^⚠ the adb server was started by another adb on this machine and this client restarted it \(server version 41, client version 39\)/);
  assert.match(w, /network devices may need adb_connect again\. Set adb_path to the same adb/);
  assert.equal(A.foreignAdbWarning('* daemon not running; starting now at tcp:5037'), null);
  // Two builds of one protocol: adb prints the same number twice, the warning none.
  const same = A.foreignAdbWarning("adb server version (41) doesn't match this client (41); killing...\n");
  assert.match(same, /^⚠ the adb server was started by another adb on this machine and this client restarted it, so network devices may need adb_connect again\. /);
  assert.ok(!/version 41/.test(same));
});

test('another adb: the warning reaches the notes of the call, on success and on failure', async () => {
  const fake = useFakeAdb([
    { match: '^devices', stdout: 'List of devices attached\n', stderr: "adb server version (41) doesn't match this client (39); killing...\n" },
    { match: '^shell', code: 1, stderr: "adb server version (41) doesn't match this client (39); killing...\nerror: no devices/emulators found\n" },
  ]);
  void fake;
  const ok = await A.collectNotes(() => A.adb(['devices', '-l']));
  assert.equal(ok.notes.length, 1);
  assert.match(ok.notes[0], /another adb on this machine/);
  await assert.rejects(A.collectNotes(() => A.adb(['shell', 'true'])), e => e.adbNotes.length === 1 && /no devices\/emulators found/.test(e.message));
  const none = await A.collectNotes(async () => 1);
  assert.deepEqual(none, { value: 1, notes: [] });
});

test('quoting: quotes, backslashes, spaces and shell specials reach adb as one argv element', async () => {
  const fake = useFakeAdb([{ match: '.', echo: true }]);
  void fake;
  const typed = `it's "quoted" \\ back\\slash  two  spaces $HOME;|&<>`;
  const cmd = `input text ${A.sq(A.escapeInputText(typed))}`;
  const echoed = JSON.parse(await A.adb(['-s', '192.0.2.50:5555', 'shell', cmd]));
  assert.deepEqual(echoed, ['-s', '192.0.2.50:5555', 'shell', cmd]);
  const sqd = `ls ${A.sq("a b'c\\d")}`;
  assert.deepEqual(JSON.parse(await A.adb(['shell', sqd])), ['shell', sqd]);
  assert.equal(A.sq("a'b"), `'a'\\''b'`);
});

test('escapeInputText: only the rule of input text itself, a space as %s; the shell quoting is sq()', () => {
  assert.equal(A.escapeInputText('a b'), 'a%sb');
  const specials = '\'"\\$&;|`()*?<>%#!~[]{}^';
  assert.equal(A.escapeInputText(specials), specials);
  assert.equal(A.escapeInputText('100%'), '100%');
});

test('coerceArray, coerceBool, coerceObject accept JSON strings from clients', () => {
  assert.deepEqual(A.coerceArray('["a","b"]'), ['a', 'b']);
  assert.deepEqual(A.coerceArray('a'), ['a']);
  assert.deepEqual(A.coerceArray(undefined), []);
  assert.deepEqual(A.coerceArray('[not json'), ['[not json']);
  assert.equal(A.coerceBool('true', false), true);
  assert.equal(A.coerceBool('False', true), false);
  assert.equal(A.coerceBool('', true), true);
  assert.deepEqual(A.coerceObject('{"a":1}'), { a: 1 });
  assert.deepEqual(A.coerceObject(''), {});
  assert.throws(() => A.coerceObject('[1]'), /extras: expected a key-value object/);
});

test('sanitizeSerial: a serial as a directory name; trailing dots dropped', () => {
  assert.equal(A.sanitizeSerial('192.0.2.50:5555'), '192.0.2.50_5555');
  assert.equal(A.sanitizeSerial('adb-R5CX00000AB-AbCdEf._adb-tls-connect._tcp'), 'adb-R5CX00000AB-AbCdEf._adb-tls-connect._tcp');
  assert.equal(A.sanitizeSerial('SHIELD Android TV_ABC123'), 'SHIELD_Android_TV_ABC123');
  assert.equal(A.sanitizeSerial('Model X._SER.'), 'Model_X._SER');
  assert.equal(A.sanitizeSerial('...'), '_');
  assert.equal(A.sanitizeSerial(undefined), 'default');
});

test('temp dirs are brickproof-*; the sweep removes only those older than the limit', () => {
  const dir = tmpDir();
  const old = path.join(dir, 'brickproof-old'), fresh = path.join(dir, 'brickproof-new'), other = path.join(dir, 'other-old');
  for (const d of [old, fresh, other]) fs.mkdirSync(d);
  const now = Date.now();
  fs.utimesSync(old, new Date(now - 2 * 3600000), new Date(now - 2 * 3600000));
  fs.utimesSync(other, new Date(now - 2 * 3600000), new Date(now - 2 * 3600000));
  assert.deepEqual(A.sweepTempDirs({ dir, now }), [old]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['brickproof-new', 'other-old']);
  const made = A.makeTempDir('apks-');
  assert.match(path.basename(made), /^brickproof-apks-/);
  fs.rmSync(made, { recursive: true, force: true });
});

test('spawnAdb: stdout goes into the file, a timeout kills the client', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'src.bin');
  fs.writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  useFakeAdb([{ match: '^exec-out', stdoutFile: src }, { match: '^slow', delayMs: 10 * 60 * 1000, stdout: 'late' }]);
  const out = path.join(dir, 'out.bin');
  let fd = fs.openSync(out, 'w');
  const r = await A.spawnAdb(['exec-out', 'screencap', '-p'], fd);
  fs.closeSync(fd);
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(src));
  fd = fs.openSync(path.join(dir, 'slow.bin'), 'w');
  const t0 = Date.now();
  const s = await A.spawnAdb(['slow'], fd, { timeout: 300 });
  fs.closeSync(fd);
  assert.equal(s.timedOut, true);
  assert.ok(Date.now() - t0 < 5 * 60 * 1000, 'killed, not waited out');
});

test('adb() and spawnAdb() without adb: the same "not found" text', async () => {
  const dir = tmpDir();
  A.configure({ adbPath: path.join(dir, 'missing', 'adb') });
  await assert.rejects(A.adb(['devices']), /^Error: adb could not start: ENOENT - adb was not found/);
  const fd = fs.openSync(path.join(dir, 'x'), 'w');
  await assert.rejects(A.spawnAdb(['exec-out', 'screencap', '-p'], fd), /adb could not start: ENOENT/);
  fs.closeSync(fd);
  A.configure({});
});
