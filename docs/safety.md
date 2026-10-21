# Safety

What keeps an assistant from breaking a device, layer by layer, and what is outside these guards.

## Dry run first

Every `adb_app` action that changes the device's packages — `disable`, `uninstall`, `enable`, `restore` — and `clear` default to `dry_run=true`. (`backup` changes nothing on the device and runs at once.) The dry run returns the plan: each package, whether it is a system package, how it would be rolled back, the guard results and any advisories. Nothing is applied until the same call comes with `dry_run=false`. `adb_install` reports the same way and installs only with `dry_run=false`.

## The protected set, read off the device

Before `disable` or `uninstall` the server asks the device which packages it cannot live without:

- the current launcher;
- the active input method;
- the package installer;
- the WebView provider;
- every role holder (`dumpsys role`, Android 10 and newer);
- system packages that hold a listening network socket, or register an account authenticator;
- packages whose names belong to an account stack (a supplementary heuristic);
- a small built-in core (`android`, the system UI, settings, the shell, permission and package installers, the content providers, ADBKeyBoard).

Any overlap aborts the whole call, and there is no override. The refusal names each package with where it came from:

```
REFUSED: the list contains protected packages - com.example.launcher, com.example.remote.
  com.example.launcher — launcher, roles (HOME)
  com.example.remote — roles (SYSTEM_TELEVISION_REMOTE_SERVICE), net_listener
The full set with every source: adb_app action=protected
Nothing was applied. Remove them from the list by hand; the tool has no override.
```

`adb_app action=protected` shows the whole set and a note for every source that could not be read. A source that failed is never silently treated as "nothing to protect".

User packages with the same signals are not refused (their APK can be backed up and installed again), but the plan lists them as advisories.

## The network guard

A package that serves a client outside the device right now is not disabled, uninstalled, stopped or cleared. The signal is read off the device: the package holds a listening TCP socket *and* a non-loopback address is connected to that same port. A listening socket alone does not count, nor does an outbound connection the app opened.

```
REFUSED (disable): the package is currently serving a client outside the device.
  · com.example.remote - listening on ports 6466, 6467, currently serving 192.0.2.52 -> :6466
Nothing was applied. Repeat with force_network: true to override; `force` does not lift this guard.
```

A socket of a uid shared by several packages cannot be tied to one of them; it is refused all the same, with the link stated as unproven. `force_network=true` lifts this guard and nothing else; `force` (go on after a failed APK backup) does not lift it.

Every plan and report carries `network_guard` with a `status`:

| `status` | Meaning |
|---|---|
| `not_serving` | the guard ran and found no outside client |
| `overridden` | a hit was lifted by `force_network=true` |
| `blind` | the socket table could not be read, so the action ran without this check |

## The account canary

Packages are changed in batches (5 by default, `batch_size` up to 25). Before the first batch the server counts the device's accounts; after every batch it counts them again and checks that the launcher still resolves. A drop rolls that batch back and stops the call. Losing an account registration does not crash anything; it shows up later, in the store, which is why it is checked here.

## Snapshots and rollback

Everything `disable` and `uninstall` apply goes into a snapshot, and `adb_app action=restore` undoes it in one call (a dry run first, like every change). Disabled packages come back with `pm enable`; uninstalled system packages with `cmd package install-existing`; uninstalled user packages from their APK backup.

What counts as applied is what the device shows afterwards, not what `pm` prints: after each batch (and after a restore) the package list is read once, and a package that is still enabled, still installed or not back is reported as failed, with the device's output, and stays out of the snapshot. Some firmware prints "Warning! This command is illegal!" and applies the change only sometimes; when it did apply, the package counts as applied, with that line as a warning.

A snapshot belongs to the device, not to the connection: its directory in the store is named after the device's model and serial number (`ro.product.model`, `ro.serialno`), so the same phone over USB, over `ip:5555` and over wireless debugging shares one snapshot. A device that reports no usable serial number (empty, `unknown`, or one of the placeholder serials many cheap boxes share) keeps a snapshot per connection, and the results say so. `adb_app action=state` shows the snapshot, its key and where the key came from.

Snapshots live on the machine that made them. A snapshot taken from a PC is not seen by a server in Home Assistant, and the other way round: roll back from where the change was made.

## Uninstalling is locked three times

`mode=uninstall` needs the `allow_uninstall` setting (off by default), an explicit `mode` in the call, and a successful APK backup. A system package removed with `--user 0` stays on the system partition and comes back with `cmd package install-existing`; a sideloaded app comes back only from its backup, so the backup is required. `force=true` goes on after a failed backup and does nothing else.

## `allow_shell`

`adb_shell` runs anything the device's shell user may run, past every guard above, so it is off by default and the name of this project does not cover it. While it is off, `adb_app action=launch` also refuses the dialling intents (`CALL`, `CALL_PRIVILEGED`, `CALL_EMERGENCY`).

Both switches, `allow_shell` and `allow_uninstall`, are turned on by a person: no tool writes a setting, so an assistant cannot unlock them for itself. A refusal says exactly where the person turns one on.

## A damaged snapshot

When `state.json` cannot be read, the call refuses before doing anything on the device and moves the file aside as `state.json.broken-<time>`; it is never overwritten or removed, and `adb_app action=state` lists it. The next call starts an empty snapshot.

## Input

`adb_text` reports only how many characters it typed, never the text, and tells the assistant never to retry a wrong password or PIN: a few failures can lock an account or a device. With `log_requests` on, typed text and pairing codes are masked in the log and in error texts.

## Outside these guards

- `adb_shell` with `allow_shell` on.
- `adb_uninstall`: a direct uninstall without a snapshot, for when you mean it.
- `adb_push` overwrites files on the device.
- What an app does after it is launched or tapped.
