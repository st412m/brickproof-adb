# Changelog

## 1.0.0 — 2026-10-21

Continues ha-adb-mcp 1.4.0: the same server and the same 18 tools, now a standalone npm package that runs on Windows, macOS and Linux, in Docker and as the Home Assistant app, with devices over USB and over the network.

### Added
- **Runs anywhere Node runs.** `brickproof-adb` with no command is an MCP server on stdio for Claude Desktop, Claude Code and other local clients; `brickproof-adb serve` is MCP over Streamable HTTP. Only `adb` is needed next to it: the screenshot pipeline is plain JavaScript, no ImageMagick, no native modules.
- **Claude Desktop extension.** `brickproof-adb-1.0.0.mcpb` in the release installs with a short form (folders, safety switches, optional TV addresses) and needs no Node.js of its own.
- **Finding devices.** `adb_devices discover=true` finds phones with Wireless debugging (mDNS, through adb) and TV boxes with network debugging (port 5555 in the home network), and says the next step for each; it connects nothing.
- **Remembered devices.** A device connected with `adb_connect` is connected again at every start, and a new address of the same device replaces the old one; `adb_disconnect` with its address forgets it. When a remembered device drops during a call, the server reconnects once.
- **What can be installed.** `adb_install` without a path lists the APKs and bundles in the file folders, newest first, and installs nothing: "install what I just downloaded" works without knowing the file name.
- **adb found by itself** where Android Studio, WinGet, Homebrew or the system put it; **`brickproof-adb get-adb`** downloads Google's Platform-Tools after asking.
- **No settings file needed.** Files go to and from the Downloads folder by default. **`brickproof-adb set <key> <value>`** writes a setting; a refusal of a switched-off feature says where to turn it on.
- **`brickproof-adb check`** prints the settings, every adb on the machine with its version (and warns when they differ), a test run of the image pipeline with its timings, each file root, the snapshot store and the connected devices; `--offline` skips the devices. Exit code 1 on any problem.
- **Token for HTTP.** Generated on the first start and shown once; `brickproof-adb token` shows it again, `--new` replaces it. Accepted as the secret path `/private_<token>/mcp` or as `Authorization: Bearer <token>` on `/mcp`. A wrong path gets an empty 404, a wrong Bearer token 401. On a localhost bind a foreign `Host` or `Origin` gets 403; `allowed_hosts` names a tunnel's public host.
- **Protocol version header.** An unsupported `MCP-Protocol-Version` is refused with 400 and JSON-RPC error -32600; no header, or `initialize`, passes.
- **File roots.** `adb_push`, `adb_pull` and `adb_install` use only the host directories in `file_roots`. A path outside them, a sibling directory whose name starts like a root, or a symlink or junction leading out is refused; Windows and macOS compare without regard to letter case.
- **Another adb on the machine.** When a different adb restarts the adb server (Android Studio, scrcpy and vendor tools bring their own), the tool result says so and what to do.
- **Docker image** `ghcr.io/st412m/brickproof-adb` for linux/amd64 and linux/arm64, with adb; `compose.example.yaml` shows a complete setup. USB devices work on a Linux host.

### Changed
- **Snapshots belong to the device, not to the connection.** One device over USB, over `ip:5555` and over wireless debugging shares one snapshot, so `adb_app action=restore` finds what was done over another connection. Snapshots of ha-adb-mcp 1.x are still read. A device without a usable serial number keeps a snapshot per connection, and the result says so.
- **`allow_shell` is off by default.** `adb_shell` bypasses every guard rail; turn it on when you need it.
- **A damaged snapshot file stops the call** before anything happens on the device; it is moved aside and kept, and `adb_app action=state` lists it.
- **`adb_ui_dump` leaves no files behind** on the device, also after a timeout: dump files older than two minutes are removed before the next dump.
- **Tool descriptions** say when to use a tool rather than its neighbour, and which tool undoes it; parameters have descriptions.
- Refusals name this server's settings (`allow_shell`, `allow_uninstall`, `file_roots`, `store`) instead of the Home Assistant options.

### Fixed
- `adb_text` types quotes, backslashes and shell characters as they are; ha-adb-mcp 1.x put a stray backslash before `'`, `&`, `;` and others.
- `adb_text` with non-Latin text checks that ADBKeyBoard really became the input method, before and after typing; ha-adb-mcp 1.x reported the text as typed while a connected Google TV remote held the keyboard and nothing arrived.
- `adb_text` no longer says "Typed" when no on-screen keyboard is shown: the text is still sent, and the answer says it may have gone nowhere.
- `adb_find_and_tap` on a TV box picks the DPAD axis by where the target lies, not by the centres alone, and tries the other axis once before it gives up.
- `adb_ui_dump` tries once more after "null root node".
- `adb_app` and `adb_uninstall` count a change by the package list read afterwards, not by what `pm` prints: some firmware answers `pm disable-user` with a warning and does not always apply it, and ha-adb-mcp 1.x recorded it as applied either way.
