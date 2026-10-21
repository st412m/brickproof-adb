'use strict';
/**
 * registry.js — the tool schemas (tools/list) and the tools/call dispatcher.
 *
 * The registry knows nothing about the transport, and the tool modules know
 * nothing about JSON-RPC.
 */

const session = require('./session.js');
const ui = require('./ui.js');
const files = require('./files.js');
const apps = require('./apps.js');
const { coerceArray } = require('./adb.js');

/**
 * Title and MCP annotations. The title goes in twice: top-level `title`
 * (protocol 2025-06-18) and `annotations.title` (2025-03-26, read by older
 * clients). All four hints are explicit booleans: connector catalogues reject
 * a tool with a missing hint, and the schema defaults (destructive=true,
 * openWorld=true) are wrong here. A hint describes the tool's WORST case
 * (adb_app is destructive though list/info only read). Input tools are not
 * destructive; the risk of repeated wrong passwords is handled by the
 * adb_text description, which the model reads.
 */
function meta(title, h) {
  return {
    title,
    annotations: {
      title,
      readOnlyHint: h.readOnly,
      destructiveHint: h.destructive,
      idempotentHint: h.idempotent,
      openWorldHint: h.openWorld,
    },
  };
}

const SERIAL = { type: 'string', description: 'Device serial from adb_devices. Optional when exactly one device is connected.' };

