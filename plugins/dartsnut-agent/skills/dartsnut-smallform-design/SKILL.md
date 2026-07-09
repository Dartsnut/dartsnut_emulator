---
name: dartsnut-smallform-design
description: Dartsnut small-form visual design guidance for tiny games and widgets.
license: MIT
---

# dartsnut-smallform-design

Design guidance for creating distinctive, readable Dartsnut games and widgets on tiny physical displays.

This consolidates:
- the subject-grounded visual identity process from `frontend-design`
- the pixel-perfect console guidance from `design-console-smallform`
- the panel/layout constraints from `dartsnut-display-mapping`

## When to apply

Load this for any task that asks for visual polish, UI layout, game feel, widget presentation, aesthetics, colors, typography, HUDs, status strips, iconography, or "make it look better."

Also load `dartsnut-display-mapping` when pixel placement or panel boundaries matter.

## Design process

Before drawing code, decide:

1. **Subject** — concrete theme/world of the game or widget.
2. **Audience** — who glances or plays, and in what moment.
3. **Single job** — what the display must communicate first.
4. **Visual identity** — 4-6 colors, one typography/icon style, one signature visual move.

Avoid generic "nice UI." Make choices from the subject: arcade cabinet, lab instrument, scoreboard, cockpit, weather station, tiny toy, neon target range, etc. Spend boldness in one place; keep rest quiet.

## Small-form layout budgets

- `64x32`: one dominant metric + one short label, or one glyph + tiny status.
- `128x64`: one compact content area + one thin HUD/status strip.
- `128x128`: one primary gameplay/content region + 1-2 light overlays.
- `128x160`: main `128x128` for primary content; bottom `64x32` for score/status/prompt.

Never put dart-only interactive targets only on the bottom/secondary panel.

## Pixel rules

- Use integer coordinates, integer sizes, and integer velocity when possible.
- Keep edges on the 1 px grid; avoid antialiased primitives for tiny UI.
- Favor bitmap-safe fonts, short labels, high contrast, and simple silhouettes.
- Keep text within bounds at native size, not just emulator zoom.
- Do not let visual noise compete with core game action or widget metric.

## Visual identity rules

- Pick a palette with clear roles: background, panel, primary text, muted text, accent, danger/success if needed.
- Use 1-2 accent colors; reserve brightest color for current action or state.
- Use shapes that fit the subject: reticles, bars, gauges, capsules, ticks, grids, sparks, dials, cards, or tiles.
- Animation should explain state change: hit, score, countdown, loading, alert. Avoid decorative motion.
- Copy should be functional and short: "HIT", "NEXT", "LOW", "A RESET", "12:45", "x3".

## Game defaults

- Main area: playfield, dart feedback, enemy/target motion, direct action.
- Bottom strip: score, combo, timer, ammo/round, state hint.
- Immediate feedback: hit marker, flash, tiny score pop, sound trigger if present.
- Keep HUD anchors predictable so player reads while throwing.

## Widget defaults

- Lead with the one value or state users care about.
- Secondary info should be tiny, stable, and glanceable.
- Prefer clear data hierarchy over decorative scene building.
- Use icon + number only when icon remains recognizable at native size.

## Verification

After reload, call `observe_emulator` with `include_png: true`.

Check:
- `frame.mainSurfacePngBase64` for main-area composition.
- `frame.bottomSurfacePngBase64` for secondary strip readability when present.
- `display.panels[].stats.nonBlackBounds` for blank/overflow detection.
- `display.panels[].stats.dominantColors` for palette sanity.
- `display.mapping` matches `conf.json` size.

Accept only when native-size layout is readable, nonblank, panel responsibilities are clear, and logs are clean.
