---
name: game-dart-colors
description: Dartsnut game dart slot color mapping based on dart_index modulo four.
license: MIT
---

# Game dart colors

Load when game UI maps **`dart_index % 4`** to colors or assigns players by dart slot.

Hits from **`get_dart_hits()`** are **`(dart_index, x, y)`** (`dart_index` usually **0–11**).

## Four colors (per slot-in-group)

| `dart_index % 4` | Name   | RGB (approx.)   |
|------------------|--------|-----------------|
| 0                | blue   | `(0, 60, 255)`  |
| 1                | red    | `(255, 0, 0)`   |
| 2                | green  | `(0, 255, 0)`   |
| 3                | yellow | `(255, 216, 0)` |

Matches common **`12draw`** / **`dart_checker`** semantics.

## Structured helpers

Optional **`dart_colors.py`** (or module-local):

- **`get_dart_color(dart_index)`** → `(color_name, (r, g, b))`
- **`COLOR_RGB`** dict keyed by short names

If the game needs **which of the twelve** darts fired (not only hue), use full **`dart_index`** (or map 1–12 for display), not only `% 4`.
