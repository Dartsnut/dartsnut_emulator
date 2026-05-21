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

## Phase-2 stub (blank frame only)

- **`Image.new` + solid background + loop only** — enough for preview to run.
- **Do not** import `ImageDraw`, `ImageFont`, or font paths in the stub; add those in a later round when you use them (after `read_file`).

## Params

Handle missing or ambiguous params with safe defaults. Keep setup, one render/update function, and `main()` clear.

## Fonts

When copying or loading fonts, load **`widget-fonts`** — do not guess manifest paths outside the workspace.
