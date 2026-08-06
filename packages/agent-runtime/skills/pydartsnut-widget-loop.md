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

Handle missing or ambiguous params with safe defaults matching `conf.json.fields[].default`. Keep setup, render/update, and `main()` clear.

When user intent changes configurable behavior, edit the field definition and its runtime consumer together:

- add a field: add canonical schema in `conf.json` and read `dartsnut.widget_params` by the same id;
- rename an id: update every runtime lookup and helper using the old id;
- remove a field or option: remove obsolete reads/branches and keep the remaining default valid;
- change a type: update coercion/validation expectations in `main.py` to the new runtime value shape.

Preserve unrelated config and code. Do not merely expose a control that the widget ignores, or change runtime behavior without declaring the matching field when the user asked for configurability.

## Verify

After material changes to **`main.py`** or **`conf.json`**, **`reload_emulator`** then **`get_emulator_logs`**. Fix Traceback / SyntaxError / ModuleNotFoundError before finishing.
