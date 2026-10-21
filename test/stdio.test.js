'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { serveStdio } = require('../src/stdio.js');
const { tmpDir, CLI, isolatedEnv } = require('./helpers.js');

// Feeds lines in, collects what comes out, until stdin ends.
async function session(lines, dispatch) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', c => (out += c));
  const { closed } = serveStdio({ input, output, dispatch });
  for (const l of lines) input.write(l + '\n');
  input.end();
  await closed;
  return out;
}

// A dispatcher of our own: what the transport does, not what the tools do.
async function fakeDispatch(body) {
  if (!body || typeof body !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'x' } };
  if (body.method === 'note') return null;
  if (body.method === 'slow') { await new Promise(r => setTimeout(r, 80)); return { jsonrpc: '2.0', id: body.id, result: 'slow' }; }
  if (body.method === 'text') return { jsonrpc: '2.0', id: body.id, result: 'one\ntwo\r\nthree' };
  if (body.method === 'boom') throw new Error('boom');
  return { jsonrpc: '2.0', id: body.id, result: body.method };
}

test('one JSON line per answer, nothing for a notification, answers as they finish', async () => {
  const out = await session([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slow' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'note' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'fast' }),
  ], fakeDispatch);
  const msgs = out.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(msgs.map(m => m.id), [2, 1], 'the fast answer is not held up by the slow one');
});

test('a broken line gets a parse error, a batch one array, blank lines nothing, a throw an internal error', async () => {
  const out = await session(['{oops', '', JSON.stringify([{ jsonrpc: '2.0', id: 5, method: 'a' }, { jsonrpc: '2.0', id: 6, method: 'b' }]),
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'boom' })], fakeDispatch);
  const msgs = out.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs.find(m => !Array.isArray(m) && m.error && m.error.code === -32700), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  assert.deepEqual(msgs.find(m => Array.isArray(m)), [{ jsonrpc: '2.0', id: 5, result: 'a' }, { jsonrpc: '2.0', id: 6, result: 'b' }]);
  assert.deepEqual(msgs.find(m => !Array.isArray(m) && m.error && m.error.code === -32603), { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
});

test('a text with newlines stays on one line', async () => {
  const out = await session([JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'text' })], fakeDispatch);
  assert.equal(out.split('\n').length, 2);
  assert.equal(JSON.parse(out).result, 'one\ntwo\r\nthree');
});

test('the real dispatcher: initialize, tools/list = 18', async () => {
  const out = await session([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ]);
  const byId = Object.fromEntries(out.trimEnd().split('\n').map(l => JSON.parse(l)).map(m => [m.id, m]));
  assert.equal(byId[1].result.serverInfo.name, 'brickproof-adb');
  assert.equal(byId[2].result.tools.length, 18);
});

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } };

test('main.js loaded by require() from another script (how Claude Desktop loads it) runs the server', async () => {
  const home = tmpDir();
  const main = path.resolve(__dirname, '..', 'src', 'main.js');
  const env = isolatedEnv(home, { BRICKPROOF_FILE_ROOTS: '' });
  const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(main)})`], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => (stdout += c));
  child.stderr.on('data', c => (stderr += c));
  child.stdin.write(JSON.stringify(INIT) + '\n');
  child.stdin.end();
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout.trim()).result.serverInfo.name, 'brickproof-adb');
  assert.match(stderr, /^brickproof-adb \d+\.\d+\.\d+ on stdio, /m);
});

test('cli.js does nothing on require()', () => {
  const r = require('child_process').spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'cli.js'))})`],
    { input: JSON.stringify(INIT) + '\n', encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('CLI without adb: starts, answers initialize and tools/list, a tool says adb is missing; stdout is protocol only', async () => {
  const home = tmpDir();
  // file_roots set to nothing: the Downloads folder the registry of this machine names does not count.
  const env = isolatedEnv(home, { BRICKPROOF_ADB: path.join(home, 'nonexistent', 'adb'), BRICKPROOF_FILE_ROOTS: '' });
  const child = spawn(process.execPath, [CLI], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => (stdout += c));
  child.stderr.on('data', c => (stderr += c));
  child.stdin.write(JSON.stringify(INIT) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'adb_devices', arguments: {} } }) + '\n');
  child.stdin.end();
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0, stderr);
  const msgs = stdout.trimEnd().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(msgs.map(m => m.id).sort(), [1, 2, 3]);
  assert.equal(msgs.find(m => m.id === 1).result.serverInfo.name, 'brickproof-adb');
  assert.equal(msgs.find(m => m.id === 2).result.tools.length, 18);
  const call = msgs.find(m => m.id === 3).result;
  assert.equal(call.isError, true);
  assert.match(call.content[0].text, /^Error: adb could not start: ENOENT - adb was not found \(adb_path: .*\)\. Run `brickproof-adb get-adb`/);
  assert.match(stderr, new RegExp(`^brickproof-adb ${require('../package.json').version.replace(/\./g, '\\.')} on stdio, allow_shell off, allow_uninstall off, file roots none, `, 'm'));
});

test('CLI stdio: the state directory is created, no token is', async () => {
  const home = tmpDir();
  const env = isolatedEnv(home);
  const child = spawn(process.execPath, [CLI], { env });
  child.stdin.end();
  assert.equal(await new Promise(r => child.on('exit', r)), 0);
  const C = require('../src/config.js');
  const { stateDir } = C.platformDirs({ env, homedir: home });
  assert.ok(fs.existsSync(stateDir), stateDir);
  assert.equal(fs.existsSync(path.join(stateDir, 'token')), false);
});
