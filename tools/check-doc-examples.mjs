#!/usr/bin/env node
// Checks the examples in the documentation against the source.
//
//   node tools/check-doc-examples.mjs [app-root]
//
// brickproof-adb: README.md and docs/*.md against src/, test/, the Dockerfile,
// compose.example.yaml, manifest.json, package.json, server.json and the
// workflows. With app-root (the ha-adb-mcp repository) also its
// README.md, adb_mcp/DOCS.md and docs/*.md, against the same source plus the
// app's run.sh, config.yaml and Dockerfiles.
//
// Checked:
// - every inline `code` span is found in the source, is a tool name, or is in
//   the EXTERNAL list below (user content, commands of other programs, UI
//   names); "<placeholder>" and "…" stand for parts the source fills in;
// - output lines in fenced blocks that look like server output match a
//   template string of the source;
// - `brickproof-adb …` command lines use commands and flags the CLI has;
// - JSON blocks that are brickproof-adb configs pass the config parser;
// - names in UPPER_SNAKE_CASE named in the docs exist; docs/tools.md covers
//   exactly TOOLS;
// - relative links resolve, links into the GitHub repositories point to files
//   that exist; DOCS.md uses absolute links only (Home Assistant shows it
//   outside the repository).
// Exit code 1 if any check fails.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = process.argv[2] ? path.resolve(process.argv[2]) : null;
const require = createRequire(import.meta.url);
const CYR = /[\u0400-\u04FF]/;
// A word character: letter, number or underscore.
const W = '[\\p{L}\\p{N}_]';

function read(root, p) {
  return fs.readFileSync(path.join(root, p), 'utf8');
}

function listDir(root, dir, ext) {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter(n => !n.startsWith('.') && n.endsWith(ext) && fs.statSync(path.join(full, n)).isFile())
    .map(n => `${dir}/${n}`);
}

const APP_SRC = ['adb_mcp/run.sh', 'adb_mcp/config.yaml', 'adb_mcp/Dockerfile', 'adb_mcp/Dockerfile.local'];
const SRC_FILES = [
  ...listDir(ROOT, 'src', '.js').map(p => [ROOT, p]),
  ...listDir(ROOT, 'test', '.js').map(p => [ROOT, p]),
  ...listDir(ROOT, '.github/workflows', '.yml').map(p => [ROOT, p]),
  ...['Dockerfile', 'compose.example.yaml', 'manifest.json', 'package.json', 'server.json'].map(p => [ROOT, p]),
  ...(APP ? APP_SRC.filter(p => fs.existsSync(path.join(APP, p))).map(p => [APP, p]) : []),
];
const SRC = SRC_FILES.map(([r, p]) => read(r, p)).join('\n');
const REGISTRY = read(ROOT, 'src/registry.js');
const CLI = require(path.join(ROOT, 'src/cli.js'));
const CONFIG = require(path.join(ROOT, 'src/config.js'));

const DOC_FILES = [
  ...['README.md', ...listDir(ROOT, 'docs', '.md').sort()].map(p => ({ root: ROOT, file: p, name: p })),
  ...(APP ? ['README.md', 'adb_mcp/DOCS.md', ...listDir(APP, 'docs', '.md').sort()].filter(p => fs.existsSync(path.join(APP, p)))
    .map(p => ({ root: APP, file: p, name: `app/${p}` })) : []),
];
for (const d of DOC_FILES) d.text = read(d.root, d.file);

