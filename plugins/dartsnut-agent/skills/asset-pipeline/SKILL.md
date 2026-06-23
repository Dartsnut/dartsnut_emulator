---
name: asset-pipeline
description: Dartsnut asset manifest, loader-helper, placeholder, and apply-mode workflow for art-bearing entities.
license: MIT
---

You are the shared **asset pipeline** skill for Dartsnut games and widgets.

## When to apply

Apply this skill whenever a game or widget has an **art-bearing entity** — a sprite, icon, animation, or background image that should carry bound user art. This is the single source of truth for the asset manifest, the loader-helper interface, the placeholder fallback, and the post-bind "apply mode" workflow.

When the user request needs art: add `dartsnut.assets.json`, `assets_loader.py`, and `slot.draw(...)` as appropriate.

**Apply mode** (separate host step after bind): only wire loader + named slots — see Apply mode section below.

## Chat images — use Assets pane, not chat paste

The desktop app does not bind art from chat messages. **Do not** ask the user to paste or upload images in chat.

When adding art slots:

1. Call **`the corresponding Dartsnut plugin skill`** for **`asset-pipeline`** if not already loaded.
2. Add **`dartsnut.assets.json`** with a slot (`id`, `description`, `size`, `placeholder`, `binding: null`).
3. Scaffold **`assets_loader.py`** and wire **`slot.draw(...)`** in render code.
4. Tell the user to bind files in the desktop **Assets** pane: **Choose File** on the slot, then **Apply Assets**.

Both `game-creator` and `widget-creator` reference this skill. Do not restate its rules from those skills — read them here.

The launcher does not require `dartsnut.assets.json`. Only create one when at least one entity should carry art. Pure code-drawn UI (text, lines, simple gradients) does not need a manifest.

## Manifest: `dartsnut.assets.json`

The manifest lives at the **workspace root**, alongside `conf.json` and `main.py`. It is JSON with this shape:

```json
{
  "version": 1,
  "slots": [
    {
      "id": "player",
      "description": "Main player sprite",
      "kind": "static",
      "size": [16, 16],
      "frames": 1,
      "placeholder": { "color": [0, 200, 255] },
      "binding": null
    }
  ]
}
```

Slot fields:

- `id` — kebab-case, unique within the manifest. Used as the directory name and the loader key. Never rename or renumber an existing slot when adding new ones; only append.
- `description` — short human label shown in the desktop Asset Manager pane.
- `kind` — one of `"static"`, `"gif"`, `"spritesheet"`. Pick based on how the entity animates:
  - `static` — single still frame.
  - `gif` — animated GIF source; runtime cycles through frames using durations from `meta.json`.
  - `spritesheet` — horizontal strip of N equally-sized frames (total source width = `size[0] * frames`, height = `size[1]`).
- `size` — `[width, height]` of a single frame, in pixels. Match the entity's intended draw size.
- `frames` — integer frame count. Must be `1` for `static`. Must equal the GIF/spritesheet frame count for the other kinds.
- `placeholder.color` — `[r, g, b]` integers in `0..255`. Rendered as a solid rectangle of `size` when `binding` is `null`. Choose a color that is visually distinct from other slots so the user can tell entities apart on first run.
- `binding` — `null` until the user binds a file; the desktop pipeline fills it in (do not author this field manually).

When binding fills the field, it always uses this layout:

```
<workspace>/
├── dartsnut.assets.json
├── assets/
│   ├── _sources/
│   │   └── <slot-id>.<ext>          # original user file, kept for re-runs
│   └── <slot-id>/
│       ├── frame_000.png            # zero-padded per-frame PNGs
│       ├── frame_001.png
│       ├── ...
│       └── meta.json                # { "frames": N, "durations_ms"?: number[] }
```

Do not write into `assets/_sources/` or `assets/<slot-id>/` from generated project code. The desktop bind pipeline owns those paths.

## How to choose the loader backend

Read `conf.json` `type` from the workspace:

- `"game"` → use the **pygame backend** (Surface targets, `pygame.draw.rect` placeholders).
- `"widget"` → use the **Pillow backend** (PIL `Image` targets, `ImageDraw.rectangle` placeholders, **never import `pygame`**).

The manifest file format is identical for both; only the helper module differs.

## Shared loader-helper interface

Generated projects **must** scaffold a single `assets_loader.py` module that exposes the same logical interface in both backends:

- `load_slot(slot_id) -> SlotRenderer`
- `SlotRenderer.draw(target, x, y, frame_index=None)` — `frame_index=None` means frame `0`.
- `SlotRenderer.frame_count: int`
- `SlotRenderer.frame_duration_ms(i) -> int` (returns a sensible default like `100` when not declared in meta.json).

All entity render code in `main.py` (or modules under `game/`) calls `SlotRenderer.draw(...)` for art-bearing entities; never re-implement loading or drawing inline. This keeps the post-bind apply step deterministic — the same call site renders a placeholder before binding and the bound frames after.

### pygame backend (games)

Reference snippet — adapt names and paths to the workspace, but keep the public surface stable:

