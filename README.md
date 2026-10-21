<img src="https://raw.githubusercontent.com/st412m/brickproof-adb/main/icon.png" alt="" width="96" height="96">

# brickproof-adb

Let an AI assistant look after your own Android devices — TV boxes first, phones and tablets too — over ADB, without bricking them.

brickproof-adb is an MCP server. It gives Claude (or any MCP client) the screen, the input and the package manager of your devices, and puts guard rails where a careless call would hurt: every package change is a dry run first, the packages a device cannot live without are read off the device and refused, a package that serves something on your network right now is not touched, and everything applied goes into a snapshot that one call rolls back.

It runs on Windows, macOS and Linux, in Docker, and as a Home Assistant app; devices connect over USB or the network.

## What it looks like

**Finding the TV.**

> **You:** Find my TV.
>
> **Claude** calls `adb_devices discover=true`. Nothing is connected yet; the search looks for devices that announce debugging and for port 5555 on the home network:
>
> ```
> Found:
>   192.0.2.50:5555 (port 5555 open, network debugging) - adb_connect host=192.0.2.50:5555; if this computer is new to the device, it asks on its screen to allow debugging
> ```
>
> **Claude:** I found one device at 192.0.2.50. Shall I connect? The TV will ask whether to allow debugging.
>
> **You:** Yes.
>
> **Claude** calls `adb_connect host=192.0.2.50:5555`; you confirm the prompt to allow debugging on the TV screen, with "Always allow" checked. The address is remembered and connected again whenever the server starts.

**Installing what you just downloaded.**

> **You:** Install on the TV the app I just downloaded.
>
> **Claude** calls `adb_install` without a path and gets the newest installable files of your Downloads folder, then `adb_install` with the first one: a report of what would be installed on which device. After your yes, the same call with `dry_run=false` installs it.

**Cleaning up a TV box.**

> **You:** The box is slow. Turn off the preinstalled junk, but nothing it needs.
>
> **Claude** calls `adb_app action=list filter=system`, picks five packages and calls `adb_app action=disable` with them. That is a dry run by default: the plan comes back with the rollback path of each package — and one package refused, because the box uses it as its launcher:
>
> ```
> REFUSED: the list contains protected packages - com.example.launcher.
>   com.example.launcher — launcher, roles (HOME)
> The full set with every source: adb_app action=protected
> Nothing was applied. Remove them from the list by hand; the tool has no override.
> ```
>
> **Claude** drops it, runs the plan for the other four, then repeats it with `dry_run=false`. The account count and the launcher are checked after the batch, and the four packages are recorded in the snapshot.
>
> **You:** The voice remote stopped working.
>
> **Claude** calls `adb_app action=restore`, reads the plan and repeats it with `dry_run=false`: the four packages are enabled again in one call.

**Seeing the screen and tapping.**

> **You:** Open the network settings on the phone.
>
> **Claude** calls `adb_screenshot`, gets the picture and the line under it:
>
> ```
> screen 1080x2340 -> image 473x1024 · scale 2.283/2.285 · pass coords="screenshot" to adb_tap/adb_swipe
> ```
>
> and taps the "Network & internet" row it sees, with `adb_tap coords="screenshot"`, in the image's own coordinates. On a TV box without a touchscreen it uses `adb_find_and_tap text="Network"`, which walks the focus there with the remote's keys.

## Install it where your AI is

Details, other setups and checks: [docs/installation.md](docs/installation.md). An AI app without MCP support cannot use this server.

