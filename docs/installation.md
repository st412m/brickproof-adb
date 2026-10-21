# Installation

Pick the section for where your AI runs. The server needs adb (Android SDK Platform-Tools) on the same machine — found by itself or downloaded, see [adb](#adb) — and, except for the Claude Desktop extension and Home Assistant, Node.js 22.17 or newer.

## Home Assistant

The [ha-adb-mcp](https://github.com/st412m/ha-adb-mcp) app runs this server inside Home Assistant, with its settings in the app options. A chat in the browser reaches it through Home Assistant's external address.

## Claude Desktop

### The extension (.mcpb)

Download the `.mcpb` file from the [latest release](https://github.com/st412m/brickproof-adb/releases/latest) and install it in one of three ways:

- drag the file into the Claude Desktop window;
- double-click it (on many computers an archiver has taken over the `.mcpb` type and opens it instead: then use one of the other two ways);
- in Claude Desktop, Settings → Extensions → Advanced settings → Install Extension…, and choose the file.

Claude Desktop shows a form: the folders for files (left empty, it is your Downloads folder, found by the server), the two safety switches (off), optional TV addresses and an optional adb program. Claude Desktop runs the server with its own Node.js; nothing else to install. To change a setting later: Settings → Extensions → brickproof-adb.

### A JSON configuration

Settings → Developer → Edit Config opens `claude_desktop_config.json`. On macOS:

```json
{
  "mcpServers": {
    "brickproof-adb": {
      "command": "npx",
      "args": ["-y", "brickproof-adb"]
    }
  }
}
```

On Windows `npx` is a script, not a program, and is started through `cmd`:

```json
{
  "mcpServers": {
    "brickproof-adb": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "brickproof-adb"]
    }
  }
}
```

Folders given after the command name are the folders for files, for example `"args": ["-y", "brickproof-adb", "/Users/me/android"]`; without any, it is your Downloads folder. Restart Claude Desktop after editing.

## Claude Code

```
claude mcp add brickproof-adb -- npx -y brickproof-adb
```

On native Windows put `cmd /c` before `npx`.

## Other MCP clients on your computer

The server command is `npx -y brickproof-adb` (MCP over stdio). Folders for files can follow it as arguments. After `npm install -g brickproof-adb` the command is `brickproof-adb`.

## A browser chat without Home Assistant

A chat in the browser (claude.ai and others) reaches only servers on the internet. That needs a computer at home that stays on and runs

```
npm install -g brickproof-adb
brickproof-adb serve
```

and a public HTTPS address in front of it (a reverse proxy with a certificate, or a tunnel). `serve` listens on `127.0.0.1:3200` and prints the connector path once; see [security.md](security.md) before you open it to the internet.

## Docker

```
docker run -d --name brickproof-adb -p 127.0.0.1:3200:3200 -v brickproof-data:/data ghcr.io/st412m/brickproof-adb:1.0.0
docker logs brickproof-adb
```

The volume `/data` holds the token, the snapshot store, the remembered devices and the adb key the devices trust; keep it across updates. The image brings its own adb. The server runs as uid 1000. `compose.example.yaml` is a complete setup with a folder for file transfer.

Settings are `BRICKPROOF_*` environment variables of the container, and a refusal names the one to set. A folder for `adb_push`, `adb_pull` and `adb_install` is a host folder mounted into the container with its path inside the container in `BRICKPROOF_FILE_ROOTS`, as in `compose.example.yaml`.

Network devices work at once. The search finds TV boxes on port 5555 only in the subnets given in `scan_subnets`: a container on the default bridge network sees neither the home network's interfaces nor mDNS.

USB devices work only on a Linux host, with the USB bus passed in (`--device /dev/bus/usb`). Docker Desktop on Windows and macOS does not pass USB devices into containers; run brickproof-adb natively there. Two adb servers cannot share one USB device, so stop the host's own adb server while the container uses USB.

## adb

The server looks for adb, without running it, in this order: `adb_path` when it is set; the copy `brickproof-adb get-adb` downloaded; `PATH`; the Android SDK (`ANDROID_HOME`, `ANDROID_SDK_ROOT`, the Android Studio default folder); WinGet; Homebrew. The first one found is used. An `adb_path` that is set is used even when it is missing, so a typo is an error rather than a different adb.

```
brickproof-adb get-adb
```

downloads Google's Platform-Tools for this system from `dl.google.com` into the state directory, after showing the link to Google's terms and asking (`--accept-license` skips the question). It replaces an earlier download as a whole, and leaves nothing behind when it fails. Google publishes Linux builds for x86_64 only; on other Linux machines install your distribution's adb package.

Use one adb for everything on the machine: two different builds (Android Studio, scrcpy and vendor tools bring their own) restart each other's adb server, and network devices drop. `brickproof-adb check` lists every adb it finds with its version.

## Preparing a device

- **TV boxes**: Developer options → Network debugging (also called ADB debugging), or USB debugging for a cable. Network debugging listens on port 5555.
- **Phones and tablets over USB**: Developer options → USB debugging, plug in, accept "Allow USB debugging?" on the screen with "Always allow" checked.
- **Phones and tablets over Wi-Fi, Android 11 and newer**: Developer options → Wireless debugging. Pair once: "Pair device with pairing code" shows an address and a 6-digit code for `adb_pair`. Afterwards adb reconnects the phone by itself whenever both are on the same network.

Developer options appear after tapping the build number seven times in the About screen of the settings. On the first connection from a new computer, confirm the prompt to allow debugging on the device screen, with "Always allow" checked.

## Finding devices

`adb_devices discover=true` looks for devices to connect and connects none of them:

- devices that announce Wireless debugging over mDNS (phones, tablets, watches), through adb itself;
- port 5555 (network debugging, mostly TV boxes) in the home network: the private subnets of this computer's network adapters, at most 254 addresses each, skipping adapters of virtual machines, containers and VPNs; or the subnets in `scan_subnets`. Only a TCP connection is opened and closed; nothing is sent. The search stops after about 10 seconds.

It answers with each device and the next step: `adb_pair` with the code on the screen, or `adb_connect`. A guest network, Wi-Fi client isolation or a separate VLAN hides devices from both sources.

## Checking the setup

```
brickproof-adb check
```

prints the settings file in use, the state directory, the snapshot store, each folder for files, the remembered devices, every adb found with its version, a test run of the screenshot pipeline on generated frames with the time each took, and the connected devices. `check --offline` skips the devices. Every problem is listed at the end, and the exit code is 1 when there is one.
