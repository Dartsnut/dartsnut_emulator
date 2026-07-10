# pydartsnut game I/O (pygame path)

Load when **`main.py`** needs dart hits, buttons, or a full game loop.

Requires **`pydartsnut-core`** and **`conf-contract`** already applied.

## Rendering stack

- **`pygame`** for drawing and local quit events.
- **`Dartsnut`** for machine input and `update_frame_buffer`.
- Each frame: poll engine → update → draw → `pygame.display.flip()` → push framebuffer.

## Hardware integration (mandatory)

| Need | API |
|------|-----|
| New dart hits | `engine.get_dart_hits()` → `(dart_index, x, y)` per hit, consumed once |
| Presence / timing | `engine.get_active_darts()` **only** when required |
| Button presses | `engine.get_button_events()` returns an edge-detected dict |

Supported machine buttons: `A`, `B`, `UP`, `DOWN`, `LEFT`, `RIGHT`. In Python, read event keys `btn_a`, `btn_b`, `btn_up`, `btn_down`, `btn_left`, `btn_right` from the dict returned by `get_button_events()`, e.g. `button_events = engine.get_button_events(); if button_events.get("btn_a"): ...`. For emulator verification, use `A`, `B`, `UP`, `DOWN`, `LEFT`, `RIGHT` in `set_button` / `tap_button`.

Do **not** write `for button, pressed in engine.get_button_events()` or compare `button == "A"`; that iterates dict keys and misses the `btn_a` event.

**Forbidden:** `get_buttons()`, `get_darts()`, or a separate `input_handler.py` that bypasses these APIs.

## Dart colors

`dart_index` is usually **0–11**. Map **`dart_index % 4`** → **blue, red, green, yellow** (0→blue, 1→red, 2→green, 3→yellow). RGB helpers: load **`game-dart-colors`** when coloring UI from hits.

## Ordering

`handle_events` / poll hits → `update` → `draw` → `flip` → `update_frame_buffer`.

Use **`antialias=False`** on `font.render(...)` for device text.
