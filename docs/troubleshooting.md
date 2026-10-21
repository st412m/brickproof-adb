# Troubleshooting

Symptoms, and what resolves each one. `brickproof-adb check` is the first step for anything about the setup.

## adb is not found

```
adb could not start: ENOENT - adb was not found
```

followed by what to do. `brickproof-adb get-adb` downloads Google's Platform-Tools; or install them yourself; or set `adb_path` to an adb you have. `brickproof-adb check` shows every place it looked. On Windows `adb_path` must be `adb.exe` itself: a `.cmd` or `.bat` wrapper cannot be started without a shell and fails with `EINVAL`.

## Another adb restarted the server

```
⚠ the adb server was started by another adb on this machine and this client restarted it, so network devices may need adb_connect again.
```

The protocol versions are added in parentheses only when they differ; two builds of one protocol (adb prints `server version (41) doesn't match this client (41)`) clash all the same.

An adb client that differs from the one that started the running adb server kills that server and starts its own; network devices are disconnected each time. Android Studio, scrcpy and phone vendors' tools each bring their own adb. `brickproof-adb check` lists every adb it finds with its version and warns when they differ: set `adb_path` to the same adb the other programs use, or point them at this one, then `adb_connect` the network devices again.

## `device offline` / `device '…' not found`

The TCP session died, usually because the device slept or rebooted. For a remembered address the server reconnects once by itself; otherwise `adb_disconnect` that host, then `adb_connect` again. On Android 11+ wireless debugging the connect port changes after every reboot: use the port on the Wireless debugging screen. Pairing again is not needed.

When the reconnect fails, the device is off or has a new address (a router gives out addresses anew): `adb_devices discover=true` finds it again.

## The search finds nothing

- Debugging is off on the device: Network debugging (TV boxes) or Wireless debugging (phones) in Developer options.
- The device is on another network: a guest Wi-Fi, a separate VLAN, or a router that isolates Wi-Fi clients from each other.
- The server runs in Docker or Home Assistant: mDNS does not reach it, and port 5555 is checked only in `scan_subnets`.
- The TV is in deep sleep and does not answer on the network.

An address read off the device works without the search: `adb_connect host=192.0.2.50`, or `adb_pair` with the address and code of the pairing screen.

## `device unauthorized`

Confirm the prompt to allow debugging on the device screen, with "Always allow" checked. The prompt appears for each new machine (each adb key); if the screen is off, wake the device first so it shows.

## `INSTALL_FAILED_VERIFICATION_FAILURE`

The device's package verifier rejects ADB installs. It is switched off with a shell command, which needs `allow_shell`:

```
adb_shell command="settings put global verifier_verify_adb_installs 0"
```

## A host path is refused

```
host_path /home/me/Downloads/x.apk is outside the allowed directories (file_roots: /home/me/android)
```

`adb_push`, `adb_pull` and `adb_install` use only the folders in `file_roots` (by default the Downloads folder). Move the file there, or add its folder: `brickproof-adb set file_roots <folder>...` and a restart, or the form of the extension or the Home Assistant app. With `file_roots` empty these tools refuse and say what to set. A symlink or junction that leads out of a root is refused too.

## A damaged snapshot

```
The snapshot file …/state.json is damaged (…); it was moved to …/state.json.broken-2026-10-19T10-00-00Z.
```

The call that found it did nothing on the device. The damaged file is kept as it was and never overwritten or removed; `adb_app action=state` lists it. Its rollback entries are not used automatically: read the file to undo those changes by hand (`adb_app action=enable` for disabled packages). The next call starts an empty snapshot.

## A black screenshot

Read the warning under the image. `screen: Asleep` — wake the device first (`adb_key key=WAKEUP`). `FLAG_SECURE` — the system hides that content from every screenshot.

## `adb_text`: the input method is `com.google.android.tv.remote.service/…` instead of ADBKeyBoard

A Google TV remote is connected (the Google TV app on a phone, or the Android TV Remote integration in Home Assistant) and its input bridge holds the keyboard, so non-Latin text cannot be typed. Latin text works; for other text, disconnect the remote client first.

## `coords="screenshot"` is refused

The screenshot is older than 120 s, or `serial` was passed to one call and not the other. Take a new screenshot and pass `serial` the same way to both.

## `adb_find_and_tap` does not find an element that is on screen

Read `Visible now:` in the error: it is built from the same elements the search used. An element drawn as an image with no label is invisible to `uiautomator`; use `adb_screenshot` and `adb_tap coords="screenshot"`. During an animation a dump can miss it; call again.

## `uiautomator: ERROR: null root node returned by UiTestAutomationBridge`

The accessibility bridge lost the window, usually as the screen changes or with the screen off. Call again. With `verify="ui"` this never fails the action itself.

## A dry run looks right, the real call is refused

Both guards say what stopped the call: the protected set names the packages and their sources, the network guard the port and the client. `adb_app action=protected` shows the whole set and the notes of sources that could not be read.

## `restore` does not find a snapshot

Snapshots live on the machine that made the change, under its `store`; `adb_app action=state` shows which directory and key this call uses. A device without a usable serial number keeps one snapshot per connection; the result of every `adb_app` change says so. Snapshots from ha-adb-mcp 1.x are read from their old directory; those taken there without `serial` (directory `default`) are not, because they may belong to any device.

## A call fails with `timed out after N s`

The adb call hit its time limit; the limits are in [tools.md](tools.md#time-limits). For `adb_shell` raise `timeout_sec` (at most 120 s), or start long work in the background on the device and poll.

## The assistant still sees old tools

Clients cache the tool list per chat. Start a new chat after an update.