function squash(s) {
  return s.replace(/["'\\]/g, '').replace(/\s+/g, ' ');
}

const SRC_SQ = squash(SRC);

// --- TOOLS array --------------------------------------------------------------
const toolsBlock = REGISTRY.slice(REGISTRY.indexOf('const TOOLS = ['), REGISTRY.indexOf('async function callTool'));
const TOOLS = [...toolsBlock.matchAll(/^\s{4}name: '([a-z_]+)'/gm)].map(m => m[1]);

// --- Spans that are not claims about the code --------------------------------
// User content, commands of other programs, Android and client UI values,
// example data. Every entry is a deliberate exception and is counted in the
// output.
const EXTERNAL = new Set([
  // other programs and their files
  'adb', 'npx', 'cmd', 'cmd /c', 'claude_desktop_config.json', 'node:test', 'npm test', 'uiautomator', 'input text', 'input tap',
  'wm size', 'Override size:', 'Physical size:', 'dumpsys power', 'dumpsys role', 'mWakefulness', 'pm enable', 'pm path <pkg>',
  'cmd package install-existing', 'logcat -d -t N', 'adb devices -l', 'adb exec-out screencap -p', '--user 0', '-k', '-p',
  '--es', '--ez', '--ei', '--el', '--device /dev/bus/usb', '~/.android/adbkey', '/data/.android/adbkey', 'ro.product.model',
  'ro.serialno', 'ro.product.cpu.abilist', 'wm density', 'persist.sys.locale', 'android.hardware.touchscreen', 'manifest.json',
  'state.json', '/sdcard', '.cmd', '.bat', 'adb.exe', 'EINVAL', 'ENOENT', 'PATH', 'isError: true', 'grep',
  // Android values and example data
  'com.example.app', 'android', 'Network', 'Settings', 'Apps', 'Home', 'Search', 'HOME', 'BACK', 'ENTER', 'DPAD_CENTER', 'WAKEUP',
  'KEYCODE_', 'CALL', 'CALL_PRIVILEGED', 'CALL_EMERGENCY', 'android.intent.action.CALL', 'android.intent.action.VIEW',
  'nav_bar_settings', 'default', 'unknown', 'ip', 'ip:port', 'ip:5555', '192.0.2.50', '<ip>:5555', '.apk', '.apks', '.xapk', '.apkm',
  '.apks`/`.xapk`/`.apkm',
  // HTTP and the connector
  'POST /mcp', '/mcp', 'Host', 'Origin', 'Bearer', '/.well-known/*', '/private_<token>/mcp', 'Authorization: Bearer <token>',
  '127.0.0.1:3200', '127.0.0.1:5037', '--host 0.0.0.0', 'A-Z a-z 0-9 . _ ~ -', '[req]', '[tool]', '***',
  // files and directories of this repository and of the system
  'test/*.test.js', 'test/fake-adb.js', 'test/image.test.js', 'src/server.js', 'compose.example.yaml',
  'config.json', 'docs/tools.md', '<state_dir>/token', '<state_dir>/snapshots', '/data', 'brickproof-*', '~/.config/brickproof-adb',
  '~/.local/state/brickproof-adb', '~/Library/Application Support/brickproof-adb', '%APPDATA%\\brickproof-adb',
  '%LOCALAPPDATA%\\brickproof-adb', '$XDG_CONFIG_HOME/brickproof-adb', '$XDG_STATE_HOME/brickproof-adb',
  // other clients' commands
  'npm install -g brickproof-adb', 'claude mcp add brickproof-adb -- npx -y brickproof-adb', 'npx -y brickproof-adb',
  '"args": ["-y", "brickproof-adb", "/Users/me/android"]',
  // the Home Assistant app's docs: the connector URL, Android's daemon, the androidtv integration
  'https://<your-host>/private_<token>/mcp', 'adbd', 'adb-shell', 'adb_server_ip', 'unique_id',
  // the release asset tools/pack-mcpb.mjs names brickproof-adb-${version}.mcpb (checked by its own run)
  'brickproof-adb-1.0.0.mcpb',
  // statuses and fields described, not quoted
  'resumed: A -> B', 'resumed: unchanged (A)', 'resumed: unknown', 'ui: changed', 'ui: unchanged', 'unchanged', 'Visible now:',
  '(frame WxH)', '@(x,y)', 'screen:', 'true', 'false', '1', '0', ';', ':', '"0"', '"no"', '"none"', '"activity"', '"ui"',
  'network_guard', 'status', 'dry_run', 'dry_run=false', 'dry_run=true', 'force', 'force=true', 'force_network', 'force_network=true',
  'batch_size', 'mode', 'mode=disable', 'mode=uninstall', 'serial', 'host', 'packages', 'uri', 'intent_action', 'extras', 'abi', 'density',
  'locales', 'quality', 'max_px', 'max_steps', 'index', 'text', 'desc', 'resource_id', 'timeout_sec', 'lines', 'filter', 'keep_data', 'store',
  'coords', 'verify', 'duration_ms', 'code',
]);

// Templates of the source ---------------------------------------------------------
// Every template string with ${…} becomes a regex, ${…} matching anything.
// In .js files a scanner finds the template literals (nested ones included,
// comments and quoted strings skipped), and each line of a template written
// with \n is a regex of its own; other files are read with a simple pattern.
const PY_SPECIAL = new Set('()[]{}?*+-|^$\\.&~# \t\n\r\v\f');
function pyEscape(ch) {
  return PY_SPECIAL.has(ch) ? '\\' + ch : ch;
}

// A ${…} matches anything but " — ", the separator between a refused package
// and its sources.
const HOLE_RX = '(?:(?! — ).)*?';

function templateRegex(t) {
  let rx = '';
  let i = 0;
  while (i < t.length) {
    if (t.startsWith('${', i)) {
      let depth = 1, j = i + 2;
      while (j < t.length && depth) {
        if (t[j] === '{') depth++;
        else if (t[j] === '}') depth--;
        j++;
      }
      rx += HOLE_RX;
      i = j;
    } else {
      rx += pyEscape(t[i]);
      i++;
    }
  }
  return rx;
}

function jsTemplates(src) {
  const out = [];
  const skipQuote = start => {
    const q = src[start];
    let j = start + 1;
    while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
    return j;
  };
  const readTemplate = start => {
    let j = start + 1;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') return j;
      if (c === '$' && src[j + 1] === '{') {
        let depth = 1;
        j += 2;
        while (j < src.length && depth) {
          const d = src[j];
          if (d === '`') { j = readTemplate(j) + 1; continue; }
          if (d === "'" || d === '"') { j = skipQuote(j) + 1; continue; }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
        }
        continue;
      }
      j++;
    }
    return j;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    if (c === "'" || c === '"') { i = skipQuote(i) + 1; continue; }
    if (c === '`') { const end = readTemplate(i); out.push(src.slice(i + 1, end)); i = end + 1; continue; }
    i++;
  }
  return out;
}

const TEMPLATES = [];
function addTemplate(t) {
  if (!t.includes('${')) return;
  for (const piece of [t, ...t.split('\\n')]) {
    const rx = templateRegex(piece);
    // At least 7 characters of fixed text: a template such as "${a} · ${b}"
    // would match almost any line.
    if (rx.split(HOLE_RX).join('').replace(/\\(.)/g, '$1').length >= 7) TEMPLATES.push(new RegExp('^' + rx + '$'));
  }
}
for (const [r, p] of SRC_FILES) {
  const text = read(r, p);
  if (p.endsWith('.js')) for (const t of jsTemplates(text)) addTemplate(t);
  else for (const m of text.matchAll(/`((?:[^`\\]|\\[^\n])*)`/g)) addTemplate(m[1]);
}

// Placeholders in docs (<path>, N, M, X, Y) stand for ${...} in the source.
const HOLE = '\x00';
const SRC_HOLES = SRC.replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, HOLE);

function holes(s) {
  s = s.replace(/<[^<>]+>/g, HOLE);
  return s.replace(new RegExp(`(?<!${W})[NMXY](?!${W})`, 'gu'), HOLE);
}

const results = { checked: 0, external: 0, commands: 0, configs: 0, failed: [] };

function fail(where, what) {
  results.failed.push(`${where}: ${what}`);
}

// A repository path that exists, such as `src/http.js`.
function existingPath(cand) {
  if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(cand)) return false;
  return fs.existsSync(path.join(ROOT, cand)) || (APP !== null && fs.existsSync(path.join(APP, cand)));
}

function found(cand) {
  if (SRC.includes(cand)) return true;
  if (existingPath(cand)) return true;
  if (TEMPLATES.some(t => t.test(cand))) return true;
  const sq = squash(cand);
  if (sq && SRC_SQ.includes(sq)) return true;
  const h = holes(cand);
  if (h.includes(HOLE) && SRC_HOLES.includes(h)) return true;
  return false;
}

function stripFences(text) {
  // Indentation only, never a line break: a fence inside a list item or a
  // quote closes at its own indentation.
  return text.replace(/^([ \t>]*)(```|````)[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '');
}

