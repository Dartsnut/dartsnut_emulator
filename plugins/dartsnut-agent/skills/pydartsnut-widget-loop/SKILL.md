---
name: pydartsnut-widget-loop
description: Dartsnut widget main.py guidance for Pillow rendering, widget_params, and update loop behavior.
license: MIT
---

# pydartsnut widget loop (Pillow path)

Load when writing or editing **widget** `main.py`. Requires **`pydartsnut-core`** and **`conf-contract`**.

## Rules

- **Do not** import or use **`pygame`** in widget code.
- Pillow (`Image`, `ImageDraw`, optional `ImageFont`) only.

## main.py requirements

1. `Dartsnut()` instance.
2. Read **`widget_params`** (via `dartsnut.widget_params` / contract in widget-creator template).
3. `while dartsnut.running:` loop.
4. Build a PIL `Image` matching **`conf.json` `size`**.
5. `dartsnut.update_frame_buffer(frame)` each iteration.
6. Small **`time.sleep(...)`** to limit update rate.

## Implementation

Build **`main.py`** to satisfy the **user's request** in conversation history, not a fixed multi-step checklist. Use `ImageDraw`, fonts, and assets when the request needs them — load **`widget-fonts`** before copying or loading font files.

A solid-color loop with no user-visible behavior is only appropriate when the user explicitly asked for a minimal placeholder.

## Params

Handle missing or ambiguous params with safe defaults. Keep setup, render/update, and `main()` clear.

## Verify

After material changes to **`main.py`** or **`conf.json`**, **`reload_emulator`** then **`get_emulator_logs`**. Fix Traceback / SyntaxError / ModuleNotFoundError before finishing.
