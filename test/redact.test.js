'use strict';
// Masking in the tool log and redaction of error text.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/server.js');
const { escapeInputText, sq } = require('../src/adb.js');
const { useFakeAdb } = require('./helpers.js');

test('maskArgs: adb_text text as a length, adb_pair code, keys named like secrets', () => {
  assert.deepEqual(S.maskArgs('adb_text', { text: 'hunter2', serial: 's' }), { text: '<7 chars>', serial: 's' });
  assert.deepEqual(S.maskArgs('adb_pair', { host: '192.0.2.5:37000', code: '123456' }), { host: '192.0.2.5:37000', code: '***' });
  assert.deepEqual(S.maskArgs('adb_x', { password: 'a', api_token: 'b', mySecret: 'c', keep: 'd' }),
    { password: '***', api_token: '***', mySecret: '***', keep: 'd' });
  assert.deepEqual(S.maskArgs('adb_shell', { command: 'input text hunter2' }), { command: 'input text hunter2' }, 'adb_shell.command is not masked');
});

test('fmtArgs masks before it cuts to 300 characters', () => {
  const long = 'S'.repeat(400);
  const s = S.fmtArgs('adb_text', { text: long, serial: 'x' });
  assert.ok(!s.includes('SSSS'));
  assert.equal(s, '{"text":"<400 chars>","serial":"x"}');
  const cut = S.fmtArgs('adb_shell', { command: 'y'.repeat(400) });
  assert.equal(cut.length, 301);
  assert.ok(cut.endsWith('…'));
});

test('redact: the plain, input-text-escaped and base64 forms of the typed text, and the pairing code', () => {
  const t = 'p@ss word$1';
  const b64 = Buffer.from(t, 'utf8').toString('base64');
  const msg = `failed: input text ${sq(escapeInputText(t))} / ${t} / --es msg ${b64}`;
  const out = S.redact('adb_text', { text: t }, msg);
  for (const form of [t, escapeInputText(t), b64]) assert.ok(!out.includes(form), form);
  assert.equal((out.match(/<secret>/g) || []).length, 3);
  const q = "it's a pass";
  assert.equal(S.redact('adb_text', { text: q }, `failed: input text ${sq(escapeInputText(q))}`), 'failed: input text <secret>',
    'a quote inside: the quoted form as a whole');
  assert.equal(S.redact('adb_pair', { code: '482913' }, 'pair 192.0.2.5:37000 482913 failed'), 'pair 192.0.2.5:37000 <secret> failed');
  assert.equal(S.redact('adb_text', { text: 'a' }, 'a cat'), 'a cat', 'one-character values are left alone');
  assert.equal(S.redact('adb_shell', { command: 'x' }, 'x'), 'x');
});

test('fmtOutcome', () => {
  assert.equal(S.fmtOutcome([{ type: 'text', text: 'abc' }]), 'ok 3B');
  assert.equal(S.fmtOutcome([{ type: 'image', data: 'A'.repeat(4096) }]), 'image 3KB');
  assert.equal(S.fmtOutcome([]), 'ok');
});

test('a tool error is redacted for the client and the log, and [tool] lines go to the log sink', async () => {
  useFakeAdb([{ match: '^shell', code: 1, stderr: 'error: closed while typing p@ssw0rd!\n' }]);
  const lines = [];
  S.init({ log_requests: true, allow_shell: false }, { log: l => lines.push(l) });
  require('../src/adb.js').useTestRunner(process.execPath, [require('./helpers.js').FAKE_ADB]);
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'adb_text', arguments: { text: 'p@ssw0rd!' } } });
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, 'Error: error: closed while typing <secret>');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[tool\] \S+ adb_text \{"text":"<9 chars>"\} -> ERROR: error: closed while typing <secret> \d+ms$/);
  assert.ok(!lines[0].includes('p@ssw0rd'));
  S.init({});
});
