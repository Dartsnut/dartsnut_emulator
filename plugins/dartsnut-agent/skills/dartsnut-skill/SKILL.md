---
name: dartsnut-skill
description: Legacy Dartsnut runtime index that routes to the granular pydartsnut, conf, display, and asset skills.
license: MIT
---

# pydartsnut runtime (legacy index)

This id is kept for **backward compatibility**. For new work, load granular skills instead of treating this file as the full procedure.

## Load these for coding

| Skill id | When |
|----------|------|
| **`pydartsnut-core`** | Before `main.py` — instance, loop, framebuffer, deps, Chat run steps |
| **`pydartsnut-widget-loop`** | Widget `main.py` (Pillow, no pygame) |
| **`pydartsnut-game-io`** | Game `main.py` with hits/buttons and pygame loop |
| **`conf-contract`** | Before `conf.json` |
| **`karpathy-guidelines`** | Creator execution style (goals, verify, simplicity) |
| **`creator-incremental`** | Every new creator scaffold (constraints + verify run) |

## Also see

- **`dartsnut-display-mapping`** — layout, framebuffer merge, fonts on canvas
- **`asset-pipeline`** — `dartsnut.assets.json`, `assets_loader.py`, placeholders

**Asset-applier sessions:** load **`pydartsnut-core`** + **`asset-pipeline`** (apply mode rules in asset-pipeline).

Do **not** duplicate full loop snippets here — use **`the corresponding Dartsnut plugin skill`** on the ids above.