const TOOLS = [
  {
    name: 'adb_devices',
    ...meta('List devices', { readOnly: true, destructive: false, idempotent: true, openWorld: false }),
    description: 'List connected Android devices with serial, state and description (adb devices -l), and remembered addresses that are not connected now. Start here: the other tools take serial from this list. If the device the user means is not in the list, call again with discover=true: it searches the local network for devices to connect (mDNS and port 5555), any time and as often as needed, and connects none of them.',
    inputSchema: { type: 'object', properties: {
      discover: { type: 'boolean', description: 'Search the local network (about 10 s) for devices with network or Wireless debugging on; returns candidates and the next step for each. Default false.' }
    } }
  },
  {
    name: 'adb_connect',
    ...meta('Connect device', { readOnly: false, destructive: false, idempotent: true, openWorld: false }),
    description: 'Connect to a device over network ADB. host is ip or ip:port (default port 5555). An Android 11+ phone with Wireless debugging is paired once with adb_pair first; after that adb_connect is enough. The reverse is adb_disconnect.',
    inputSchema: { type: 'object', properties: {
      host: { type: 'string', description: 'Device address: ip (port 5555 implied) or ip:port, e.g. 192.0.2.50 or 192.0.2.50:5555.' }
    }, required: ['host'] }
  },
  {
    name: 'adb_pair',
    ...meta('Pair device', { readOnly: false, destructive: false, idempotent: false, openWorld: false }),
    description: 'Pair with an Android 11+ device over Wireless Debugging, once per device and computer; afterwards adb_connect alone reconnects. On the device: Developer options -> Wireless debugging -> "Pair device with pairing code" shows ip:port and a 6-digit code. The pairing port is random and differs from the connect port; after pairing succeeds, call adb_connect with the ip:port shown on the main Wireless debugging screen.',
    inputSchema: { type: 'object', properties: {
      host: { type: 'string', description: 'ip:port from the pairing dialog (random port, NOT 5555)' },
      code: { type: 'string', description: '6-digit pairing code from the dialog' }
    }, required: ['host', 'code'] }
  },
  {
    name: 'adb_disconnect',
    ...meta('Disconnect device', { readOnly: false, destructive: false, idempotent: true, openWorld: false }),
    description: 'Disconnect a network ADB device, the reverse of adb_connect. Omit host to disconnect every network device. adb_disconnect then adb_connect recovers a device that adb_devices lists as offline. With host the address is also forgotten and not reconnected at start.',
    inputSchema: { type: 'object', properties: {
      host: { type: 'string', description: 'ip:port as listed by adb_devices. Omit to disconnect all network devices.' }
    } }
  },
  {
    name: 'adb_shell',
    ...meta('Run shell command', { readOnly: false, destructive: true, idempotent: false, openWorld: false }),
    description: 'Run a shell command on the device (settings, pm, am, dumpsys, getprop, wm, cmd, svc...) and return stdout. It bypasses every guard rail, so it works only while the server option allow_shell is on. For package changes use adb_app instead: dry runs, a protected set, a network guard and a rollback snapshot.',
    inputSchema: { type: 'object', properties: {
      command: { type: 'string', description: 'Command line for the device shell, e.g. "getprop ro.build.version.release". Logged verbatim with log_requests: type secrets with adb_text instead.' },
      serial: SERIAL,
      timeout_sec: { type: 'number', description: 'Time limit in seconds, default 30, at most 120. Past it the call fails with "timed out".' }
    }, required: ['command'] }
  },
  {
    name: 'adb_screenshot',
    ...meta('Take screenshot', { readOnly: true, destructive: false, idempotent: true, openWorld: false }),
    description: 'Take a screenshot of the device screen. Returns a JPEG image, then a text line with the logical screen size, the image size and the scale between them, e.g. "screen 1080x2340 -> image 473x1024 · scale 2.283/2.285". Pass coords="screenshot" to adb_tap/adb_swipe to tap coordinates read off that image. A near-uniformly dark frame is a warning after the image, not a refusal. To read labels and exact tap points, adb_ui_dump is cheaper and precise; the screenshot shows what the dump cannot (images, video, games).',
    inputSchema: { type: 'object', properties: {
      serial: SERIAL,
      quality: { type: 'number', description: 'JPEG quality 30-95, default 70' },
      max_px: { type: 'number', description: 'Max dimension 320-1920, default 1024' }
    } }
  },
  {
    name: 'adb_ui_dump',
    ...meta('Dump UI hierarchy', { readOnly: true, destructive: false, idempotent: true, openWorld: false }),
    description: 'Dump the current UI hierarchy (uiautomator) as a compact list of interactive/labeled elements with tap coordinates @(x,y). Password fields are marked [PASSWORD] and listed even with no visible text. Use together with adb_tap. Prefer it over adb_screenshot for labels and tap targets; use adb_screenshot for content the dump does not see (images, video, some WebViews and games).',
    inputSchema: { type: 'object', properties: { serial: SERIAL } }
  },
  {
    name: 'adb_tap',
    ...meta('Tap', { readOnly: false, destructive: false, idempotent: false, openWorld: false }),
    description: 'Tap at (x, y). coords="screen" (default): coordinates from adb_ui_dump, the logical space input tap uses. coords="screenshot": coordinates off the last adb_screenshot for the SAME serial, rescaled; missing or older than 120s is refused. Rotation between screenshot and tap is not checked. verify="activity"|"ui" reports whether the tap changed anything; a failed verify never turns a performed tap into an error. To activate an element by its label, adb_find_and_tap does it in one call and also works on TV boxes without a touchscreen.',
    inputSchema: { type: 'object', properties: {
      x: { type: 'number', description: 'X in pixels, in the space chosen by coords.' },
      y: { type: 'number', description: 'Y in pixels, same space.' },
      serial: SERIAL,
      coords: { type: 'string', enum: ['screen', 'screenshot'], description: 'Coordinate space, default "screen". "screenshot" = pixels read off the last adb_screenshot image for this serial, rescaled automatically; refused if that screenshot is missing or older than 120s.' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'Default "none". "activity" compares the resumed activity before/after. "ui" also hashes the UI dump (~2-4s); a clock or timer ticking on its own can make it report "changed". "unchanged" is reliable.' },
    }, required: ['x', 'y'] }
  },
  {
    name: 'adb_swipe',
    ...meta('Swipe', { readOnly: false, destructive: false, idempotent: false, openWorld: false }),
    description: 'Swipe from (x1,y1) to (x2,y2) over duration_ms (default 300). The same point at both ends with duration_ms >= 800 is a long-press. coords and verify work as in adb_tap and both endpoints share one coordinate space; with verify="ui", an "unchanged" result on a swipe usually means the end of a scrollable list. On a TV box without a touchscreen, move the focus with adb_key DPAD_* instead.',
    inputSchema: { type: 'object', properties: {
      x1: { type: 'number', description: 'Start X in pixels, in the space chosen by coords.' },
      y1: { type: 'number', description: 'Start Y in pixels.' },
      x2: { type: 'number', description: 'End X in pixels.' },
      y2: { type: 'number', description: 'End Y in pixels.' },
      duration_ms: { type: 'number', description: 'Duration in ms, default 300.' },
      serial: SERIAL,
      coords: { type: 'string', enum: ['screen', 'screenshot'], description: 'Coordinate space for BOTH endpoints, default "screen". See adb_tap for the "screenshot" semantics and its 120s TTL.' },
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'See adb_tap. For a swipe, "ui" reporting "unchanged" usually means you hit the end of a scrollable list rather than that nothing happened.' },
    }, required: ['x1', 'y1', 'x2', 'y2'] }
  },
  {
    name: 'adb_text',
    ...meta('Type text', { readOnly: false, destructive: false, idempotent: false, openWorld: false }),
    description: 'Type text into the focused input field. Focus the field first; on a TV box, DPAD_CENTER on the field opens the keyboard. For single keys (ENTER, BACK) use adb_key. ASCII goes through input text; non-ASCII (Cyrillic, emoji, CJK) is sent via the ADBKeyBoard IME, which must be installed on the device (github.com/senzhk/ADBKeyBoard): the current keyboard is switched to it and restored afterwards. The response reports only the character count, never the text itself. Never retry a wrong password or PIN: repeated failures can lock the account or device. Stop and ask the user.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Text to type into the focused field. Only its length appears in the response and the log.' },
      serial: SERIAL
    }, required: ['text'] }
  },
  {
    name: 'adb_key',
    ...meta('Send key', { readOnly: false, destructive: false, idempotent: false, openWorld: false }),
    description: 'Send a keyevent. Accepts names (HOME, BACK, ENTER, DPAD_UP, POWER, VOLUME_UP, MENU, TAB...) or numeric codes. On TV boxes DPAD_UP/DOWN/LEFT/RIGHT move the focus and DPAD_CENTER presses it. verify="activity"|"ui" reports whether the key changed anything; see adb_tap for the same parameter. For text use adb_text; for a labelled element, adb_find_and_tap.',
    inputSchema: { type: 'object', properties: {
      key: { type: 'string', description: 'Key name (HOME, BACK, ENTER, DPAD_CENTER, WAKEUP...; the KEYCODE_ prefix is optional) or a numeric keycode.' },
      serial: SERIAL,
      verify: { type: 'string', enum: ['none', 'activity', 'ui'], description: 'Default "none". See adb_tap.' },
    }, required: ['key'] }
  },
  {
    name: 'adb_find_and_tap',
    ...meta('Find and tap element', { readOnly: false, destructive: false, idempotent: false, openWorld: false }),
    description:
      'Find an on-screen element by text, resource-id or content-desc and activate it.\n' +
      'The method is derived from the device: with a touchscreen the element centre is tapped; on leanback without one the focus is walked there with DPAD keys, since a coordinate tap activates whatever has focus.\n' +
      'If the focus stalls, cycles, or the target is not reached in max_steps or the time budget, nothing is pressed and the tool reports where it stopped.\n' +
      'Prefer it over adb_ui_dump plus adb_tap when the label is known; use adb_tap for a point that has no label.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'Visible label to match, checked against both the text attribute and content-desc (substring by default, case-insensitive). Some TV launchers put every label in content-desc and leave text empty.' },
      resource_id: { type: 'string', description: 'resource-id; the part after "/" is enough' },
      desc: { type: 'string', description: 'content-desc to match' },
      exact: { type: 'boolean', description: 'Require an exact match instead of substring. Default false.' },
      index: { type: 'number', description: 'Which match to use when several elements match. Without it, several matches are an error listing the candidates.' },
      max_steps: { type: 'number', description: 'Max DPAD steps on leanback devices, default 12, max 40. Each step re-dumps the UI (~1.5-2s) and the walk also stops after an internal ~25s budget, returning a report instead of timing out.' },
      serial: SERIAL
    } }
  },
  {
    name: 'adb_install',
    ...meta('Install app', { readOnly: false, destructive: true, idempotent: false, openWorld: false }),
    description: 'Installs only with dry_run=false; by default it reports what would be installed and installs nothing.\n' +
      'Installs an APK from the server\'s file roots (file_roots). apk_path takes a single .apk, an array of split-APK paths, or one .apks/.xapk/.apkm bundle.\n' +
      'Without apk_path it installs nothing and lists the installable files in file_roots, newest first, with the full path to pass as apk_path: start there when the user says "install what I downloaded".\n' +
      'Bundle splits are chosen from the device ABI list, density and locale. No matching ABI split is a refusal; a density mismatch is not.\n' +
      'Flags -r, -t and -g are applied by default. The reverse is adb_uninstall, or adb_app for a removal with a backup and a rollback.',
    inputSchema: { type: 'object', properties: {
      apk_path: { type: ['string', 'array'], items: { type: 'string' }, description: 'Single APK path, array of split-APK paths, or one .apks/.xapk/.apkm bundle. Without it: a list of the installable files in file_roots, newest first; nothing is installed.' },
      dir: { type: 'string', description: 'Only without apk_path: the list shows the top level and one level of subfolders; for a deeper folder pass it here, listed the same way. Ignored when apk_path is given.' },
      abi: { type: 'string', description: 'Bundle only: force an ABI instead of the device default (e.g. armeabi-v7a)' },
      density: { type: 'number', description: 'Bundle only: force a screen density in dpi instead of the device value' },
      locales: { type: ['string', 'array'], items: { type: 'string' }, description: 'Bundle only: extra language splits to include alongside the device language (e.g. ["ru"] on an en-US device)' },
      dry_run: { type: 'boolean', default: true, description: 'Default true: report the files, the command and the device (for a bundle, also the chosen splits) and install nothing. Only false installs.' },
      serial: SERIAL
    } }
  },
  {
    name: 'adb_uninstall',
    ...meta('Uninstall app', { readOnly: false, destructive: true, idempotent: true, openWorld: false }),
    description: 'Uninstall an app by package name, at once and without a backup. keep_data=true keeps app data (-k). The reverse is adb_install. For system packages, reversible bulk operations and backups, use adb_app.',
    inputSchema: { type: 'object', properties: {
      package: { type: 'string', description: 'Package name, e.g. com.example.app (adb_app action=list lists them).' },
      keep_data: { type: 'boolean', description: 'Keep the app data and cache (-k). Default false.' },
      serial: SERIAL
    }, required: ['package'] }
  },
  {
    name: 'adb_push',
    ...meta('Push file to device', { readOnly: false, destructive: true, idempotent: true, openWorld: false }),
    description: 'Copy a file from the server\'s file roots (file_roots) to the device, overwriting a file of the same name there. To install an APK use adb_install instead. The reverse is adb_pull.',
    inputSchema: { type: 'object', properties: {
      host_path: { type: 'string', description: 'Absolute path of the file on the server, inside file_roots.' },
      device_path: { type: 'string', description: 'Destination on the device, e.g. /sdcard/Download/file.apk or /data/local/tmp/.' },
      serial: SERIAL
    }, required: ['host_path', 'device_path'] }
  },
  {
    name: 'adb_pull',
    ...meta('Pull file from device', { readOnly: false, destructive: true, idempotent: true, openWorld: false }),
    description: 'Copy a file from the device into the server\'s file roots (file_roots), overwriting a file of the same name and creating missing directories. The reverse is adb_push.',
    inputSchema: { type: 'object', properties: {
      device_path: { type: 'string', description: 'File on the device, e.g. /sdcard/Download/report.pdf.' },
      host_path: { type: 'string', description: 'Absolute destination path on the server, inside file_roots.' },
      serial: SERIAL
    }, required: ['device_path', 'host_path'] }
  },
  {
    name: 'adb_logcat',
    ...meta('Read logcat', { readOnly: true, destructive: false, idempotent: true, openWorld: false }),
    description: 'Read recent logcat lines without waiting for new ones, e.g. to see why an app crashed; unlike adb_shell it works with allow_shell off. filter: either a logcat filterspec like "ActivityManager:I *:S" (contains ":" or "*"; *:S is auto-appended if missing so unmatched tags are silenced) or a plain substring grepped case-insensitively across the whole line. lines limits the result (default 200). Filtering runs on the device.',
    inputSchema: { type: 'object', properties: {
      filter: { type: 'string', description: 'A filterspec such as "ActivityManager:I *:S" (has ":" or "*"), or a plain substring matched case-insensitively. Omit for the last lines unfiltered.' },
      lines: { type: 'number', description: 'How many lines to return, default 200, at most 2000.' },
      serial: SERIAL
    } }
  },
  {
    name: 'adb_app',
    ...meta('Manage packages', { readOnly: false, destructive: true, idempotent: false, openWorld: false }),
    description:
      'Package operations with guard rails: inspect, launch, stop, clear, disable, uninstall, back up and restore packages. Use it rather than adb_shell or adb_uninstall for package changes.\n' +
      'Every action that changes packages defaults to dry_run=true. A protected set derived from the device (launcher, active IME, installer, WebView provider, role holders, account packages) aborts the whole call on any overlap, and has no override.\n' +
      'A network guard refuses disable, uninstall, stop and clear while the package is serving an off-device client, naming the port and the peer. Only force_network=true lifts it; force covers a failed APK backup and nothing else.\n' +
      'An account canary between batches rolls a batch back and stops on a drop. Everything applied goes into a snapshot, so action=restore undoes it. mode=uninstall also needs the server option allow_uninstall and a successful APK backup.\n' +
      'action=launch also accepts uri and/or intent_action for an intent or deep link; CALL, CALL_PRIVILEGED and CALL_EMERGENCY are refused while allow_shell is false.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'info', 'protected', 'launch', 'stop', 'clear', 'disable', 'uninstall', 'enable', 'restore', 'backup', 'state'],
          description: 'list/info/protected/state only read. launch/stop/clear act at once (clear defaults to dry_run), stop/clear under the network guard. disable/uninstall/enable/restore default to dry_run.'
        },
        packages: { type: ['string', 'array'], items: { type: 'string' }, description: 'Package name or array of package names. For action=launch with uri/intent_action, at most one package is accepted (used as -p to narrow the resolver); it is otherwise optional there.' },
        uri: { type: 'string', description: 'action=launch only: deep-link / intent data URI (am start -d). Its presence, together with intent_action, selects the intent-based launch instead of resolving the package\'s main activity.' },
        intent_action: { type: 'string', description: 'action=launch only: intent action, default android.intent.action.VIEW when uri is set. Must match [A-Za-z0-9_.]+. See the CALL refusal note above.' },
        extras: { type: ['object', 'string'], description: 'action=launch only: intent extras. string -> --es, boolean -> --ez, int32 integer -> --ei, larger integer -> --el; anything else is refused by key name. A JSON-stringified object is accepted too.' },
        serial: SERIAL,
        filter: { type: 'string', enum: ['user', 'system', 'disabled', 'all'], description: 'action=list only, default user' },
        q: { type: 'string', description: 'action=list only: case-insensitive substring filter' },
        scope: { type: 'string', enum: ['user', 'all', 'list'], description: 'action=backup only: what to back up when packages is omitted (default user)' },
        mode: { type: 'string', enum: ['disable', 'uninstall'], description: 'How to remove: disable (default) is undone by action=enable or restore; uninstall needs allow_uninstall.' },
        dry_run: { type: 'boolean', description: 'Default true for state-changing actions. Set false to actually apply.' },
        batch_size: { type: 'number', description: 'Packages per batch between canary checks, default 5, max 25' },
        canary: { type: 'boolean', description: 'Check the account count and the launcher between batches, default true. Turning it off removes the only automatic check for a latent breakage.' },
        backup: { type: 'boolean', description: 'Pull APKs before removing. Default true for uninstall, false for disable.' },
        force: { type: 'boolean', description: 'Proceed even if the APK backup failed. Off by default. It does not affect the network guard; see force_network.' },
        force_network: { type: 'boolean', description: 'Override the network guard for disable, uninstall, stop and clear: act on a package that is currently serving an off-device client. It does NOT override the protected set. Off by default.' },
        store: { type: 'string', description: 'Where snapshots and APK backups live: by default the snapshot store (setting store). Another path must be inside file_roots.' }
      },
      required: ['action']
    }
  },
];

