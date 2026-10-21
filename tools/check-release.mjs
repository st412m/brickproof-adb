#!/usr/bin/env node
// Release consistency, also run by CI and by the image workflow. Checks
// - package.json version = the top entry of CHANGELOG.md = the brickproof-adb@<v>
//   pin in the Dockerfile = server.json version = server.json packages[0].version =
//   the image tag in compose.example.yaml;
// - package.json mcpName = server.json name; packages[0] is the npm package
//   itself, on stdio, with a specific version;
// - server.json field limits of the 2025-12-11 schema: name pattern and 3–200
//   chars, description and title 1–100 chars;
// - manifest.json (Claude Desktop extension): version, name, author, entry point
//   (= package.json bin = the file mcp_config runs), Node version and the 18
//   tool names match package.json and src/registry.js; icon.png is a 512×512 PNG;
// - the npm package holds src/*.js, README.md, CHANGELOG.md, LICENSE and
//   package.json, nothing else (npm pack --dry-run; skipped with --no-pack).
// No dependencies, no network.
//
//   node tools/check-release.mjs [--no-pack]
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
export const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const RANGE_RE = /[\^~><=*x ]|\|\|/;
const PACKAGE_FILE = /^(src\/[^/]+\.js|README\.md|CHANGELOG\.md|LICENSE|package\.json)$/;

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** Returns a list of problems (empty when the release is consistent). */
export function checkRelease(root = ROOT) {
  const problems = [];
  const pkg = JSON.parse(read(root, 'package.json'));
  const server = JSON.parse(read(root, 'server.json'));
  const v = pkg.version;
  const versions = {
    'CHANGELOG.md top entry': /^## (\S+)/m.exec(read(root, 'CHANGELOG.md'))?.[1],
    'Dockerfile brickproof-adb@': /\bbrickproof-adb@([^\s\\"]+)/.exec(read(root, 'Dockerfile'))?.[1],
    'server.json version': server.version,
    'server.json packages[0].version': server.packages?.[0]?.version,
    'compose.example.yaml image': /^\s*image:\s*ghcr\.io\/st412m\/brickproof-adb:(\S+)\s*$/m.exec(read(root, 'compose.example.yaml'))?.[1],
  };
  for (const [where, got] of Object.entries(versions)) {
    if (got !== v) problems.push(`${where} is ${got ?? '(missing)'}, package.json version is ${v}`);
  }
  if (server.$schema !== SCHEMA_URL) problems.push(`server.json $schema is ${server.$schema}, expected ${SCHEMA_URL}`);
  if (pkg.mcpName !== server.name) problems.push(`package.json mcpName ${pkg.mcpName} != server.json name ${server.name}`);
  if (typeof server.name !== 'string' || !NAME_RE.test(server.name) || server.name.length < 3 || server.name.length > 200) problems.push(`server.json name is not a valid registry name: ${server.name}`);
  for (const field of ['description', 'title']) {
    const s = server[field];
    if (field === 'description' || s !== undefined) {
      if (typeof s !== 'string' || s.length < 1 || s.length > 100) problems.push(`server.json ${field} must be 1–100 chars (has ${s?.length ?? 0})`);
    }
  }
  const p0 = server.packages?.[0];
  if (!p0 || p0.registryType !== 'npm' || p0.identifier !== pkg.name) problems.push(`server.json packages[0] must be the npm package ${pkg.name}`);
  if (p0?.transport?.type !== 'stdio') problems.push('server.json packages[0].transport.type must be stdio');
  if (typeof p0?.version !== 'string' || RANGE_RE.test(p0.version)) problems.push(`server.json packages[0].version must be a specific version: ${p0?.version}`);
  if (!Array.isArray(pkg.files) || pkg.files.includes('server.json')) problems.push('server.json must stay out of the npm package (package.json files)');
  for (const [dep, want] of Object.entries(pkg.dependencies || {})) {
    if (RANGE_RE.test(want)) problems.push(`dependency ${dep} must be pinned to an exact version, not ${want}`);
  }
  problems.push(...checkManifest(root, pkg));
  return problems;
}

/** manifest.json (Claude Desktop extension) against package.json and the tool registry. */
export function checkManifest(root = ROOT, pkg = JSON.parse(read(root, 'package.json'))) {
  const problems = [];
  const m = JSON.parse(read(root, 'manifest.json'));
  if (m.version !== pkg.version) problems.push(`manifest.json version is ${m.version}, package.json version is ${pkg.version}`);
  if (m.name !== pkg.name) problems.push(`manifest.json name is ${m.name}, package.json name is ${pkg.name}`);
  if (m.author?.name !== 'st412m') problems.push('manifest.json author.name must be st412m');
  if (m.server?.type !== 'node' || m.server?.entry_point !== pkg.bin?.['brickproof-adb']) problems.push(`manifest.json server must be node with entry_point ${pkg.bin?.['brickproof-adb']} (package.json bin)`);
  if (m.server?.mcp_config?.args?.[0] !== `\${__dirname}/${m.server?.entry_point}`) problems.push(`manifest.json mcp_config.args[0] must be \${__dirname}/${m.server?.entry_point} (the entry point)`);
  problems.push(...checkIcon(root, m.icon));
  if (m.compatibility?.runtimes?.node !== pkg.engines?.node) problems.push(`manifest.json compatibility.runtimes.node is ${m.compatibility?.runtimes?.node}, package.json engines.node is ${pkg.engines?.node}`);
  const { TOOLS } = createRequire(import.meta.url)(path.join(root, 'src', 'registry.js'));
  const want = TOOLS.map(t => t.name);
  const got = (m.tools || []).map(t => t.name);
  if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`manifest.json tools (${got.join(', ')}) differ from the registry (${want.join(', ')})`);
  if ((m.tools || []).some(t => !t.description)) problems.push('manifest.json: every tool needs a description');
  return problems;
}

/** manifest.json icon: icon.png, a PNG of 512×512 by its IHDR chunk. */
export function checkIcon(root = ROOT, icon = 'icon.png') {
  if (icon !== 'icon.png') return [`manifest.json icon is ${icon ?? '(missing)'}, expected icon.png`];
  let buf;
  try { buf = fs.readFileSync(path.join(root, icon)); } catch { return [`${icon} is missing`]; }
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG) || buf.toString('latin1', 12, 16) !== 'IHDR') return [`${icon} is not a PNG`];
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  return w === 512 && h === 512 ? [] : [`${icon} is ${w}×${h}, expected 512×512`];
}

/** The files `npm pack` would put into the package. */
export function packFiles(root = ROOT) {
  const out = execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out)[0].files.map(f => f.path);
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const problems = checkRelease();
  let packNote = 'package contents not checked (--no-pack)';
  if (!process.argv.includes('--no-pack')) {
    const files = packFiles();
    const bad = files.filter(f => !PACKAGE_FILE.test(f));
    if (bad.length) problems.push(`unexpected in the package: ${bad.join(', ')}`);
    for (const must of ['src/main.js', 'src/cli.js', 'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'])
      if (!files.includes(must)) problems.push(`missing from the package: ${must}`);
    packNote = `${files.length} files in the package`;
  }
  for (const p of problems) console.error(`check-release: ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`check-release: ${JSON.parse(read(ROOT, 'package.json')).version} everywhere, server.json ok, ${packNote}`);
}
