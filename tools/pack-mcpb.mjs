#!/usr/bin/env node
// Builds the Claude Desktop extension (.mcpb) from an `npm pack` tarball, the
// same way as .github/workflows/mcpb.yml:
//   unpack the tarball → add manifest.json and icon.png → npm install --omit=dev
//   --ignore-scripts → mcpb validate → mcpb pack.
//
//   node tools/pack-mcpb.mjs <brickproof-adb-x.y.z.tgz> [<out-dir>]
//
// Writes <out-dir>/brickproof-adb-x.y.z.mcpb (default: next to the tarball).
// Needs the network for npm and for the mcpb CLI, pinned to MCPB_CLI.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';
const ROOT = path.resolve(import.meta.dirname, '..');

function run(cmd, cwd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

const q = p => `"${p}"`;

const tarball = process.argv[2] && path.resolve(process.argv[2]);
if (!tarball || !fs.existsSync(tarball)) {
  console.error('usage: node tools/pack-mcpb.mjs <brickproof-adb-x.y.z.tgz> [<out-dir>]  (make the tarball with npm pack)');
  process.exit(2);
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!path.basename(tarball).includes(`-${version}.tgz`)) {
  console.error(`the tarball ${path.basename(tarball)} is not version ${version} of package.json`);
  process.exit(1);
}
const outDir = path.resolve(process.argv[3] || path.dirname(tarball));
const out = path.join(outDir, `brickproof-adb-${version}.mcpb`);
const work = fs.mkdtempSync(path.join(outDir, '.mcpb-build-'));
try {
  run(`tar -xzf ${q(tarball)} -C ${q(work)}`);
  const pkg = path.join(work, 'package');
  fs.copyFileSync(path.join(ROOT, 'manifest.json'), path.join(pkg, 'manifest.json'));
  fs.copyFileSync(path.join(ROOT, 'icon.png'), path.join(pkg, 'icon.png'));
  run('npm install --omit=dev --ignore-scripts --no-package-lock --no-audit --no-fund', pkg);
  run(`npx -y ${MCPB_CLI} validate manifest.json`, pkg);
  run(`npx -y ${MCPB_CLI} pack ${q(pkg)} ${q(out)}`, pkg);
  console.log(`written: ${out} (${fs.statSync(out).size} bytes)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
