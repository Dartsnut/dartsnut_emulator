---
name: dartsnut-display-mapping
description: Dartsnut display and framebuffer mapping rules for panels, physical screens, layout, clipping, and fonts.
license: MIT
---

# Dartsnut display mapping (`dartsnut-display-mapping`)

**When to apply — mandatory:** Read and follow this skill for **any** Dartsnut task that touches **pixels, layout, resolution, framebuffer size, UI placement, fonts, or `update_frame_buffer`**. That includes games, widgets, emulator previews, and refactors of drawing code.

**Relationship to other skills:** Use **`dartsnut-skill`** for `pydartsnut` APIs, loops, and I/O. Use **`conf-contract`** for root config. This file is the **single reference for physical screens ↔ framebuffer mapping** and related rendering rules.

---

## Full-frame `128×160` layout (games and full-size widgets)

The **framebuffer** passed to `update_frame_buffer` is always **`128` wide × `160` tall**. It maps to two physical displays:

| Surface   | Image pixels (Pillow / pygame)      | Physical size |
|-----------|-------------------------------------|---------------|
| **Main**  | `x ∈ [0, 127]`, `y ∈ [0, 127]`     | 128 × 128     |
| **Secondary** | `x ∈ [0, 63]`, `y ∈ [128, 159]` | 64 × 32       |

The secondary panel is **left-aligned** in the lower band of the image. Its hardware firmware address origin is `(129, 0)` in the machine's own coordinate space — that does **not** map to image `x`/`y` directly. Always use the image pixel ranges in the table above when drawing.

### Main vs secondary content

- Place gameplay and dart feedback on the main **`128×128`** area when using a full **`128×160`** buffer.
- Use the lower band mapped to the **`64×32`** hardware panel for scores, labels, icons, or status when it improves layout.

## Partial-size widgets (`128×128`, `128×64`, `64×32`)

- Render a Pillow **`Image`** **exactly** at the configured **`[width, height]`** and pass it through **`pydartsnut`** as usual.
- **Do not** manually composite these into a **`128×160`** buffer — **machine firmware performs framebuffer merges** for these sizes.

## Dart hit targets (critical)

- The **bottom / secondary surface is not dart-sensitive**.
- Do **not** place buttons, targets, or other **interactive** affordances that rely on dart hits **only** on the secondary panel.
- If the user insists on dart-interactive UI in that region, **warn** that hits may not register there and recommend relocating interaction to the **main `128×128`** area.

## Clipping

- For every **`128×160`** framebuffer, **always** apply **surface clipping** in your reasoning and drawing:
  - Nothing may render outside **`x ∈ [0, 127]`**, **`y ∈ [0, 159]`**.
  - Respect the **main vs secondary** split so content does not straddle the logical boundary in a way that breaks on hardware.

## Typography

- Choose **font sizes and typefaces** suited to the **main** vs **secondary** real estate (large playfield vs narrow ticker).
- Avoid oversized text that dominates the **`64×32`** strip or overflows the **`128×128`** play area.

## Display layout convention (games)

- Resolution is typically **`[128, 160]`**. Treat the surface as a **`128×128`** primary area plus a **secondary region** mapped to the physical **`64×32`** panel.
