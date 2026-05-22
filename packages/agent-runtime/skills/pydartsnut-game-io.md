# pydartsnut game I/O (pygame path)

Load when **`main.py`** needs dart hits, buttons, or a full game loop beyond the minimal stub.

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
| Button presses | `engine.get_button_events()` edge-detected |

**Forbidden:** `get_buttons()`, `get_darts()`, or a separate `input_handler.py` that bypasses these APIs.

## Dart colors

`dart_index` is usually **0–11**. Map **`dart_index % 4`** → **blue, red, green, yellow** (0→blue, 1→red, 2→green, 3→yellow). RGB helpers: load **`game-dart-colors`** when coloring UI from hits.

## Ordering

`handle_events` / poll hits → `update` → `draw` → `flip` → `update_frame_buffer`.

Use **`antialias=False`** on `font.render(...)` for device text.
