# Creator incremental scaffold

Phased build for **new** games/widgets. Follow the host **Build guidelines** in the user prompt when present.

## Visible plan (mandatory)

- **Agent steps:** Before phase 1 tools, post **5–12 numbered bullets** in the **assistant message** (visible in chat) listing what you will do. Derive from the user request and Creation context. **No code fences** in that message.
- **Phase done lines:** After each phase, one short line in the assistant message (e.g. "Phase 1 done."), then the next tool round.
- Do **not** put the full step list only in thinking/reasoning — users read the assistant bubble.

## Reasoning / thinking (mandatory)

- Use thinking for **intent and tradeoffs only** — keep it short (roughly **≤15 lines** of planning prose).
- **Do not** put ` ```python `, ` ```json `, or implementable source code in thinking/reasoning.
- If you catch yourself drafting `main.py` or `conf.json` in thinking, **stop** and use **`read_file`** + **`replace_in_file`** (or **`write_file`**) instead.
- **Tools are the only place project code lives.**

## Anti-duplication (mandatory)

- **Do not** paste full `conf.json`, `main.py`, or other file bodies in assistant text when you will write them with tools.
- **Do not** output code fences for files you are about to create in the same turn.
- **Do not** re-describe the whole project after `get_dartsnut_skill` returns — continue the same concept and **Agent steps**.
- Prefer **several small tool rounds** over one assistant message with many `write_file` calls.

## Phases (milestones)

| Phase | What | Tools |
|-------|------|-------|
| 0 | Lock **one** concept in ≤1 sentence (assistant text only) | none |
| 1 | **`conf.json` only** — load `conf-contract` first | `write_file` → **`reload_emulator`** |
| 2 | **Minimal `main.py`** — load `pydartsnut-core` + `pydartsnut-widget-loop` or `pydartsnut-game-io` | `write_file` |
| 3+ | Core behavior | `read_file` + **`replace_in_file`**; load `dartsnut-display-mapping` when layout/fonts matter |
| 4 | Fonts / art (only if needed) | `widget-fonts`, `asset-pipeline`, `copy_asset_file` |

**One primary new file per tool round** when scaffolding: first `conf.json`, then stub `main.py`, then edits.

Phase 2 stub shape is documented in **`pydartsnut-widget-loop`** / **`pydartsnut-game-io`** — load those skills; **do not** retype a full stub in thinking or assistant text.

## Follow-up edits

When `conf.json` and `main.py` already exist, **read** them first; use **`replace_in_file`** for changes. Do not rescaffold unless the user asks to start over.
