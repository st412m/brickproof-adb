# Tools

What every tool does, the arguments that change its behaviour, its refusals and its time limit. The guard rails of `adb_app` are in [safety.md](safety.md); screen geometry, `coords` and `verify` in [screen-and-input.md](screen-and-input.md).

## Marks

Every tool carries marks that tell the client how careful to be before running it. `adb_devices`, `adb_screenshot`, `adb_ui_dump` and `adb_logcat` are marked read-only, so a client may run them without asking. `adb_shell`, `adb_install`, `adb_uninstall`, `adb_push`, `adb_pull` and `adb_app` are marked destructive: they can run anything on the device, replace or remove apps, or overwrite files on either side, and a client that honours the marks asks first. The connection tools and the input tools change state but destroy nothing by themselves, so they carry neither mark. What a client does with the marks is its own choice; the guard rails apply either way.

## Time limits

Every adb call runs under a hard time limit and is killed when it expires, so a device that sleeps, reboots or drops off the network fails the call instead of hanging it. The error comes back as a tool result with `isError: true`.

| Tool | Limit |
|---|---|
| `adb_devices` | 30 s |
| `adb_connect`, `adb_disconnect` | 10 s |
| `adb_pair`, `adb_logcat` | 20 s |
| `adb_shell` | 30 s, at most 120 s with `timeout_sec` |
| `adb_screenshot`, `adb_ui_dump`, `adb_tap`, `adb_swipe`, `adb_key`, `adb_text` | 30 s per adb call |
| `adb_find_and_tap` | 30 s per adb call, about 25 s for the whole DPAD walk |
| `adb_uninstall` | 60 s |
| `adb_push`, `adb_pull` | 120 s |
| `adb_install` | 180 s, 300 s for a bundle |
| `adb_app` | per call; APK pulls 180 s |

A connector behind a reverse proxy may give up sooner (often about 60 s) than a long install or transfer takes.

A call that ran out of time names the adb subcommand, never its arguments:

```
adb shell timed out after 30 s and was killed (SIGTERM)
```

Typical adb errors get the action that fixes them, for example `device offline`:

```
error: device offline. The TCP session died (device slept or rebooted) - run adb_disconnect for this host, then adb_connect again.
```

## Session

### `adb_devices`

Lists connected devices with serial, state and description (`adb devices -l`), and remembered addresses that are not connected now. Every other tool takes `serial` from here; it may be left out when exactly one device is connected. When no device is connected, the answer ends with a pointer to `discover=true`; so does a "device not found" error of any tool. A phone on a USB cable and a phone paired over Wireless debugging need no search: adb shows them by itself. One device listed under several serials (USB, `ip:port`, the mDNS name of a paired phone) is marked `same device as <first serial>` by its model and serial number.

