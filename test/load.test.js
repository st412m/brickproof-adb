'use strict';
// require() of any module reads no environment variable and starts no process.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MODULES = ['adb', 'apps', 'config', 'device', 'discover', 'files', 'hostpath', 'http', 'image', 'platform-tools', 'registry', 'server', 'session', 'stdio', 'token', 'ui', 'version', 'cli'];

// Run in a child, so nothing is cached: watch process.env and child_process,
// then require every module.
const PROBE = `
const reads = new Set();
const real = process.env;
process.env = new Proxy(real, { get(t, k) { if (typeof k === 'string') reads.add(k); return t[k]; } });
const cp = require('child_process');
const started = [];
for (const fn of ['spawn', 'execFile', 'exec', 'fork', 'spawnSync', 'execFileSync', 'execSync'])
  cp[fn] = (...a) => { started.push(fn + ' ' + String(a[0])); throw new Error('no process at require time'); };
const wt = require('worker_threads');
const RealWorker = wt.Worker;
wt.Worker = function () { started.push('Worker'); throw new Error('no worker at require time'); };
for (const m of ${JSON.stringify(MODULES)}) require(${JSON.stringify(SRC)} + '/' + m + '.js');
process.env = real;
process.stdout.write(JSON.stringify({ reads: [...reads], started }));
`;

test('every module loads without reading the environment or starting a process', async () => {
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', PROBE], { env: { ...process.env, BRICKPROOF_ALLOW_SHELL: 'true' } }, (err, stdout, stderr) =>
      (err ? reject(new Error(stderr || err.message)) : resolve(JSON.parse(stdout))));
  });
  assert.deepEqual(out.started, []);
  // Node itself reads its own variables (NODE_*, colour settings) while loading.
  const ours = out.reads.filter(k => !/^(NODE_|FORCE_COLOR$|NO_COLOR$|NODE$|TERM$)/.test(k));
  assert.deepEqual(ours, [], `environment read at require time: ${out.reads.join(', ')}`);
});
