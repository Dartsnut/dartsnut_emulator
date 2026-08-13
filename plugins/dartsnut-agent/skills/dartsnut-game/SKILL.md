---
name: dartsnut-game
description: Dartsnut pygame game loop, dependencies, dart and button APIs, slot colors, and game-specific small-screen layout. Load when creating or changing a game.
---

# Dartsnut game

Use `pygame` for rendering and local events, and `pydartsnut.Dartsnut` for machine input/output.

Default dependencies: `numpy==2.4.2`, `pillow==12.1.1`, `pydartsnut==1.2.1`, `pygame-ce==2.5.7`.

Loop order:

1. Handle `pygame` events and machine input.
2. Update game state.
3. Draw and call `pygame.display.flip()`.
4. Push the transposed framebuffer once.

Use `while running and engine.running` and handle `pygame.QUIT`.

## Input APIs

- `engine.get_dart_hits()` returns consumed `(dart_index, x, y)` hits.
- `engine.get_active_darts()` is only for presence/timing when required.
- `engine.get_button_events()` returns an edge-detected dict with `btn_a`, `btn_b`, `btn_up`, `btn_down`, `btn_left`, `btn_right`.
- Check `button_events.get("btn_a")`; do not iterate `(button, pressed)` tuples.
- Do not use `get_darts()` or `get_buttons()`.
- Emulator button names are `A`, `B`, `UP`, `DOWN`, `LEFT`, `RIGHT`.

When color identifies dart slots, map `dart_index % 4`: blue `(0,60,255)`, red `(255,0,0)`, green `(0,255,0)`, yellow `(255,216,0)`. Keep full `dart_index` when identity among all twelve darts matters.

## Layout

- Main panel owns playfield and immediate hit/action feedback.
- Bottom strip owns stable score, round, timer, combo, or short control hints.
- Use `antialias=False` for device text.
- Keep HUD anchors stable and verify at native resolution.