// A line quoted repr()-style for the failure message.
function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f) out += '\\x' + ch.codePointAt(0).toString(16).padStart(2, '0');
    else out += ch;
  }
  return q + out + q;
}

// A span that names a tool call: `adb_x arg=value …` — the tool must exist
// and every argument must be one of its parameters.
const PARAMS = Object.fromEntries(require(path.join(ROOT, 'src/registry.js')).TOOLS.map(t => [t.name, Object.keys(t.inputSchema.properties)]));
function toolCall(where, span) {
  const m = /^(adb_[a-z_]+)((?:\s+[a-z_]+=\S.*?)*)$/.exec(span);
  if (!m || !TOOLS.includes(m[1])) return false;
  for (const [, arg] of m[2].matchAll(/\s([a-z_]+)=/g))
    if (!PARAMS[m[1]].includes(arg)) fail(where, `\`${span}\`: ${m[1]} has no parameter ${arg}`);
  return true;
}

// Inline backtick spans ---------------------------------------------------------
for (const d of DOC_FILES) {
  const body = stripFences(d.text);
  for (const [, span] of body.matchAll(/`([^`\n]+)`/g)) {
    results.checked++;
    if (TOOLS.includes(span)) continue;
    if (EXTERNAL.has(span)) { results.external++; continue; }
    if (toolCall(d.name, span)) continue;
    // `brickproof-adb …` commands are checked against the CLI, not as strings.
    if (/(^|\s)brickproof-adb (serve|token|check|set|get-adb)\b/.test(span) || /^brickproof-adb --/.test(span)) {
      checkCommand(d.name, span);
      continue;
    }
    const parts = span.split('…').map(p => p.trim()).filter(Boolean);
    if (!parts.every(found)) fail(d.name, `\`${span}\` not found in source`);
  }
}

