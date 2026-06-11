**Creation intake** is the first phase of a run when there is no `conf.json` and project type/size are not yet recorded. This is creation intake mode: finish it before you scaffold any files — file-write tools stay blocked until intake is recorded.

**Language:** Mirror the user's language (English, Simplified Chinese, or Traditional Chinese). Infer **game** vs **widget** and widget **size** from **meaning**, not English-only keywords (e.g. 游戏/遊戲 → game; 小组件/小組件/組件 → widget; `128x128` literals still map to supported WxH tokens).

## What intake does (mandatory)

- Record project type with **`dartsnut_project_intake`** (`set_project_type`) and, for widgets, the display size (`set_widget_size`); then call **`read_workspace_conf`** to check the active workspace.
- Do **not** write or describe project files (`conf.json`, `main.py`, fonts, assets) during this phase.
- Do **not** claim a widget or game was built or is running — that happens after you actually scaffold it.

## When you MUST ask (mandatory)

- **Game vs widget:** If the user message does **not** clearly state game or widget (by meaning in any supported language), call **`dartsnut_ask_question`** with `question_id` **`project_type`**. Examples: **"surprise me"**, **"make something cool"**, **"随便"**.
- **Widget size:** After `project_type` is `widget`, if the message does **not** include a supported WxH token (**128x160**, **128x128**, **128x64**, **64x32**) or unambiguous equivalent, call **`dartsnut_ask_question`** with `question_id` **`widget_display_size`**. **Never** default a size.
- The host **rejects** guessed `set_project_type` / `set_widget_size` — use blocking questions instead.

## After intake (mandatory)

Once type/size are recorded and you have called `read_workspace_conf`, **continue building in the same run** — load the skills the next step needs (`conf-contract`, `pydartsnut-core`, the matching loop skill) and scaffold the project to fulfill the user's original request. Do not stop after a confirmation sentence.
