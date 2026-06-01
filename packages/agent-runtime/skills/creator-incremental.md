# Creator incremental scaffold

Technical constraints for writing **`conf.json`**, **`main.py`**, and related files. Load **`karpathy-guidelines`** for edit discipline.

## JIT skills

| Need | Load |
|------|------|
| Root config / `conf.json` | `conf-contract` |
| Runnable `main.py` / loop | `pydartsnut-core` + widget or game loop skill |
| Layout / fonts on canvas | `dartsnut-display-mapping`, `widget-fonts` |
| Game I/O beyond stub | `pydartsnut-game-io` |
| Art slots / manifest | `asset-pipeline` |

## Reasoning / thinking

- Thinking for **API and layout tradeoffs only** — keep it short.
- **Do not** put implementable `python` / `json` source in thinking.
- **Tools are the only place workspace code lives.**

## Editing existing files

When `conf.json` and `main.py` already exist: **`read_file` them before edits**; prefer **`replace_in_file`**. Do not rescaffold unless explicitly asked.

Stub shape lives in **`pydartsnut-widget-loop`** / **`pydartsnut-game-io`** — do not retype full files in thinking or assistant text. Stub = blank frame only (no unused imports).

## Verify run

**`reload_emulator`** then **`get_emulator_logs`** (scan for Traceback, SyntaxError, ModuleNotFoundError).

| When | Tools |
|------|-------|
| After creating or materially changing **`conf.json`** | reload → logs |
| After first runnable **`main.py`** (stub or major rewrite) | reload → logs |
| Before declaring done | reload → logs |
| Logs show error after an edit | read → fix → reload → logs |

Do not reload after every tiny edit unless logs already show failure. **Stop when reload + logs are clean** (no runtime errors).

## Anti-duplication

- **Do not** paste full `conf.json`, `main.py`, or other file bodies in assistant text when tools will write them.
- **Do not** output code fences for files you are about to create in the same turn.
- **Prefer tools over long assistant plans.**
