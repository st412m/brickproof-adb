'use strict';
// The 18 tools: names, titles and hints as in ha-adb-mcp 1.4.0, and the
// description rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS } = require('../src/registry.js');

// name: [title, readOnly, destructive, idempotent, openWorld]
const TABLE = {
  adb_devices: ['List devices', true, false, true, false],
  adb_connect: ['Connect device', false, false, true, false],
  adb_pair: ['Pair device', false, false, false, false],
  adb_disconnect: ['Disconnect device', false, false, true, false],
  adb_shell: ['Run shell command', false, true, false, false],
  adb_screenshot: ['Take screenshot', true, false, true, false],
  adb_ui_dump: ['Dump UI hierarchy', true, false, true, false],
  adb_tap: ['Tap', false, false, false, false],
  adb_swipe: ['Swipe', false, false, false, false],
  adb_text: ['Type text', false, false, false, false],
  adb_key: ['Send key', false, false, false, false],
  adb_find_and_tap: ['Find and tap element', false, false, false, false],
  adb_install: ['Install app', false, true, false, false],
  adb_uninstall: ['Uninstall app', false, true, true, false],
  adb_push: ['Push file to device', false, true, true, false],
  adb_pull: ['Pull file from device', false, true, true, false],
  adb_logcat: ['Read logcat', true, false, true, false],
  adb_app: ['Manage packages', false, true, false, false],
};

// The parameters of 1.4.0, unchanged.
const PARAMS = {
  adb_devices: ['discover'], adb_connect: ['host'], adb_pair: ['host', 'code'], adb_disconnect: ['host'],
  adb_shell: ['command', 'serial', 'timeout_sec'], adb_screenshot: ['serial', 'quality', 'max_px'], adb_ui_dump: ['serial'],
  adb_tap: ['x', 'y', 'serial', 'coords', 'verify'], adb_swipe: ['x1', 'y1', 'x2', 'y2', 'duration_ms', 'serial', 'coords', 'verify'],
  adb_text: ['text', 'serial'], adb_key: ['key', 'serial', 'verify'],
  adb_find_and_tap: ['text', 'resource_id', 'desc', 'exact', 'index', 'max_steps', 'serial'],
  adb_install: ['apk_path', 'dir', 'abi', 'density', 'locales', 'dry_run', 'serial'], adb_uninstall: ['package', 'keep_data', 'serial'],
  adb_push: ['host_path', 'device_path', 'serial'], adb_pull: ['device_path', 'host_path', 'serial'],
  adb_logcat: ['filter', 'lines', 'serial'],
  adb_app: ['action', 'packages', 'uri', 'intent_action', 'extras', 'serial', 'filter', 'q', 'scope', 'mode', 'dry_run',
    'batch_size', 'canary', 'backup', 'force', 'force_network', 'store'],
};

test('18 tools, the 1.4.0 names in order', () => {
  assert.deepEqual(TOOLS.map(t => t.name), Object.keys(TABLE));
});

test('title and four boolean hints as in 1.4.0; annotations.title == title', () => {
  for (const t of TOOLS) {
    const [title, ro, de, id, ow] = TABLE[t.name];
    assert.equal(t.title, title, t.name);
    assert.equal(t.annotations.title, t.title, t.name);
    assert.deepEqual(
      [t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.idempotentHint, t.annotations.openWorldHint],
      [ro, de, id, ow], t.name);
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])
      assert.equal(typeof t.annotations[k], 'boolean', `${t.name}.${k}`);
  }
});

test('parameters are those of 1.4.0', () => {
  for (const t of TOOLS) assert.deepEqual(Object.keys(t.inputSchema.properties), PARAMS[t.name], t.name);
});

test('every parameter has a description of at most 200 characters', () => {
  for (const t of TOOLS) {
    for (const [k, p] of Object.entries(t.inputSchema.properties)) {
      assert.ok(p.description, `${t.name}.${k} has no description`);
      assert.ok(p.description.length <= 200, `${t.name}.${k}: ${p.description.length}`);
    }
  }
});

test('descriptions: no Home Assistant wording', () => {
  const all = JSON.stringify(TOOLS);
  for (const bad of ['HA filesystem', 'HA side', 'add-on', 'addon', '/media', '/share'])
    assert.ok(!all.includes(bad), bad);
});

test('descriptions: when this tool and not its neighbour, and the reverse tool', () => {
  const d = Object.fromEntries(TOOLS.map(t => [t.name, t.description]));
  const pairs = [
    ['adb_tap', 'adb_find_and_tap'], ['adb_find_and_tap', 'adb_tap'],
    ['adb_ui_dump', 'adb_screenshot'], ['adb_screenshot', 'adb_ui_dump'],
    ['adb_shell', 'adb_app'], ['adb_app', 'adb_shell'],
    ['adb_pair', 'adb_connect'], ['adb_connect', 'adb_pair'],
    ['adb_install', 'adb_uninstall'], ['adb_uninstall', 'adb_install'],
    ['adb_connect', 'adb_disconnect'], ['adb_disconnect', 'adb_connect'],
    ['adb_push', 'adb_pull'], ['adb_pull', 'adb_push'],
  ];
  for (const [a, b] of pairs) assert.ok(d[a].includes(b), `${a} does not mention ${b}`);
  assert.match(d.adb_app, /action=restore undoes it/);
});
