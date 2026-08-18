---
name: dartsnut-assets
description: Dartsnut asset manifest, stable slot loader contract, placeholders, binding layout, and constrained asset-apply workflow. Load when a game or widget uses user-bound images or animation.
---

# Dartsnut assets

Create an asset pipeline for art-bearing sprites, icons, animations, objects, tiles, characters, or backgrounds. Draw directly in code only for simple geometric shapes and basic UI primitives such as lines, rectangles, circles, solid fills, bars, and indicators; those need no manifest. Do not approximate art-bearing assets with procedural or code-drawn graphics.

Create `dartsnut.assets.json` at workspace root:

```json
{
  "version": 1,
  "slots": [{
    "id": "player",
    "description": "Main player sprite",
    "kind": "static",
    "size": [16, 16],
    "frames": 1,
    "placeholder": { "color": [0, 200, 255] },
    "binding": null
  }]
}
```

- `id`: unique kebab-case and stable after creation.
- `kind`: `static`, `gif`, or `spritesheet`.
- `size`: one frame's `[width,height]`.
- `frames`: `1` for static; exact frame count otherwise.
- `binding`: author as `null`; desktop binding owns it.
- Give placeholders distinct visible colors.

Desktop binding writes originals under `assets/_sources/` and processed frames plus `meta.json` under `assets/<slot-id>/`. Generated project code must not write those paths.

## Loader contract

Create one `assets_loader.py` exposing:

- `load_slot(slot_id) -> SlotRenderer`
- `SlotRenderer.draw(target, x, y, frame_index=None)`
- `SlotRenderer.frame_count`
- `SlotRenderer.frame_duration_ms(i)`, defaulting to `100` ms

Load manifest paths relative to `Path(__file__).parent`. Before binding, draw the slot's solid placeholder. After binding, load paths declared in `binding.frames` and optional durations from `binding.meta`.

- Games load `pygame.Surface` frames and blit them.
- Widgets load RGBA Pillow frames and paste with alpha; never import pygame.
- Render code loads each slot once and always calls `slot.draw(...)`; do not duplicate image loading at call sites.

Tell users to bind files through the desktop Assets pane, then Apply Assets.

## Apply mode

Apply mode may only inspect the manifest/loader and ensure named slot draw sites use `slot.draw(...)`. Do not scaffold, restructure, rename slots, alter layout/gameplay/fonts, or touch unrelated code. If loader and named call sites are already correct, make no changes. If a safe named call site cannot be identified, report that instead of rewriting broadly.
