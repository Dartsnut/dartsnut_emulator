# design-console-smallform

Design guidance for pixel-perfect, compact Dartsnut UIs, with console-game-favor defaults.

## When to load this skill

Load this skill when the user asks for any of these:
- pixel perfect / crisp / retro / scanline-safe visuals
- compact UI for `64x32`, `128x64`, `128x128`, or `128x160`
- console-like game HUD, score panel, or status overlays
- better visual polish, layout hierarchy, or readability in tiny screens

## Non-negotiable rendering rules

- Use integer coordinates only (`x`, `y`, widths, heights).
- Keep edges on the 1 px grid; avoid anti-aliased primitives where possible.
- Favor integer scale factors for all copied/sampled art.
- Preserve panel boundaries from `dartsnut-display-mapping`; never spill gameplay interactions into the secondary panel.
- Keep visual behavior deterministic frame-to-frame (no jitter from fractional movement).

## Small-form layout budgets

- `64x32`: one dominant metric + one short label line, or tiny status strip + single visual glyph.
- `128x64`: one compact content area + one thin HUD strip.
- `128x128`: one primary gameplay/content region with 1-2 lightweight overlays.
- `128x160`: treat as `128x128` main area + `64x32` secondary status area; prioritize gameplay in main area.

## Typography and icon legibility

- Use pixel fonts or bitmap-safe glyphs for small text.
- Prefer short labels, abbreviations, and numeric-first status.
- Enforce clear hierarchy: title > primary value > secondary metadata.
- At tiny sizes, avoid mixed weights/styles in the same row.
- Keep icon silhouettes simple (high recognizability at low resolution).

## Console-game-favor visual style

- Default to high-contrast palette with limited accent colors.
- Use predictable HUD anchors (top-left stats, top-right status, bottom strip prompts).
- Keep feedback immediate and concise (hit markers, score pop, state badge).
- Reserve animation for gameplay-relevant changes; avoid decorative motion noise.
- If user intent is ambiguous between decorative widget vs game-like behavior, bias toward game-readable HUD structure.

## Widget fallback behavior

For explicit widget projects, keep game flavor lightweight:
- prioritize data clarity and glanceability over effects
- keep interaction hints minimal and unobtrusive
- reuse compact HUD spacing discipline for information density

## Acceptance checklist before finishing

- No subpixel positioning or fractional scale.
- Text remains readable at target size without zooming.
- Main vs secondary panel responsibilities remain valid.
- Primary game/state information is visible within 1 second of glance.
- Visual noise does not compete with core gameplay or core widget metric.
