'use strict';
/**
 * brickproof-adb — the MCP dispatcher, shared by both transports (http.js,
 * stdio.js), plus the argument masking and error redaction of the tool log.
 *
 * init(settings) passes the settings to the tool modules once; no module reads
 * the environment itself. Every log line goes to stderr: in stdio mode stdout
 * belongs to the protocol.
 */

const { TOOLS, callTool } = require('./registry.js');
const { escapeInputText, sq, collectNotes } = require('./adb.js');
const { VERSION } = require('./version.js');

let LOG_REQUESTS = false;
let logSink = line => process.stderr.write(line + '\n');

/**
 * Pass the settings (config.js loadConfig().settings) to the modules, with
 * the action texts of the settings refusals (config.settingHints) and the adb
 * found by platform-tools.js. The defaults of every module are the safe ones:
 * shell and uninstall off, no file roots, no store.
 */
function init(settings = {}, { log, hints = {}, adbPath } = {}) {
  require('./adb.js').configure({ adbPath: adbPath || settings.adb_path });
  require('./session.js').configure({
    allowShell: settings.allow_shell === true,
    shellHint: hints.allow_shell,
    stateDir: settings.state_dir || null,
    scanSubnets: settings.scan_subnets || [],
  });
  require('./files.js').configure({ fileRoots: settings.file_roots || [], rootsHint: hints.file_roots });
  require('./apps.js').configure({
    allowShell: settings.allow_shell === true,
    allowUninstall: settings.allow_uninstall === true,
    store: settings.store || null,
    fileRoots: settings.file_roots || [],
    hints,
  });
  LOG_REQUESTS = settings.log_requests === true;
  if (log) logSink = log;
}

/**
 * Arguments are masked BEFORE the cut to 300 characters, so no secret
 * survives in a tail by luck of length. adb_shell.command is not masked: it is
 * an arbitrary administrator command with no fixed shape (the docs say so).
 */
function maskArgs(name, args) {
  const a = { ...(args || {}) };
  if (name === 'adb_text' && a.text !== undefined) a.text = `<${String(a.text).length} chars>`;
  if (name === 'adb_pair' && a.code !== undefined) a.code = '***';
  for (const k of Object.keys(a)) {
    if (/pass|secret|token/i.test(k)) a[k] = '***'; // a guard for future parameters
  }
  return a;
}

function fmtArgs(name, args) {
  try {
    const s = JSON.stringify(maskArgs(name, args));
    return s.length > 300 ? s.slice(0, 300) + '…' : s;
  } catch { return '(unserializable)'; }
}

/**
 * The second leak besides the arguments: free text of an error message (an
 * adb failure, a tool refusal) can carry the typed text or the pairing code.
 * Removed here: the text itself, its argument of `input text` (quoted with
 * sq() and bare) and its base64 form (the ADBKeyBoard broadcast). Values
 * shorter than 2 characters are left alone, or any one-letter match would cut
 * the message apart. Applied once, to the log line and to the text the client
 * gets alike.
 */
function redact(name, args, str) {
  if (!str) return str;
  let out = String(str);
  const wipe = secret => {
    if (secret === undefined || secret === null) return;
    const s = String(secret);
    if (s.length < 2) return;
    out = out.split(s).join('<secret>');
  };
  if (name === 'adb_text' && args && args.text !== undefined) {
    const t = String(args.text);
    wipe(t);
    wipe(sq(escapeInputText(t)));
    wipe(escapeInputText(t));
    wipe(Buffer.from(t, 'utf8').toString('base64'));
  }
  if (name === 'adb_pair' && args && args.code !== undefined) wipe(args.code);
  return out;
}

function fmtOutcome(content) {
  if (!Array.isArray(content) || !content.length) return 'ok';
  const c = content[0];
  if (c.type === 'image') return `image ${Math.round((c.data || '').length * 3 / 4 / 1024)}KB`;
  const len = (c.text || '').length;
  return `ok ${len}B`;
}

function logTool(name, args, t0, outcome) {
  if (!LOG_REQUESTS) return;
  logSink(`[tool] ${new Date().toISOString()} ${name} ${fmtArgs(name, args)} -> ${outcome} ${Date.now() - t0}ms`);
}

// The client's version is echoed when supported, otherwise the newest one.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

async function handleMcpRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: each request must be a JSON object' } };
  const { id, method, params } = body;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: negotiateProtocolVersion(params && params.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'brickproof-adb', version: VERSION }
    }};
  }

  if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'roots/list') return { jsonrpc: '2.0', id, result: { roots: [] } };

  if (method === 'tools/call') {
    const t0 = Date.now();
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const { value: content, notes } = await collectNotes(() => callTool(name, args));
      // No structuredContent: the tools declare no outputSchema.
      const out = notes.length ? [...content, { type: 'text', text: notes.join('\n') }] : content;
      logTool(name, args, t0, fmtOutcome(out));
      return { jsonrpc: '2.0', id, result: { content: out } };
    } catch (e) {
      // One redaction for the log line and the client text alike.
      const notes = e.adbNotes && e.adbNotes.length ? `\n${e.adbNotes.join('\n')}` : '';
      const msg = redact(name, args, e.message) + notes;
      logTool(name, args, t0, `ERROR: ${msg}`);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

module.exports = {
  init, TOOLS, handleMcpRequest,
  negotiateProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS,
  fmtArgs, redact, maskArgs, fmtOutcome,
};