// Tools that may have done part of their work before a connection loss: after
// a reconnect they are not repeated automatically, unless the call itself
// changes nothing (repeatable()).
const NOT_REPEATED = new Set(TOOLS.filter(t => t.annotations.destructiveHint).map(t => t.name));

/**
 * Whether this call may be repeated after a reconnect: a tool that is not
 * destructive; adb_app with a reading action, or with the dry_run in force
 * (passed, else the action's default); adb_install without apk_path (the
 * list) or with the dry_run in force.
 */
function repeatable(name, args = {}) {
  if (!NOT_REPEATED.has(name)) return true;
  const a = args || {};
  if (name === 'adb_app') {
    const action = String(a.action || '').toLowerCase();
    return apps.READ_ONLY_ACTIONS.has(action) || apps.dryRunOf(action, a) === true;
  }
  if (name === 'adb_install') {
    const paths = coerceArray(a.apk_path).filter(p => typeof p === 'string' && p.trim() !== '');
    return !paths.length || files.installDryRun(a.dry_run).dryRun;
  }
  return false;
}

/**
 * A tool call; when it failed because a remembered network device dropped,
 * one reconnect, then the call once more (or, for a tool that may have done
 * part of its work, a note to call again).
 */
async function callTool(name, args) {
  try {
    return await dispatch(name, args);
  } catch (e) {
    const r = await session.reconnectRemembered(args && args.serial, e.message);
    if (!r) throw e;
    if (!r.ok)
      throw new Error(`${e.message}\nA reconnect to the remembered address ${r.addr} failed: the device may be off or have a new address - adb_devices discover=true finds it again.`);
    if (!repeatable(name, args))
      throw new Error(`${e.message}\nReconnected to ${r.addr}. The call was not repeated, because it may have been partly done: check the state and call it again.`);
    return await dispatch(name, args);
  }
}

async function dispatch(name, args) {
  switch (name) {
    case 'adb_devices':    return session.devices(args);
    case 'adb_connect':    return session.connect(args);
    case 'adb_pair':       return session.pair(args);
    case 'adb_disconnect': return session.disconnect(args);
    case 'adb_shell':      return session.shell(args);
    case 'adb_logcat':     return session.logcat(args);

    case 'adb_screenshot': return ui.screenshot(args);
    case 'adb_ui_dump':    return ui.uiDump(args);
    case 'adb_tap':        return ui.tap(args);
    case 'adb_swipe':      return ui.swipe(args);
    case 'adb_text':       return ui.typeText(args);
    case 'adb_key':        return ui.key(args);
    case 'adb_find_and_tap': return ui.findAndTap(args);

    case 'adb_install':    return files.install(args);
    case 'adb_uninstall':  return files.uninstall(args);
    case 'adb_push':       return files.push(args);
    case 'adb_pull':       return files.pull(args);

    case 'adb_app':        return apps.adbApp(args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, callTool, repeatable };
