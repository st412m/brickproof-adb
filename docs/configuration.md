# Configuration

Nothing needs to be configured: without any setting the server uses your Downloads folder for files, keeps the safety switches off, finds adb by itself and remembers the devices you connect.

## Changing a setting

```
brickproof-adb set allow_shell on
brickproof-adb set file_roots /home/me/android /home/me/Downloads
brickproof-adb set allow_shell
```

`set` writes the settings file (and creates it), and says where. Without a value the key is removed and its default applies again. A running server uses the change after a restart; over stdio that means restarting the client (Claude Desktop, Claude Code). When an environment variable sets the same key, `set` warns that the variable wins.

The Claude Desktop extension and the Home Assistant app keep their settings in their own forms; change them there.

No tool changes a setting: the safety switches `allow_shell` and `allow_uninstall` are always turned on by a person.

## Where settings come from

Flags, then environment variables, then the settings file, then the defaults. Flags: `--port`, `--host` and `--token-file` of `serve`, and the folders given to the stdio server (`brickproof-adb [<folder>...]`), which are `file_roots`.

The settings file is `BRICKPROOF_CONFIG` when set (it must exist), else `config.json` in the configuration directory:

| System | Configuration directory | State directory |
|---|---|---|
| Linux | `$XDG_CONFIG_HOME/brickproof-adb`, default `~/.config/brickproof-adb` | `$XDG_STATE_HOME/brickproof-adb`, default `~/.local/state/brickproof-adb` |
| macOS | `~/Library/Application Support/brickproof-adb` | the same |
| Windows | `%APPDATA%\brickproof-adb` | `%LOCALAPPDATA%\brickproof-adb` |

The file is JSON. An unknown key or a wrong value stops the start with the list of problems. A short example:

```json
{
  "allow_shell": false,
  "devices": ["192.0.2.50", "192.0.2.51:5555"],
  "file_roots": ["/home/me/android"],
  "scan_subnets": ["192.168.77.0/24"]
}
```

## Keys

| Key | Environment | Default | Meaning |
|---|---|---|---|
| `port` | — | `3200` | `serve` only |
| `host` | — | `127.0.0.1` | `serve` only; see [security.md](security.md#where-it-listens) |
| `allowed_hosts` | — | `[]` | host names accepted in `Host` and `Origin` on a localhost bind, besides localhost |
| `log_requests` | `BRICKPROOF_LOG_REQUESTS` | `false` | `[req]` and `[tool]` lines in stderr |
| `allow_shell` | `BRICKPROOF_ALLOW_SHELL` | `false` | `adb_shell`, and `CALL` intents of `adb_app action=launch` |
| `allow_uninstall` | `BRICKPROOF_ALLOW_UNINSTALL` | `false` | `adb_app mode=uninstall` |
| `file_roots` | `BRICKPROOF_FILE_ROOTS` | the Downloads folder | host folders for `adb_push`, `adb_pull`, `adb_install` |
| `devices` | `BRICKPROOF_DEVICES` | `[]` | hosts connected at start, besides the remembered ones; `ip` means `ip:5555` |
| `scan_subnets` | `BRICKPROOF_SCAN_SUBNETS` | `[]` | subnets `adb_devices discover=true` checks for port 5555 instead of this computer's own |
| `store` | `BRICKPROOF_STORE` | `<state_dir>/snapshots` | snapshots and APK backups of `adb_app` |
| `state_dir` | `BRICKPROOF_STATE_DIR` | see the table above | the token, the remembered devices, the downloaded adb, the default store |
| `adb_path` | `BRICKPROOF_ADB` | found by itself | the adb executable; see [installation.md](installation.md#adb) |

Booleans in the environment are `true`/`false` or `1`/`0`. Lists in the environment: `BRICKPROOF_FILE_ROOTS` separated by `;` on Windows and `:` elsewhere; `BRICKPROOF_DEVICES` and `BRICKPROOF_SCAN_SUBNETS` by commas or spaces. Empty items are dropped. An empty `BRICKPROOF_DEVICES` or `BRICKPROOF_ADB` counts as not set; an empty `BRICKPROOF_FILE_ROOTS` means no folders.

`BRICKPROOF_SETTINGS_UI` names where a person changes settings, for the refusal texts: the extension and the Home Assistant app set it, so a refusal says "turn on allow_shell in the extension settings in Claude Desktop" rather than a command. The Docker image sets it to `the environment of the container`, and the refusals then name the variable: "set BRICKPROOF_ALLOW_SHELL=true in the environment of the container and recreate the container".

## `allow_shell`

Off by default. `adb_shell` runs any command the device's shell user may run and goes past every guard rail of `adb_app`, so it is a separate decision. While it is off, a call is refused with what to do, for example:

```
adb_shell is disabled: the server option allow_shell is off. To enable it, run `brickproof-adb set allow_shell on` and restart the server.
```

`adb_app action=launch` also refuses the dialling intents `android.intent.action.CALL`, `CALL_PRIVILEGED` and `CALL_EMERGENCY` while it is off. The other tools keep working with it off: `adb_ui_dump`, `adb_text` with ADBKeyBoard, `adb_logcat` filters and everything `adb_app` does run their own fixed commands.

## `allow_uninstall`

Off by default; `mode=disable` is reversible and covers nearly every case. Turning it on bypasses nothing else: the protected set, the network guard, the account canary and the mandatory APK backup still apply, and the call still needs `dry_run=false`.

## `file_roots`

The only host folders `adb_push`, `adb_pull` and `adb_install` may read or write. When no source sets it, it is the Downloads folder: on Windows the folder the system has for Downloads (it may have been moved to another drive), else `Downloads` in the home folder; on macOS `~/Downloads`; on Linux the folder of `XDG_DOWNLOAD_DIR` (`~/.config/user-dirs.dirs`, the localized name on a localized system), else `~/Downloads`. When that folder does not exist, there is no folder and those tools refuse, saying what to set. `check` and the start line mark the default with `(default)`. The check is described in [security.md](security.md#file-roots).

## Remembered devices

An `adb_connect` after which adb lists the address as `device` remembers it in `devices.json` in the state directory, with the device's key (model and serial number, the same key as its snapshot), and the server connects it again at every start. The same device at a new address replaces its old entry instead of adding a second one; a device without a usable serial number is remembered by its address only. `adb_disconnect` with that address forgets it; `adb_disconnect` without an address disconnects everything but forgets nothing. Phones paired over Wireless debugging are not remembered: their port changes, and adb reconnects them by itself. When a remembered device drops during a call, the server reconnects once and repeats the call; a call that may have changed the device (installs, files, packages, shell) is not repeated but reports the reconnect; reading `adb_app` actions, dry runs and the `adb_install` list are repeated.

## `store`

Where `adb_app` keeps its snapshots (`state.json`) and APK backups, one directory per device. The `store` parameter of a call may name another directory only inside `file_roots`. See [safety.md](safety.md#snapshots-and-rollback).

## `log_requests`

Turns on two kinds of lines in stderr:

- `[req]` per HTTP request: time, client address, method, path with the token masked, status, size;
- `[tool]` per tool call: time, tool, arguments, outcome, duration.

Arguments are masked before they are cut to 300 characters: `adb_text` `text` becomes its length, `adb_pair` `code` and any key named like a password, secret or token become `***`. The same secrets are removed from error texts. `adb_shell` `command` is logged as it is.

## `check`

`brickproof-adb check` prints every setting with where it came from and checks it; see [installation.md](installation.md#checking-the-setup).
