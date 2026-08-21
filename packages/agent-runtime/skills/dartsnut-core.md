---
name: dartsnut-core
description: Core Dartsnut project contract, workspace workflow, display mapping, shared pydartsnut rules, and emulator verification. Load for every Dartsnut game or widget change.
---

# Dartsnut core

## Workspace

- Inspect existing files before editing. Preserve unrelated code and config.
- New games need `main.py` and `pyproject.toml`. New widgets additionally need `conf.json`.
- A project is valid only when `pyproject.toml` has non-empty `[project].name` and `[project].version`, plus direct `pydartsnut` in `[project].dependencies`.
- `[project].name` is project identity and `[project].version` is publish version. New games omit `conf.json`. For compatibility, an existing `conf.json` with `"type": "game"` is accepted as a legacy game manifest; any other present `conf.json` must contain both `size` and `fields` or the widget is broken.
- Use one `pydartsnut.Dartsnut()` instance per process.
- Access hardware only through `pydartsnut`; do not import `bluezero`, `dbus-python`, `RPi.GPIO`, or `evdev`.
- Declare non-stdlib dependencies in `pyproject.toml` using `[project]`, `requires-python = ">=3.11"`, `dependencies = [...]`, and `[tool.uv] package = false`.

## Widget `conf.json`

`conf.json` is required only for widgets. Its only required top-level sections are `fields` and `size`.

- `size`: `[width, height]` integers, never a `"128x128"` string.
- `fields`: `[]` when unused.
- Widgets choose among `[128,160]`, `[128,128]`, `[128,64]`, `[64,32]` based on the requested experience.

Widget fields use `id`, `name`, `type`, `default`, with optional `desc` and `required`. Supported types:

- `text`: string; optional integer `max`.
- `number` / `slider`: number; optional `min`, `max`, positive `step`.
- `toggle`: boolean.
- `dropdown`: scalar default present in non-empty `{display,value}` options.
- `checkbox`: array of values from non-empty options.
- `color`: `#RRGGBB`.
- `location`: `{name, lat, lng, timezone}`.
- `image`: `{image, cropbox, image_width?, image_height?}`; optional extension `accept`.

Field ids must be unique. Keep `conf.json.fields` and every `dartsnut.widget_params` consumer synchronized when adding, renaming, removing, or changing a field.

## Framebuffer and display

- Push exactly one frame per main-loop iteration.
- Widget frames are Pillow `Image` objects matching widget `conf.json.size`.
- Game frames use:

```python
engine.update_frame_buffer(
    np.transpose(pygame.surfarray.array3d(screen), (1, 0, 2))
)
```

`array3d()` returns `(W, H, 3)`; transpose is mandatory.

The logical framebuffer may map to a `128x128` main panel plus a `64x32` bottom panel for `128x160`. Keep important content within its intended panel, clip deliberately, and use native-size readable text.

## Verification

After material changes:

1. `check_python` for changed Python files.
2. `reload_emulator`.
3. `observe_emulator` and inspect panel mapping/nonblank bounds; use PNG output when visual layout matters.
4. `get_emulator_logs` and fix `Traceback`, `SyntaxError`, or `ModuleNotFoundError`.
5. For games, exercise a dart or button path with emulator input tools and observe the state change.

Finish only when the requested behavior runs, the frame is readable and nonblank, mapping matches the configured widget size or game framebuffer, and logs are clean.