```python
import json
from pathlib import Path
import pygame


_ROOT = Path(__file__).parent
_MANIFEST_PATH = _ROOT / "dartsnut.assets.json"


class SlotRenderer:
    def __init__(self, slot):
        self._slot = slot
        self._frames = []
        self._durations_ms = []
        binding = slot.get("binding")
        if binding:
            for frame_rel in binding.get("frames", []):
                surface = pygame.image.load(str(_ROOT / frame_rel)).convert_alpha()
                self._frames.append(surface)
            try:
                meta = json.loads((_ROOT / binding["meta"]).read_text())
                self._durations_ms = list(meta.get("durations_ms") or [])
            except (OSError, ValueError, KeyError):
                self._durations_ms = []

    @property
    def frame_count(self):
        return max(1, len(self._frames))

    def frame_duration_ms(self, i):
        if 0 <= i < len(self._durations_ms):
            return int(self._durations_ms[i])
        return 100

    def draw(self, target, x, y, frame_index=None):
        if not self._frames:
            color = tuple(int(c) for c in self._slot["placeholder"]["color"])
            w, h = self._slot["size"]
            pygame.draw.rect(target, color, pygame.Rect(int(x), int(y), int(w), int(h)))
            return
        idx = 0 if frame_index is None else int(frame_index) % len(self._frames)
        target.blit(self._frames[idx], (int(x), int(y)))


_MANIFEST_CACHE = None


def _manifest():
    global _MANIFEST_CACHE
    if _MANIFEST_CACHE is None:
        if not _MANIFEST_PATH.exists():
            _MANIFEST_CACHE = {"version": 1, "slots": []}
        else:
            _MANIFEST_CACHE = json.loads(_MANIFEST_PATH.read_text())
    return _MANIFEST_CACHE


def load_slot(slot_id):
    for slot in _manifest().get("slots", []):
        if slot.get("id") == slot_id:
            return SlotRenderer(slot)
    raise KeyError(f"Asset slot not found: {slot_id}")
```

### Pillow backend (widgets)

Reference snippet — same interface, different drawing primitives. **Do not import `pygame` from widget code.**

```python
import json
from pathlib import Path
from PIL import Image, ImageDraw


_ROOT = Path(__file__).parent
_MANIFEST_PATH = _ROOT / "dartsnut.assets.json"


class SlotRenderer:
    def __init__(self, slot):
        self._slot = slot
        self._frames = []
        self._durations_ms = []
        binding = slot.get("binding")
        if binding:
            for frame_rel in binding.get("frames", []):
                self._frames.append(Image.open(_ROOT / frame_rel).convert("RGBA"))
            try:
                meta = json.loads((_ROOT / binding["meta"]).read_text())
                self._durations_ms = list(meta.get("durations_ms") or [])
            except (OSError, ValueError, KeyError):
                self._durations_ms = []

    @property
    def frame_count(self):
        return max(1, len(self._frames))

    def frame_duration_ms(self, i):
        if 0 <= i < len(self._durations_ms):
            return int(self._durations_ms[i])
        return 100

    def draw(self, target, x, y, frame_index=None):
        w, h = self._slot["size"]
        if not self._frames:
            color = tuple(int(c) for c in self._slot["placeholder"]["color"])
            ImageDraw.Draw(target).rectangle((int(x), int(y), int(x) + int(w) - 1, int(y) + int(h) - 1), fill=color)
            return
        idx = 0 if frame_index is None else int(frame_index) % len(self._frames)
        frame = self._frames[idx]
        target.paste(frame, (int(x), int(y)), frame if frame.mode == "RGBA" else None)


_MANIFEST_CACHE = None


def _manifest():
    global _MANIFEST_CACHE
    if _MANIFEST_CACHE is None:
        if not _MANIFEST_PATH.exists():
            _MANIFEST_CACHE = {"version": 1, "slots": []}
        else:
            _MANIFEST_CACHE = json.loads(_MANIFEST_PATH.read_text())
    return _MANIFEST_CACHE


def load_slot(slot_id):
    for slot in _manifest().get("slots", []):
        if slot.get("id") == slot_id:
            return SlotRenderer(slot)
    raise KeyError(f"Asset slot not found: {slot_id}")
```

## Authoring rules

When a workspace needs art-bearing entities:

1. Add `dartsnut.assets.json` at the workspace root with one slot per art-bearing entity. Set `binding: null` and pick a distinct `placeholder.color` per slot.
2. Scaffold `assets_loader.py` in the workspace using the snippet for the matching backend.
3. In entity render code, call `assets_loader.load_slot("...")` once at startup and `slot.draw(target, x, y)` (or with a `frame_index`) every frame that draws the entity.
4. Do not load or draw images outside the loader. Do not use `pygame.image.load` in widget code; do not use `PIL.Image` for drawing in game code.
5. If the user iterates on the project later (rename, resize, add an entity), keep existing slot ids stable and only append.

When updating an existing project that already has a manifest, follow the same rules — add new slots only when needed and reuse the existing loader.

## Apply mode

The desktop app invokes the agent in **apply mode** after the user binds one or more assets through the Asset Manager pane. Apply mode is intentionally narrow.

Inputs you receive in apply mode:

- The workspace path.
- The project type (`game` or `widget`).
- A list of slot ids that have just been bound or unbound.

Allowed actions in apply mode:

- Read `dartsnut.assets.json` and `assets_loader.py` to understand current state.
- Edit `assets_loader.py` only when needed (e.g. the helper is missing or out of date).
- Edit the call sites that draw the named slot ids — only to ensure they go through `slot.draw(...)` rather than placeholder primitives left over from earlier scaffolding.

Forbidden in apply mode:

- Re-scaffolding the project, renaming files, or restructuring directories.
- Editing files unrelated to the named slot ids.
- Modifying gameplay logic, layout, fonts, or anything beyond asset loading and slot draw call sites.
- Adding new dependencies or skills.
- Producing prose beyond a one-sentence summary in the response.

If the loader is already up-to-date and all named slot ids are already drawn through `slot.draw(...)`, return an empty `actions` array and a one-sentence response acknowledging the apply was a no-op. Do not invent changes to look productive.

If you cannot identify a clear call site for a named slot id (e.g. the entity is drawn in many places or the code structure makes a surgical edit unsafe), surface that in the response and stop — do not make a sweeping rewrite.
