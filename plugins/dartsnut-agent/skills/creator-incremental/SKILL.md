---
name: creator-incremental
description: Dartsnut workspace scaffold rules, just-in-time skill loading, file constraints, and emulator verification workflow.
license: MIT
---

# Creator incremental scaffold

Technical constraints for workspace files. Load **`karpathy-guidelines`** for edit discipline.

## JIT skills

| Need | Load |
|------|------|
| Root config / `conf.json` | `conf-contract` |
| Runnable `main.py` / loop | `pydartsnut-core` + widget or game loop skill |
| Layout / fonts on canvas | `dartsnut-display-mapping`, `widget-fonts` |
| Game I/O | `pydartsnut-game-io` |
| Art slots / manifest | `asset-pipeline` |

## Reasoning / thinking

- Thinking for **API and layout tradeoffs only** — keep it short.
- **Do not** put implementable `python` / `json` source in thinking.
- **Tools are the only place workspace code lives.**

## Editing existing files

When `conf.json` and `main.py` already exist: use **`glob_files`** / **`grep_files`** to locate the relevant code, **`read_file`** before edits; prefer **`replace_in_file`** (make `find` unique, or `replace_all`). Do not rescaffold unless the user asks.

## Verify

Use **`check_python`** (fast syntax check, no run) after writing/editing Python, then **`reload_emulator`** then **`get_emulator_logs`** after material changes. Stop when logs are clean **and** the user's request is met — do not declare done after a partial skeleton unless that satisfies what they asked for.

## Anti-duplication

- **Do not** paste full file bodies in assistant text when tools will write them.
- **Do not** output code fences for files you are about to create in the same turn.
- **Prefer tools over long assistant plans.**
