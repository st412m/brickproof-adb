# Internals

## One process, two transports

`brickproof-adb` with no command serves MCP on stdio; `brickproof-adb serve` on Streamable HTTP. Both hand every JSON-RPC request to the same dispatcher in `src/server.js`. stdout belongs to the protocol in stdio mode, so every log line of every mode goes to stderr.

On start the server removes temporary directories (`brickproof-*` in the system temp directory) that a killed process left behind, and connects the `devices` of the settings and the remembered ones in the background. Finding adb only checks that files exist; adb is not called otherwise until a tool needs it, so the server starts and lists its tools without adb.

`manifest.json` describes the Claude Desktop extension: Claude Desktop starts `src/main.js` with its own Node.js, the folders of its form as arguments and the other fields as environment variables. `tools/pack-mcpb.mjs` builds the `.mcpb` from an `npm pack` tarball; `.github/workflows/mcpb.yml` does the same for a release.

## Modules

| Module | Responsibility |
|---|---|
| `main.js` | the program (npm bin, extension entry point): runs `cli.js` |
| `cli.js` | commands, the start lines, `check`, `set`, `get-adb` |
| `config.js` | flags, environment, the settings file and `set`, the settings directories and the Downloads folder per system |
| `token.js` | the HTTP token |
| `http.js` | the HTTP listener: token, Host/Origin, protocol version header, Accept |
| `stdio.js` | newline-delimited JSON-RPC on stdin/stdout |
| `server.js` | the dispatcher; argument masking and error redaction for the tool log |
| `registry.js` | tool schemas (`tools/list`) and `tools/call` |
| `adb.js` | the one way to run adb, failure texts, device-shell quoting, argument coercion, temp directories |
| `hostpath.js` | the host path check |
| `device.js` | facts read off the device: properties, packages, accounts, roles, sockets, authenticators, the protected set |
| `session.js` | `adb_devices`, `adb_connect`, `adb_pair`, `adb_disconnect`, `adb_shell`, `adb_logcat`; the remembered devices |
| `discover.js` | `adb_devices discover=true`: mDNS through adb, the port 5555 probe |
| `platform-tools.js` | where adb is found; `get-adb` |
| `ui.js` | screenshot, UI dump, tap, swipe, key, text, find-and-tap |
| `image.js` | the image pipeline in a worker thread |
| `files.js` | `adb_install` with bundles, `adb_uninstall`, `adb_push`, `adb_pull` |
| `apps.js` | `adb_app`: guards, canary, snapshots, rollback |

Settings are read once in `config.js` and passed to the modules by `init` in `src/server.js`; no module reads the environment or starts a process when it is loaded. `device.js` holds what `apps.js` and `ui.js` share, so those two never require each other.

## Adding a tool

A tool is one entry in `TOOLS` in `registry.js` (`name`, `title`, annotations through `meta(title, h)`, `description`, `inputSchema`) plus one `case` in `callTool`. Both halves are needed: an entry without a `case` fails with `Unknown tool: <name>`, a `case` without an entry is invisible. The descriptions are the only manual the assistant reads; a parameter description stays within 200 characters, and anything not needed to make the call belongs in `docs/tools.md`.

## Tests and tools

`npm test` runs `test/*.test.js` with `node:test`, without adb or a device. Wiring tests start `test/fake-adb.js` in place of adb; it answers from rules and cannot tell that a command does not exist on a real device, so it does not replace trying a change on devices.

- `tools/check-doc-examples.mjs` — code spans and output lines in the docs match the source.
- `tools/scan-secrets.mjs` — no private addresses, MACs, tokens or personal paths in the repository.
- `tools/check-release.mjs` — one version everywhere; the package contents.
- `tools/make-image-fixtures.mjs` — writes the image fixtures of `test/image.test.js`, the same bytes every time.

## Traps

**The screenshot never passes through the main thread.** `adb exec-out screencap -p` writes straight into a temporary file; only the worker reads and decodes it, and the worker ends after the frame. Piping the PNG into Node and buffering it there leaks memory frame after frame.

**One adb function.** Every adb call goes through `adb.js` (`adb()`, or `spawnAdb()` for the screenshot stream), so `adb_path`, time limits, error texts and the detection of another adb apply everywhere.

**`adbSh` is tolerant by default.** It appends `; :` to the device command: otherwise the last command of a pipeline sets the exit code and a `grep` without matches fails the whole call.

**Argument coercion.** Some clients send array, object and boolean parameters as JSON strings. `coerceArray`, `coerceBool` and `coerceObject` accept both; a new parameter that reads `args.x` directly breaks on those clients.

**Derived, not listed.** The protected set, the input method of `adb_find_and_tap` and the split choice of `adb_install` are read off the device. A list of package or model names would be right only for the devices it was written against.

**The statistics of a frame follow ImageMagick.** The dark-frame thresholds are calibrated against `%[fx:mean]` and `%[fx:standard_deviation]`, which average the per-channel mean and the per-channel sample deviation; `image.js` computes the same, not the deviation of all samples pooled.
