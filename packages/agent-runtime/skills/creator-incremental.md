# Creator incremental scaffold

Constraints for **new** games/widgets. You own the execution plan — follow **`karpathy-guidelines`** (goal + verify) and the host **Success criteria** when present.

## Success criteria (internal checklist)

- [ ] **`conf.json`** valid for project type/size (`conf-contract`)
- [ ] **`main.py`** runs in emulator (reload + logs clean after stub)
- [ ] Behavior matches the user request (`read_file` confirms)
- [ ] No Traceback / SyntaxError / ModuleNotFoundError before declaring done

## Suggested milestones (non-binding)

You may merge, reorder, or batch tool rounds when simpler:

1. Load **`conf-contract`** → write **`conf.json`** → verify (reload + logs)
2. Load **`pydartsnut-core`** + **`pydartsnut-widget-loop`** or **`pydartsnut-game-io`** → minimal **`main.py`** stub → verify
3. Iterate core behavior (`read_file` → edit)
4. Fonts / art only if needed (`copy_asset_file`, then read + wire)

Stub shape lives in **`pydartsnut-widget-loop`** / **`pydartsnut-game-io`** — do not retype full files in thinking or assistant text. Stub = blank frame only (no unused imports).

## JIT skills

Decide from **intent** in any supported language (English, zh-Hans, zh-Hant) — examples below are illustrative, not keyword rules.

| Intent | Load |
|------|------|
| Need root config / `conf.json` | `conf-contract` |
| Need runnable `main.py` / loop | `pydartsnut-core` + widget or game loop skill |
| Layout / fonts on canvas | `dartsnut-display-mapping`, `widget-fonts` |
| Game I/O beyond stub | `pydartsnut-game-io` |
| Art slots, sprites, user will supply/replace images (e.g. 我将提供素材, 我来给你一个…图片) | `asset-pipeline` — bind via **Assets** pane, not chat paste |

## Reasoning / thinking

- Thinking for **intent and tradeoffs only** — keep it short.
- **Do not** put implementable `python` / `json` source in thinking.
- **Tools are the only place project code lives.**

## Editing existing projects

When `conf.json` and `main.py` already exist: **`read_file` them before edits**; use **`replace_in_file`**. Do not rescaffold unless the user asks to start over. You decide edit batch size; prefer smaller hunks when risk is high.

## Verify run

**`reload_emulator`** then **`get_emulator_logs`** (scan for Traceback, SyntaxError, ModuleNotFoundError).

| When | Tools |
|------|-------|
| After creating or materially changing **`conf.json`** | reload → logs |
| After first runnable **`main.py`** (stub or major rewrite) | reload → logs |
| Before declaring done | reload → logs |
| Logs show error after an edit | read → fix → reload → logs |

Do not reload after every tiny edit unless logs already show failure.

## Anti-duplication

- **Do not** paste full `conf.json`, `main.py`, or other file bodies in assistant text when tools will write them.
- **Do not** output code fences for files you are about to create in the same turn.
- **Do not** re-describe the whole project after `get_dartsnut_skill` returns — continue the same concept.
- **Prefer tools over long assistant plans** — optional ≤5-line plan when non-trivial; otherwise tool-first.

## Communication

- No mandatory **Agent steps** lists or **phase done** announcements.
- One short final status when finished; ask only when truly blocked (e.g. missing size).

## Follow-up edits

Read workspace files before changing them. Match existing style. Mention unrelated dead code; do not delete unless asked.