// `brickproof-adb …` commands ----------------------------------------------------
// The text after the last "brickproof-adb " that starts a command; flags and
// the command must appear in the CLI's usage text.
function checkCommand(where, line) {
  const all = [...line.replace(/\\$/, '').matchAll(/(?:^|[\s"'=])brickproof-adb(?=\s|$)((?:\s+[^\s|;&]+)*)/g)];
  const m = all.reverse().find(x => /^\s*(serve|token|check|set|get-adb|--version|--help)\b/.test(x[1]));
  if (!m) return;
  results.commands++;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  for (const w of words) {
    if (!w.startsWith('--')) continue;
    const flag = w.split('=')[0];
    if (!CLI.USAGE.includes(flag)) fail(where, `flag ${flag} not in the CLI usage: ${pyRepr(line)}`);
  }
  // `set <key> <value...>`: the key exists and the value parses (a placeholder
  // such as <folder> is left to the reader).
  if (words[0] === 'set' && words.length > 1) {
    const key = words[1];
    if (!CONFIG.SETTABLE.includes(key)) fail(where, `set: unknown setting ${key}: ${pyRepr(line)}`);
    else if (words.length > 2 && !words.slice(2).some(w => /^<.*>$/.test(w))) {
      try { CONFIG.settingValue(key, words.slice(2), ROOT); } catch (e) { fail(where, `set ${key}: ${e.message}: ${pyRepr(line)}`); }
    }
  }
}

// Fenced blocks: output lines, commands, configs ----------------------------------
// Lines that look like server output. "Error: " is the dispatcher's prefix and
// is matched without it.
const FORMAT_LINE = /^(REFUSED|The full set|Nothing was applied|screen \d|⚠ |Error: |\[req\] |\[tool\] |brickproof-adb[: ]\S|APK: |Device: SDK|Would run: |dry_run|Bundle: |Chose \d|Tapped |Focus |\[(BTN|TXT)\]|adb could not start|adb \w+ timed out|error: |the screenshot is stale|host_path |Authorization: Bearer|\/private_| {2}(·|\/|com\.|[A-Z]:\\)|adb_shell is disabled|The snapshot file |(?:\d{1,3}\.){3}\d{1,3}:\d+ \(|adb-\S+ (?:\d{1,3}\.){3}\d{1,3}:\d+ \()/;

// Lines built from several literals, as a shape plus the source text that
// builds them (which must still be there).
const SHAPES = [
  [/^ {2}\S+ — /, "`  ${p} — ${from.length ? from.join(', ') : 'source not recorded'}`"],
  [/^ {2}· \S+ - listening on ports? /, 'currently serving ${h.serving.join(\', \')}'],
  [/^Nothing was applied\. Repeat with force_network: true to override; `force` does not lift this guard\.$/, "'Nothing was applied. Repeat with force_network: true to override; ' +\n    '`force` does not lift this guard.'"],
  [/^Device: SDK \d+, ABI \S+, \d+ dpi, locale \S+$/, "`Device: SDK ${props.sdk}, ABI ${(props.abilist || []).join(',') || '?'}, ` +\n    `${props.density || '?'} dpi, locale ${props.locale || '?'}`"],
  [/^Would run: \S+ -r -t -g .+ on .+$/, "`Would run: ${verb} -r -t -g ${apks.map(p => path.basename(p)).join(' ')} `"],
  [/^screen \d+x\d+(?: \(frame \d+x\d+\))? -> image \d+x\d+ · scale [\d.]+\/[\d.]+ · pass coords="screenshot" to adb_tap\/adb_swipe$/, '`pass coords="screenshot" to adb_tap/adb_swipe${fallbackNote}`'],
  [/^the screenshot is stale or was never taken - call adb_screenshot\. Pass serial /, "'the screenshot is stale or was never taken - call adb_screenshot. ' +"],
  [/^\[(?:BTN|TXT)\](?:\[FOCUSED\])?(?:\[PASSWORD\])? .* @\(\d+,\d+\) bounds=\[\d+,\d+\]\[\d+,\d+\]$/, '` @(${n.x},${n.y}) bounds=${n.bounds}`'],
  [/^ {2}\S.*  \d+(?:\.\d)? (?:MB|KB)  \d{4}-\d\d-\d\d \d\d:\d\d$/, '`  ${f.path}  ${sizeText(f.size)}  ${localTime(f.mtime)}`'],
  [/^Focus is cycling: back on ".*", already visited on this walk /, '`Focus is cycling: back on "${nodeLabel(cur, nodes) || \'(no label)\'}", already visited on this walk `'],
  [/^⚠ the adb server was started by another adb on this machine /, "'so network devices may need adb_connect again. Set adb_path"],
];

function matchesSource(line) {
  const l = line.replace(/^Error: /, '');
  for (const cand of [l, l.replace(/^ {2}· /, '')]) {
    if (SRC.includes(cand)) return true;
    if (TEMPLATES.some(t => t.test(cand))) return true;
  }
  if (SHAPES.some(([rx, needle]) => rx.test(line) && SRC.includes(needle))) return true;
  return false;
}

for (const d of DOC_FILES) {
  for (const [, info, block] of d.text.matchAll(/^[ \t>]*```([^\n]*)\n([\s\S]*?)^[ \t>]*```/gm)) {
    const lang = info.trim();
    const lines = block.split('\n').map(l => l.replace(/^[ \t]*> ?/, ''));
    if (lang === 'json') {
      let obj;
      try { obj = JSON.parse(lines.join('\n')); } catch (e) { fail(d.name, `JSON block does not parse: ${e.message}`); continue; }
      if (obj && typeof obj === 'object' && !obj.mcpServers) {
        results.configs++;
        try { CONFIG.parseConfig(obj, `${d.name} JSON block`); } catch (e) { fail(d.name, e.message); }
      }
      continue;
    }
    for (const raw of lines) {
      const line = raw.replace(/^\s+(?=\S)/, m => (/^ {2}(·|\/|com\.|[A-Z]:\\)/.test(raw) || / — /.test(raw) ? m : ''));
      if (/(^|\s|")brickproof-adb (serve|token|check|set|get-adb)\b|^brickproof-adb --/.test(line) && !/^brickproof-adb: /.test(line) && !/^brickproof-adb \d/.test(line)) {
        checkCommand(d.name, line);
        continue;
      }
      if (!FORMAT_LINE.test(line)) continue;
      results.checked++;
      if (matchesSource(line) || matchesSource(raw)) continue;
      fail(d.name, `output line matches no template: ${pyRepr(raw)}`);
    }
  }
}

// Templates the documentation quotes must exist.
for (const needle of ['screen ${rec.screenW}x${rec.screenH}${frameNote} -> image ${geom.w}x${geom.h}',
                      'REFUSED: the list contains protected packages - ${hit.join(\', \')}.',
                      'dry_run was not passed - adb_install only reports unless dry_run=false.']) {
  results.checked++;
  if (!SRC.includes(needle)) fail('src', `expected template missing: ${needle}`);
}

// No "Access denied" and no Home Assistant paths in the core docs -------------
for (const d of DOC_FILES.filter(x => x.root === ROOT)) {
  results.checked++;
  if (d.text.includes('Access denied')) fail(d.name, 'contains "Access denied"');
  // Allowed only in a line that says it is about Home Assistant.
  d.text.split('\n').forEach((line, i) => {
    if (/\/media\b|\/share\b|add-on|addon/i.test(line) && !/Home Assistant/.test(line))
      fail(d.name, `line ${i + 1}: Home Assistant wording (/media, /share, add-on) in a core document`);
  });
}

// No Cyrillic in echo lines of the shell scripts --------------------------------
const SH = APP && fs.existsSync(path.join(APP, 'adb_mcp/run.sh')) ? [[APP, 'adb_mcp/run.sh']] : [];
for (const [r, f] of SH) {
  read(r, f).split('\n').forEach((line, i) => {
    if (/echo|bashio::log/.test(line)) {
      results.checked++;
      if (CYR.test(line)) fail(f, `line ${i + 1}: Cyrillic in a message`);
    }
  });
}

// Every UPPER_SNAKE name in the docs exists in the source ----------------------
const CODE_RE = new RegExp(`(?<!${W})([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?!${W})`, 'gu');
// Android names in examples, not claims about this code.
const NOT_CODES = new Set(['X_FORWARDED_FOR', 'CF_CONNECTING_IP', 'APPLICATION_DETAILS_SETTINGS']);
const codesSeen = new Set();
for (const d of DOC_FILES) {
  for (const [, code] of d.text.matchAll(CODE_RE)) {
    if (NOT_CODES.has(code)) continue;
    codesSeen.add(code);
    results.checked++;
    if (!SRC.includes(code)) fail(d.name, `name ${code} is documented but not in the source`);
  }
}

// docs/tools.md covers exactly TOOLS ---------------------------------------------
const toolsMd = DOC_FILES.find(d => d.name === 'docs/tools.md').text;
const headed = [...toolsMd.matchAll(/^### `([a-z_]+)`$/gm)].map(m => m[1]);
for (const t of TOOLS) {
  results.checked++;
  if (!headed.includes(t)) fail('docs/tools.md', `tool ${t} has no heading`);
}
for (const h of headed) {
  results.checked++;
  if (!TOOLS.includes(h)) fail('docs/tools.md', `heading ${h} is not in TOOLS`);
}
if (TOOLS.length !== 18) fail('registry.js', `TOOLS has ${TOOLS.length} entries, expected 18`);
const readme = DOC_FILES.find(d => d.name === 'README.md').text;
for (const t of TOOLS) {
  results.checked++;
  if (!readme.includes(`- \`${t}\``)) fail('README.md', `tool ${t} missing from the tool list`);
}

// Links ----------------------------------------------------------------------------
function slug(h) {
  return h.toLowerCase().replace(new RegExp(`[^\\p{L}\\p{N}_\\- ]`, 'gu'), '').trim().replaceAll(' ', '-');
}

const REPOS = { 'st412m/brickproof-adb': ROOT, ...(APP ? { 'st412m/ha-adb-mcp': APP } : {}) };

function checkTarget(where, p, anchor, link) {
  if (!fs.existsSync(p)) { fail(where, `broken link ${link}`); return; }
  if (anchor && fs.statSync(p).isFile()) {
    const heads = [...fs.readFileSync(p, 'utf8').matchAll(/^#+ (.+)$/gm)].map(m => m[1]);
    if (!new Set(heads.map(slug)).has(anchor)) fail(where, `missing anchor ${link}`);
  }
}

for (const d of DOC_FILES) {
  for (const [, link] of d.text.matchAll(/\]\(([^)\s]+)\)/g)) {
    results.checked++;
    const hash = link.indexOf('#');
    const target = hash === -1 ? link : link.slice(0, hash);
    const anchor = hash === -1 ? '' : link.slice(hash + 1);
    const gh = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|tree)\/main\/(.+)$/.exec(target);
    if (gh) {
      if (REPOS[gh[1]]) checkTarget(d.name, path.join(REPOS[gh[1]], gh[2]), anchor, link);
      continue;
    }
    if (d.name === 'app/adb_mcp/DOCS.md') {
      if (!link.startsWith('https://')) fail(d.name, `relative link ${link}`);
      continue;
    }
    if (/^https?:\/\//.test(link)) continue;
    const base = path.dirname(path.join(d.root, d.file));
    checkTarget(d.name, target ? path.normalize(path.join(base, target)) : path.join(d.root, d.file), anchor, link);
  }
}

console.log(`docs: ${DOC_FILES.map(d => d.name).join(', ')}`);
console.log(`tools in TOOLS: ${TOOLS.length}`);
console.log(`names in UPPER_SNAKE_CASE in docs: ${codesSeen.size}`);
console.log(`candidates checked: ${results.checked}`);
console.log(`brickproof-adb command lines checked: ${results.commands}`);
console.log(`config blocks parsed: ${results.configs}`);
console.log(`external (allow-listed, not code claims): ${results.external}`);
console.log(`failed: ${results.failed.length}`);
for (const f of results.failed) console.log('  FAIL ' + f);
process.exit(results.failed.length ? 1 : 0);