- **Home Assistant** — install the [ha-adb-mcp](https://github.com/st412m/ha-adb-mcp) app. It is reachable from a browser chat through your Home Assistant's external address.
- **Claude Desktop** (Windows, macOS) — download the `.mcpb` file from the [latest release](https://github.com/st412m/brickproof-adb/releases/latest) and drag it into the Claude Desktop window, or choose it in Settings → Extensions → Advanced settings → Install Extension… (a double click works too, unless an archiver opens the file instead); Claude Desktop shows a short form and installs it. No Node.js needed. A JSON configuration instead: [docs/installation.md](docs/installation.md#claude-desktop).
- **Claude Code**:

  ```
  claude mcp add brickproof-adb -- npx -y brickproof-adb
  ```

- **Other MCP clients on your computer** — the server command is `npx -y brickproof-adb`.
- **A chat in the browser without Home Assistant** — needs a computer at home that stays on, running `brickproof-adb serve`, behind a public HTTPS address: [docs/installation.md](docs/installation.md#a-browser-chat-without-home-assistant).
- **Docker** — `ghcr.io/st412m/brickproof-adb`: [docs/installation.md](docs/installation.md#docker).

## First run

1. **Turn on debugging on the device.** Android TV, Google TV, Fire TV and phones hide it under Developer options, which appear after tapping the build number seven times in the About screen of the settings. There: USB debugging for a cable; Network debugging or ADB debugging on many TV boxes; Wireless debugging on a phone with Android 11 or newer.
2. **Tell the assistant "find my TV"** (or phone). It searches the network and suggests what to connect; a phone on a cable shows up by itself.
3. **Confirm the prompt to allow debugging on the device screen**, with "Always allow" checked. A phone over Wi-Fi asks for the pairing code shown on its screen instead.

Defaults that need no setting: files go to and from your Downloads folder, connected devices are remembered, and adb is found by itself (or `brickproof-adb get-adb` downloads it).

## Requirements

- Node.js 22.17 or newer — for every setup except the Claude Desktop extension, Home Assistant and Docker.
- adb (Android SDK Platform-Tools): found by itself where Android Studio, WinGet, Homebrew or your system put it, or downloaded with `brickproof-adb get-adb`. Docker and Home Assistant bring their own.
- A device with debugging on, over USB or the network.

## Connecting

Over stdio (Claude Desktop, Claude Code) there is nothing to connect: the client starts the server. Over HTTP (`brickproof-adb serve`) the token goes either in the path or in a header:

```
https://<your-host>/private_<token>/mcp
Authorization: Bearer <token>
```

The token is generated on the first start; `brickproof-adb token` shows it again, `brickproof-adb token --new` replaces it. See [docs/security.md](docs/security.md).

## Tools

18 tools. Semantics, refusals and time limits: [docs/tools.md](docs/tools.md); screen geometry and input: [docs/screen-and-input.md](docs/screen-and-input.md).

- `adb_devices` — connected and remembered devices; `discover=true` searches the network
- `adb_connect` — connect a network device, `ip` or `ip:port`; remembered for the next start
- `adb_disconnect` — drop one network device (and forget it), or all
- `adb_pair` — pair an Android 11+ device over Wireless debugging
- `adb_shell` — any shell command; off unless `allow_shell` is set
- `adb_logcat` — recent log lines, filtered on the device
- `adb_screenshot` — the screen as JPEG, with the scale to tap by
- `adb_ui_dump` — on-screen elements with tap coordinates
- `adb_tap` — tap a point, in screen or screenshot coordinates
- `adb_swipe` — swipe or long-press
- `adb_key` — a key press (HOME, BACK, DPAD_CENTER…)
- `adb_text` — type into the focused field, Unicode through ADBKeyBoard
- `adb_find_and_tap` — find an element by its label and activate it
- `adb_install` — install an APK, a split set or an `.apks`/`.xapk`/`.apkm` bundle; dry run by default; without a path, lists what can be installed
- `adb_uninstall` — remove an app by package name
- `adb_app` — package operations with guard rails, snapshot and rollback
- `adb_push` — copy a file to the device
- `adb_pull` — copy a file from the device

## Safety

What protects your devices, and what does not: [docs/safety.md](docs/safety.md). In short: dry runs by default, a protected set read off the device, a network guard on live services, an account canary between batches, a snapshot with one-call rollback, and `adb_shell` and uninstalling off until you turn them on. No tool changes these switches; you do, with `brickproof-adb set` or in the settings of your app.

## Limitations

- ADB is not a sandbox. With `allow_shell` on, `adb_shell` can do anything the device's shell user can, past every guard.
- The search finds devices on the same network only: a guest network, Wi-Fi client isolation or separate VLANs hide them. In Docker and Home Assistant only TV boxes on port 5555 are found; phones connect by the address on their screen.
- The tool list is cached per chat; after an update start a new chat.
- A screenshot of a sleeping device is a dark frame, and the answer says `screen: Asleep`; `adb_key key=WAKEUP` wakes it, and HDMI-CEC may then switch on the television.
- Content protected with FLAG_SECURE (streaming players, banking apps) shows as a black frame.
- Snapshots live on the machine that made them: a rollback has to run where the change was made.
- USB devices in Docker work only on a Linux host.

## License

[MIT](LICENSE)
