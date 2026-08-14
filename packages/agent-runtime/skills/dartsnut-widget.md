---
name: dartsnut-widget
description: Dartsnut Pillow widget loop, dependencies, widget_params synchronization, font catalog usage, and glanceable widget layout. Load when creating or changing a widget.
---

# Dartsnut widget

Use Pillow only; never import `pygame` in widget code.

Default dependencies: `aiohappyeyeballs==2.6.1`, `aiohttp==3.13.3`, `aiosignal==1.4.0`, `attrs==25.4.0`, `certifi==2026.1.4`, `charset-normalizer==3.4.4`, `frozenlist==1.8.0`, `idna==3.11`, `multidict==6.7.1`, `numpy==2.4.2`, `pillow==12.1.1`, `propcache==0.4.1`, `pydartsnut==1.2.1`, `requests==2.32.5`, `typing_extensions==4.15.0`, `urllib3==2.6.3`, `yarl==1.22.0`.

## Loop

1. Create one `Dartsnut()` instance.
2. Read `dartsnut.widget_params` with fallbacks equal to `conf.json.fields[].default`.
3. Run `while dartsnut.running:`.
4. Build a Pillow image matching `conf.json.size`.
5. Call `dartsnut.update_frame_buffer(frame)` once.
6. Sleep briefly to cap update rate.

When configurability changes, update schema and runtime together. Never expose a field that code ignores or read an undeclared required field.

## Fonts

Use the host-provided `availableWidgetFonts` catalog. Each entry contains exact `file`, `glyphWidth`, and `glyphHeight`.

- Copy the exact basename with `copy_asset_file` into `./fonts/`.
- Bitmap fonts require matching `.pil` and `.pbm` files when both are listed.
- Load relative to `Path(__file__).parent / "fonts"`.
- Do not inspect font files outside the workspace or invent hashed filenames.

## Layout

- Lead with the single value or state users need at a glance.
- Keep secondary information small, stable, and legible.
- Use animation only to explain state changes.
- Verify every configured size at native resolution when layout branches by size.
