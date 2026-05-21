# Creator incremental scaffold

Phased build for **new** games/widgets. Follow the host **Build guidelines** in the user prompt when present.

## Visible plan (mandatory)

- **Agent steps:** Before phase 1 tools, post **8–15 numbered micro-steps** in the **assistant message** (visible in chat). Each bullet is one read/edit round (e.g. "read main → add imports", "read main → draw clock digits") — not one vague "implement phase 3". **No code fences** in that message.
- **Phase done lines:** After each phase milestone, one short line in the assistant message (e.g. "Phase 1 done."), then the next tool round.
- Do **not** put the full step list only in thinking/reasoning — users read the assistant bubble.

## Reasoning / thinking (mandatory)

- Use thinking for **intent and tradeoffs only** — keep it short (roughly **≤15 lines** of planning prose).
- **Do not** put ` ```python `, ` ```json `, or implementable source code in thinking/reasoning.
- If you catch yourself drafting `main.py` or `conf.json` in thinking, **stop** and use **`read_file`** + **`replace_in_file`** (or **`write_file`**) instead.
- **Tools are the only place project code lives.**

## Iteration loop (mandatory after phase 2)

Once minimal `main.py` exists:

1. **`read_file` `main.py` first** every round (and `conf.json` when size/config matters) **before** any edit in that round.
2. **One small change per round:** at most **one** primary `replace_in_file` (or `write_file` for a new path). Prefer hunks under ~40 lines.
3. **No tool-free build rounds** after the stub — only the final round may be a one-sentence status with no tools. Skill-only or `reload_emulator`-only rounds are for phases 1–2 only.
4. **Assets:** at most **one logical font/asset** per round (`copy_asset_file`); bitmap fonts need **both** `.pil` and `.pbm` — copy both in the **same** round, then **next round** `read_file` `main.py` and wire with `replace_in_file`.
5. Decide the **next** micro-step from what `read_file` returned — do not assume file contents from memory.

## Verify run (mandatory)

Reload to restart the widget; **`get_emulator_logs`** to confirm Python compiles and runs (scan for Traceback, SyntaxError, ModuleNotFoundError).

| When | Tools |
|------|-------|
| After phase 1 (`conf.json`) | `reload_emulator` → `get_emulator_logs` |
| After phase 2 (`main.py` stub created) | **`reload_emulator` → `get_emulator_logs`** (required) |
| After phase 3 milestone (core behavior done) | `reload_emulator` → `get_emulator_logs` |
| After phase 4 (if assets affect runtime) | `reload_emulator` → `get_emulator_logs` |
| Logs show an error after an edit | fix with `read_file` + `replace_in_file`, then reload + logs again |

Do **not** reload after every micro-edit — only at the boundaries above or when logs already show failure. A verify round may be **`reload_emulator` + `get_emulator_logs`** without a file edit.

## Anti-duplication (mandatory)

- **Do not** paste full `conf.json`, `main.py`, or other file bodies in assistant text when you will write them with tools.
- **Do not** output code fences for files you are about to create in the same turn.
- **Do not** re-describe the whole project after `get_dartsnut_skill` returns — continue the same concept and **Agent steps**.
- Prefer **several small tool rounds** over one assistant message with many `write_file` or `copy_asset_file` calls.

## Phases (milestones)

| Phase | What | Tools |
|-------|------|-------|
| 0 | Lock **one** concept in ≤1 sentence (assistant text only) | none |
| 1 | **`conf.json` only** — load `conf-contract` first | `write_file` → **`reload_emulator`** → **`get_emulator_logs`** |
| 2 | **Minimal `main.py`** — load `pydartsnut-core` + `pydartsnut-widget-loop` or `pydartsnut-game-io` | `write_file` → **`reload_emulator`** → **`get_emulator_logs`** |
| 3+ | Core behavior | **`read_file`** then **`replace_in_file`** each round; load `dartsnut-display-mapping` when layout/fonts matter |
| 4 | Fonts / art (only if needed) | one `copy_asset_file` per round, then read + wire in `main.py` |

**One primary new file per tool round** when scaffolding: first `conf.json`, then stub `main.py`, then read/edit loops.

Phase 2 stub shape is in **`pydartsnut-widget-loop`** / **`pydartsnut-game-io`** — load those skills; **do not** retype a full stub in thinking or assistant text. Stub = blank frame only (no unused `ImageDraw` / font imports).

## Follow-up edits

When `conf.json` and `main.py` already exist, **`read_file` them first every round**; use **`replace_in_file`** for changes. Do not rescaffold unless the user asks to start over.
