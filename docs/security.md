# Security

## The token

Over stdio there is no token: the client starts the server as its own process. Over HTTP (`serve`) every request needs the token, either in the path or in a header:

```
/private_<token>/mcp
Authorization: Bearer <token>
```

The secret path is for clients that cannot send headers, such as a claude.ai custom connector. A wrong path gets an empty 404, `/.well-known/*` 404 (so clients never start OAuth), a wrong Bearer token 401.

The token is 32 random bytes as 64 hex characters, generated on the first `serve` and saved in `<state_dir>/token`; it is never read from the configuration file or the command line. `--token-file` or `BRICKPROOF_TOKEN` bring your own (at least 32 characters of `A-Z a-z 0-9 . _ ~ -`). `brickproof-adb token` shows it, `brickproof-adb token --new` replaces it; a running server keeps the old one until restarted.

On Linux and macOS the token file has mode 0600. On Windows the mode has no effect; the file is protected by the access rights of your user profile, where `state_dir` lies.

## Where it listens

`serve` listens on `127.0.0.1:3200` by default. On a localhost bind a `Host` or `Origin` that is not localhost gets 403 (against DNS rebinding); a tunnel or proxy on the same machine that passes on its public name needs that name in `allowed_hosts`. On any other address (`--host 0.0.0.0`) there are no `Host`/`Origin` checks and the token alone protects the server: use HTTPS in front of it.

## File roots

`adb_push`, `adb_pull` and `adb_install` read and write only inside `file_roots`; the `store` parameter of `adb_app` must be the `store` setting or lie inside `file_roots`; every backup path read from a snapshot is checked against the store. A path is refused when it

- is not absolute;
- is a UNC or device path on Windows (`\\server\share`, `\\?\`, `\\.\`);
- lies outside every root, including a sibling whose name starts like a root;
- leads out of the roots through a symlink or junction (the real path of its nearest existing part is compared).

Windows and macOS compare without regard to letter case. The check happens before anything is read, written or created.

## The adb server

The server uses the adb server on `127.0.0.1:5037` that any adb client on the machine shares; it never starts, stops or moves it. The adb server has no authentication: anything that reaches its port controls every connected device. Do not expose port 5037.

The adb key the devices trust is `~/.android/adbkey` of the user that runs the server (in Docker `/data/.android/adbkey`). Whoever has that file is trusted by those devices.

## The network search and the downloaded adb

`adb_devices discover=true` runs only when asked. It reads adb's own mDNS list and opens a TCP connection to port 5555 of each address in this computer's private /24 networks (or `scan_subnets`, private ranges only, at most /22 each), then closes it without sending anything; it connects no device. On some networks such a sweep shows up in an intrusion detection log.

`brickproof-adb get-adb` downloads only from `dl.google.com`, over HTTPS, after you accept Google's terms; nothing else is fetched at run time.

## Settings that only a person changes

No tool writes a setting. `allow_shell`, `allow_uninstall` and `file_roots` change only through `brickproof-adb set`, the settings file, the environment, or the form of the extension or the Home Assistant app — and take effect after a restart.

## What `log_requests` shows

`[req]` lines carry the client address, the method, the path with the token masked, the status and the size. `[tool]` lines carry the tool, its arguments and the outcome: typed text as its length, pairing codes and keys named like secrets as `***`, the same secrets removed from error texts. `adb_shell` commands are logged as they are; type secrets with `adb_text`. Logs go to stderr only.

## What a leaked token gives

Everything the tools can do on every connected device: screenshots, input, installs, file transfer within `file_roots`, and the shell when `allow_shell` is on. Replace it with `brickproof-adb token --new` and restart the server.