`discover=true` searches the network instead (about 10 s) and connects nothing; call it whenever needed, as often as needed — the server never scans in the background: devices that announce Wireless debugging over mDNS, and port 5555 in the home network (see [installation.md](installation.md#finding-devices)). Each device comes with the next step:

```
Found:
  adb-R5CX00000AB-AbCdEf 192.0.2.21:41234 (mDNS _adb-tls-pairing._tcp) - the pairing screen is open: adb_pair host=192.0.2.21:41234 code=<the 6-digit code on its screen>
  192.0.2.50:5555 (port 5555 open, network debugging) - adb_connect host=192.0.2.50:5555; if this computer is new to the device, it asks on its screen to allow debugging
```

When the search had to start the adb server, the answer says how long that took, apart from the search itself. An address found by both searches is one line with both sources (`mDNS _adb._tcp, port 5555 open`). When nothing is found, the answer says what to check (debugging on, the same network, no guest network or client isolation) and how to connect by an address read off the device.

### `adb_connect`

Connects a network device: `host` is `ip` (port 5555 implied) or `ip:port`. A refused connection is an error, not a success text. While the device has not allowed this computer yet (adb still lists it as `unauthorized` after about 5 s; a trusted device can show it for a moment), the call is an error too: confirm the prompt on the device's screen, waking the device first if its screen is off, and call `adb_connect` again; nothing is remembered. An address adb lists as `device` is remembered, with the device's identity (model and serial number), and connected again when the server starts. When the same device answers at a new address (the router handed out another one), the new address replaces the old; the answer says so. The random ports of Wireless debugging are not remembered: adb reconnects paired phones by itself.

### `adb_disconnect`

Drops one network device and forgets it, or all of them when `host` is left out (which forgets nothing). `adb_disconnect` and then `adb_connect` recover a device listed as `offline`; for a remembered device the server does that once by itself when a call finds it gone. The call is then repeated when it changes nothing (a reading `adb_app` action, a dry run, the `adb_install` list); any other call is not, and says so.

### `adb_pair`

Pairs an Android 11+ device over Wireless debugging, once per device and machine. It needs the `ip:port` and the 6-digit code of the "Pair device with pairing code" dialog, with the dialog still open. Then `adb_connect` to the `ip:port` of the main Wireless debugging screen.

### `adb_shell`

Runs a shell command on the device and returns stdout. Off while `allow_shell` is off. `timeout_sec` raises the limit up to 120 s; for longer work, start it in the background on the device and poll.

### `adb_logcat`

Recent log lines, without waiting for new ones:

- no `filter` — the last `lines` lines (`logcat -d -t N`);
- a filterspec, containing `:` or `*`, for example `ActivityManager:I *:S` — applied to the whole buffer on the device; `*:S` is added when missing, so other tags stay silent;
- anything else — a case-insensitive substring searched across whole lines, on the device.

`lines` defaults to 200, at most 2000. Filtering happens on the device, so a large buffer never crosses the wire.

## Screen and input

### `adb_screenshot`

The screen as a JPEG (`quality` 30–95, default 70; `max_px` 320–1920, default 1024) and a line with the scale to tap by. A near-uniformly dark frame comes back with a warning, not a refusal. See [screen-and-input.md](screen-and-input.md#screenshots).

### `adb_ui_dump`

The on-screen elements that can be pressed or carry a label, with their tap point `@(x,y)`, from `uiautomator`. Password fields are marked `[PASSWORD]` even without text. See [screen-and-input.md](screen-and-input.md#ui-dump).

### `adb_tap`

Taps a point. `coords="screen"` (default) takes coordinates from `adb_ui_dump`; `coords="screenshot"` takes them off the last screenshot. `verify` reports whether the tap changed anything.

### `adb_swipe`

Swipes from one point to another over `duration_ms` (default 300); the same point at both ends for 800 ms or more is a long press. `coords` and `verify` as for `adb_tap`.

### `adb_key`

Sends a key: a name (`HOME`, `BACK`, `ENTER`, `DPAD_CENTER`, `WAKEUP`…, with or without `KEYCODE_`) or a number. `verify` as for `adb_tap`.

### `adb_text`

Types into the focused field. ASCII goes through `input text` exactly as given, quotes, backslashes and shell characters included. Anything else goes through the ADBKeyBoard input method, see [screen-and-input.md](screen-and-input.md#unicode-input). The result reports only the number of characters. The description tells the assistant never to retry a wrong password or PIN and to ask instead.

`%s` in the text is typed as a space: that is how `input text` works.

Non-Latin text is sent only once the device actually has ADBKeyBoard as its input method; otherwise the call is an error naming the input method in charge, and nothing is typed. On Google TV a connected remote (the Google TV app on a phone, the Android TV Remote integration in Home Assistant) holds the keyboard: while it is connected only Latin text can be typed.

When no on-screen keyboard is shown, no system text field seems to have focus: the text is sent anyway (some TV boxes take it into a keyboard of their own), and the answer says it may have gone nowhere instead of "Typed"; on a TV box it says to press OK on the field (`adb_key DPAD_CENTER`) to open the keyboard first.

### `adb_find_and_tap`

Finds an element by `text`, `resource_id` or `desc` and activates it: a tap on a device with a touchscreen, a DPAD walk on a TV box without one. Nothing is pressed unless the target is reached. Each key goes towards the target along the axis on which the two do not overlap; from a focus that contains the target (a full-screen banner) the directions count from the centre of the screen. See [screen-and-input.md](screen-and-input.md#finding-and-activating-an-element).

## Apps

### `adb_install`

Installs one `.apk`, a list of split APKs, or one `.apks`/`.xapk`/`.apkm` bundle from `file_roots`. **By default it only reports**: the files, the device and the command; it installs with `dry_run=false` only. `"0"`, `"no"` or anything else but `false` gets the report.

The server never downloads an APK: download it yourself into a folder of `file_roots` (by default your Downloads folder; in Home Assistant `/media` or `/share`). Called without `apk_path`, `adb_install` installs nothing and does not touch the device: it lists the installable files in `file_roots` — each folder and one level of subfolders, hidden ones skipped — newest first, at most 50, with the full path to pass as `apk_path`, the size and the date. `dir` lists one folder inside `file_roots` instead, for files deeper down.

```
Installable files in /home/me/Downloads (the folder itself and one folder below), newest first:
  /home/me/Downloads/example-tv-app.apk  24.1 MB  2026-10-20 07:30
Nothing was installed. Install one with adb_install apk_path=<path from this list>; it reports first unless dry_run=false.
Only the top level and one level of subfolders are listed; for a deeper folder pass dir.
```

```
APK: 1 file
  /home/me/android/demo.apk (12345 bytes)
Device: SDK 30, ABI arm64-v8a,armeabi-v7a, 320 dpi, locale en-US
Would run: install -r -t -g demo.apk on the only connected device

dry_run was not passed - adb_install only reports unless dry_run=false.
dry_run - nothing installed. Repeat with dry_run=false.
```

A bundle is unpacked on the host, and the splits are chosen from what the device reports (`ro.product.cpu.abilist`, `wm density`, `persist.sys.locale`). Three naming conventions are recognised: bundletool, APKMirror-style and splits pulled from a device.

```
Bundle: Example_1.2.apks (12 apk inside)
Device: SDK 28, ABI armeabi-v7a,armeabi, 320 dpi, locale en-US
Chose 3: com.example.app.apk, config.armeabi_v7a.apk, config.xhdpi.apk
  · ABI: armeabi-v7a (device: armeabi-v7a, armeabi)
  · density: xhdpi (320 dpi, exact match)
  · locales: no matching split (device language: en; bundle has: ru) - strings come from the base APK
```

A missing ABI split is a refusal: the app would not start. A missing density split is not: the nearest one is used. Do not guess the ABI from the chip; TV boxes often run a 32-bit system on 64-bit hardware. `abi`, `density` and `locales` override what the device reports, for bundles only.

To reinstall an app exactly, `pm path <pkg>` on a device that has it lists its splits: `adb_pull` each and pass them as an array.

### `adb_uninstall`

Removes an app by package name, at once and without a backup; `keep_data=true` keeps its data (`-k`). It counts as removed when the package list read afterwards no longer has it; still listed is an error with the device's output, whatever adb printed. For system packages, several packages, a backup or a rollback, use `adb_app`.

### `adb_app`

Package operations with guard rails: `list`, `info`, `protected`, `state` read; `launch`, `stop` and `clear` act at once (`clear` defaults to a dry run because it wipes data); `disable`, `uninstall`, `enable` and `restore` change state and default to a dry run; `backup` writes into the store and runs at once. The guard rails, snapshots and rollback are described in [safety.md](safety.md).

```
adb_app action=list filter=user q=example
adb_app action=protected
adb_app action=disable packages=["com.example.bloat"]
adb_app action=disable packages=["com.example.bloat"] dry_run=false
adb_app action=restore dry_run=false
```

`action=backup` pulls every APK of a package plus a `manifest.json` with version, ABI and split list, also before a factory reset.

`action=launch` starts a package's main activity, or an intent when `uri` or `intent_action` is given:

```
adb_app action=launch packages=["com.example.app"]
adb_app action=launch uri="https://example.com/some/deep/link"
adb_app action=launch intent_action=android.settings.APPLICATION_DETAILS_SETTINGS uri="package:com.example.app"
```

`intent_action` defaults to `android.intent.action.VIEW` when `uri` is set. `extras` maps a string to `--es`, a boolean to `--ez`, a 32-bit integer to `--ei`, a larger one to `--el`, and refuses anything else by key. One package in `packages` narrows the handler (`-p`); more than one is refused. A chooser dialog opened by the launch is closed with one BACK and reported; no second key is sent.

## Files

### `adb_push`

Copies a file from `file_roots` to the device; a file of the same name there is overwritten.

### `adb_pull`

Copies a file from the device into `file_roots`; a file of the same name is overwritten and missing directories are created.

A host path outside `file_roots` is refused before anything is read, written or created; see [security.md](security.md#file-roots).
