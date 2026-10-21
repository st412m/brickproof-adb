# Screen and input

## Screenshots

`adb_screenshot` returns a JPEG scaled down to `max_px` and a line with the scale between the image and the screen, computed against the *logical* screen size — the one `input tap` and `adb_ui_dump` use. That is `wm size`'s `Override size:` when the device reports one, else `Physical size:`:

```
screen 1920x1080 (frame 3840x2160) -> image 1024x576 · scale 1.875/1.875 · pass coords="screenshot" to adb_tap/adb_swipe
```

`(frame WxH)` appears only when the captured frame differs from the logical size. Whether it does depends on the device: some boxes with an `Override size:` line capture at the full panel resolution, others at the logical one. The tool measures both on every screenshot rather than assuming. A screen smaller than `max_px` is not enlarged.

Rotation follows the captured frame: a landscape frame with a portrait `wm size` swaps the logical width and height.

`wm size` is read fresh for every screenshot: a device can switch its display mode between two frames. If it cannot be read, the frame size is used and the line says so:

```
⚠ wm size did not parse, the frame size is used - coordinates may not match input tap
```

The image is made on the host in plain JavaScript (decode, downscale by area average, JPEG), in a separate thread per frame. On a 4K frame that takes a fraction of a second on a desktop and longer on a small ARM board; `brickproof-adb check` prints the time on your machine.

### A dark frame

A frame whose mean brightness and spread are both very low comes back with a warning, not a refusal; a black screen is sometimes the truth. What the device can tell about it is added:

```
⚠ frame is almost uniformly dark (mean 0.004, sd 0.001). screen: Asleep
⚠ frame is almost uniformly dark (mean 0.004, sd 0.001). screen: Awake, focused window has FLAG_SECURE, content hidden by the system
⚠ frame is almost uniformly dark (mean 0.004, sd 0.001). screen: Awake, no protection flag found, the frame may genuinely be black
```

`screen:` is `mWakefulness` from `dumpsys power`; the `FLAG_SECURE` note comes from the focused window's flags. Either is left out when it cannot be read; neither is guessed. A capture with no data at all fails with `screencap produced no data (device asleep or protected content?)`.

## Coordinates

`coords="screen"` (the default of `adb_tap` and `adb_swipe`) means the coordinates of `adb_ui_dump`, the space `input tap` uses.

`coords="screenshot"` means pixels read off the last `adb_screenshot` image; the tool rescales them. It works within 120 s of the screenshot and only when `serial` was passed the same way to both calls (a screenshot without `serial` and a tap with it are different keys):

```
the screenshot is stale or was never taken - call adb_screenshot. Pass serial the same way as in adb_screenshot: a screenshot without serial and a tap with serial are different keys.
```

Rotation between the screenshot and the tap is not checked.

## UI dump

`adb_ui_dump` lists the elements that can be pressed or carry a label, with their tap point:

```
[BTN] Network & internet id=title @(540,612) bounds=[0,560][1080,664]
[TXT][FOCUSED] Search settings @(540,180) bounds=[48,150][1032,210]
[BTN][PASSWORD] (password field) id=password @(540,900) bounds=[60,860][1020,940]
```

A dump taken right after the screen changed may be stale; the tool notices an unchanged dump and takes it once more after 600 ms. XML entities in labels are decoded.

The dump, its reading and its removal from the device are one shell command. Dumps of one device run one at a time. A dump file older than two minutes left on `/sdcard` by a call that timed out is removed before the next dump.

## `verify`

`adb_tap`, `adb_swipe` and `adb_key` take `verify`: `"none"` (default), `"activity"` or `"ui"`.

- `"activity"` compares the activity in front before and after: `resumed: A -> B`, or `resumed: unchanged (A)`, or `resumed: unknown`.
- `"ui"` also compares a hash of the UI dump before and after; equal hashes are checked once more after 600 ms, since an animation may still run. It costs 2–4 s. Status bar nodes are ignored, so the clock does not count as a change; focus and selection count. A ticking timer or a rotating carousel can still report `ui: changed`; `ui: unchanged` is reliable. On a swipe, `unchanged` usually means the end of a list.
- A failed check never turns a performed action into an error:

```
Tapped (240, 262) · resumed: unknown · ui: unknown (uiautomator: ERROR: null root node returned by UiTestAutomationBridge)
```

## Finding and activating an element

`adb_find_and_tap` finds an element by `text`, `resource_id` or `desc` and activates it in one call:

```
adb_find_and_tap text="Settings"
adb_find_and_tap resource_id="nav_bar_settings"
adb_find_and_tap text="Apps" exact=true index=1
```

How it activates is read off the device. With `android.hardware.touchscreen` the element's centre is tapped. On a TV box without a touchscreen a tap would press whatever has focus, so the focus is walked there with DPAD keys and `DPAD_CENTER` is pressed. A device with neither is refused rather than tapped blind.

The UI is dumped again after every key. A cycle, or a step that leads further from the target, switches to the other axis once. If the focus stops, goes round in circles again, or does not reach the target within `max_steps` (default 12, at most 40) or about 25 s, the tool reports the path walked and that nothing was pressed:

```
Focus is cycling: back on "Home", already visited on this walk (UP LEFT RIGHT LEFT). Target "Search" cannot be reached by walking - it is most likely not focusable. Nothing was pressed.
```

- `text` matches both the text and the content description: some TV launchers put every label in the description. `desc` matches the description only.
- A label that cannot take focus is raised to the smallest clickable element around it (a card on a TV launcher).
- Several matches without `index` are an error listing them; a label not on screen is an error listing what is.

## Unicode input

Android's `input text` types ASCII only. For anything else `adb_text` uses the [ADBKeyBoard](https://github.com/senzhk/ADBKeyBoard) input method: the current keyboard is noted, ADBKeyBoard takes over for the text, and the previous keyboard is restored, also after a failure. Install ADBKeyBoard on the device once (for example with `adb_install`). ADBKeyBoard is part of the protected set, so `adb_app` does not disable it.
