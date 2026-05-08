# Dartsnut display mapping (`dartsnut-display-mapping`)

**When to apply — mandatory:** Read and follow this skill for **any** Dartsnut task that touches **pixels, layout, resolution, framebuffer size, UI placement, fonts, or `update_frame_buffer`**. That includes games, widgets, emulator previews, and refactors of drawing code.

**Relationship to other skills:** Use **`dartsnut-skill`** for `pydartsnut` APIs, loops, and I/O. Use **`game-creator`** / **`widget-creator`** for project contracts. This file is the **single reference for physical screens ↔ framebuffer mapping** and related rendering rules.

---

## Full-frame `128×160` (games and full-size widgets)

- The **framebuffer** passed to `update_frame_buffer` is the full **`128×160`** rectangle (**`width` × `height`**).
- On the **physical machine**, that image maps to **two** displays:
  - **Main:** **`128×128`**, top portion of the buffer (primary playfield / primary UI).
  - **Secondary:** **`64×32`**, hardware panel driven from a **mapped band** of the same framebuffer (status strip / auxiliary UI).

### Firmware coordinate note (secondary panel)

- The secondary panel shows the crop corresponding to **`[129, 0]` → `[160, 64]`** in the **machine / firmware** coordinate space.
- That range is **not** literal **`x`** indices in a **`128`**-pixel-wide Pillow/pygame image. When drawing, stay within **`x ∈ [0, 127]`**, **`y ∈ [0, 159]`** and place content intended for the small panel in the **lower band** that firmware maps onto the **`64×32`** display. Treat exact alignment as **firmware-defined** when pixel-perfect placement matters.

### Main vs secondary content (agent judgment)

- **Unless the user specifies otherwise**, you choose what belongs on the **main surface** (top **`128×128`**) versus what is relegated to the **secondary** mapping (bottom strip → **`64×32`** hardware). Typical split: gameplay and dart feedback on the main area; scores, labels, icons, or ambient chrome on the secondary when it improves layout.

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

- Resolution is typically **`[128, 160]`**. Treat the surface as a **`128×128`** primary area plus a **secondary region** mapped to the physical **`64×32`** panel; follow that split when it fits the design unless the user or creation context specifies otherwise.
