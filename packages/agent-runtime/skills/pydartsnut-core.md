# pydartsnut core (Dartsnut machine)

Load **before** writing or heavily editing **`main.py`**. Type-specific loop details: **`pydartsnut-widget-loop`** (widgets) or **`pydartsnut-game-io`** (games).

## Scope

Integration with the **Dartsnut machine** via **`pydartsnut`** — not generic Python apps or pygame demos without machine I/O.

## Run / preview (Dartsnut Chat)

In README or final replies:

1. **Start / Reload** in the emulator pane after the workspace is selected.
2. **Logs** in the same pane for bridge/runtime output.
3. Do **not** tell users to `cd` and `python main.py` unless they asked for CLI-only steps.

## Dependencies (hardware boundary)

- **No** low-level device imports (`bluezero`, `dbus-python`, `RPi.GPIO`, `evdev`, etc.).
- **All** hardware access through **`pydartsnut.Dartsnut`**.
- Games: only `pydartsnut`, `pygame`, optional `pillow`, stdlib (see game-creator template).
- Widgets: `pydartsnut`, `Pillow`, stdlib only.

## Instance and framebuffer

- `from pydartsnut import Dartsnut`
- **One** `Dartsnut()` per process; name it consistently (`engine` or `dartsnut`).
- Call **`update_frame_buffer(...)` exactly once per main-loop iteration**.
- Push a frame **every** loop iteration when driving the machine.

## Loop guard

- Widgets: `while dartsnut.running`
- Games: `while running and engine.running` (also handle `pygame.QUIT` as needed)
- Do **not** ship pygame-only games without `pydartsnut`.

## Frame types

- **Widgets:** Pillow `Image` sized to `conf.json` / Creation context.
- **Games:** pygame `Surface` → transpose `pygame.surfarray.array3d(screen)` before `update_frame_buffer`.

**Layout, panels, clipping, fonts on canvas:** load **`dartsnut-display-mapping`** when needed.

**Art slots / manifests:** load **`asset-pipeline`** when the project has art-bearing entities.
