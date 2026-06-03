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

When `conf.json` and `main.py` already exist: **`read_file` them before edits**; prefer **`replace_in_file`**. Do not rescaffold unless the user asks.

## Verify

Use **`reload_emulator`** then **`get_emulator_logs`** after material changes. Stop when logs are clean **and** the user's request is met — do not declare done after a partial skeleton unless that satisfies what they asked for.

## Anti-duplication

- **Do not** paste full file bodies in assistant text when tools will write them.
- **Do not** output code fences for files you are about to create in the same turn.
- **Prefer tools over long assistant plans.**
