# pydartsnut core (Dartsnut machine)

Load **before** writing or heavily editing **`main.py`**. Type-specific loop details: **`pydartsnut-widget-loop`** (widgets) or **`pydartsnut-game-io`** (games).

## Scope

Integration with the **Dartsnut machine** via **`pydartsnut`** — not generic Python apps or pygame demos without machine I/O.

## Run / preview (Dartsnut Agent)

In README or final replies:

1. **reload_emulator** — restarts the embedded preview and re-reads `conf.json`.
2. **get_emulator_logs** — read recent Python stdout/stderr from the bridge (use after reload to confirm no Traceback/SyntaxError).
3. The emulator pane also has **Logs** for the user; agents should use **`get_emulator_logs`**, not assume they can see the UI.
4. Do **not** tell users to `cd` and `python main.py` unless they asked for CLI-only steps.

## Dependencies (hardware boundary)

- **No** low-level device imports (`bluezero`, `dbus-python`, `RPi.GPIO`, `evdev`, etc.).
- **All** hardware access through **`pydartsnut.Dartsnut`**.
- Agents may use additional Python packages when they fit the requested app and can be installed by both emulator and firmware.
- If `main.py` imports anything beyond stdlib/local modules, ensure the workspace has a valid **`pyproject.toml`**. Emulator and firmware pull dependencies with **uv** from that file.
- Use uv project metadata: `[project]`, `requires-python = ">=3.11"`, a `dependencies = [...]` list, and `[tool.uv] package = false`.
- Generated app `pyproject.toml` must include at least the matching default app dependency set listed in the game/widget creator skill, then append app-specific packages.
- Prefer pinned versions for app-specific packages.

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

- **Widgets:** Pillow `Image` sized to `conf.json` `size`.
- **Games:** pygame `Surface` — always convert with **numpy transpose** before pushing:

```python
import numpy as np          # required — add to imports at top of file
# ... inside main loop, after pygame.display.flip() ...
engine.update_frame_buffer(np.transpose(pygame.surfarray.array3d(screen), (1, 0, 2)))
```

> **Warning:** `array3d()` returns shape `(W, H, 3)` (column-major). Passing it directly — without `np.transpose(..., (1, 0, 2))` — swaps rows and columns, producing a corrupted scrolling-noise render. The transpose is **mandatory**, not optional.

**Layout, panels, clipping, fonts on canvas:** load **`dartsnut-display-mapping`** when needed.

**Art slots / manifests:** load **`asset-pipeline`** when the project has art-bearing entities.
