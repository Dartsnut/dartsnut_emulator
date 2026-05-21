# Widget fonts

Load **before** `copy_asset_file` for fonts or when `main.py` loads widget fonts.

## Authoritative list

Use **`availableWidgetFonts`** from Creation context JSON (matches `assets/fonts/widgets/`).

- Do **not** `read_file` on `font_manifest.json` or repo paths outside the widget workspace.
- Requested font → exact basename from **`availableWidgetFonts`** (no invented `*-541a345d` suffixes in code paths).

## Role-based defaults

- Body text, labels, metadata → normal UI fonts from the list.
- **`big_digits`** only for a **primary numeric hero** readout (full-width clock, giant countdown) — not because the widget shows time strings or colons on a label line.
- **`date_digits`** only for a **small date stamp** in digit style — not every datetime string.
- Paired **`colon`** font only in hero-digit layouts when present in the list.

## Copy convention

- `copy_asset_file` → **`./fonts/`** in the widget directory (tool strips trailing `-<8 hex>` from filenames).
- Bitmap fonts: copy **both** `.pil` and matching `.pbm`.
- Load from `Path(__file__).parent / "fonts"` in `main.py`.

## Helper (default unless user overrides)

```python
from pathlib import Path
from PIL import ImageFont

FONT_DIR = Path(__file__).parent / "fonts"

def load_widget_font(name: str, size: int | None = None):
    font_path = FONT_DIR / name
    if font_path.suffix.lower() == ".pil":
        return ImageFont.load(str(font_path))
    if size is None:
        size = 12
    return ImageFont.truetype(str(font_path), size)
```

If a font is missing from the list, pick the closest available option and note it briefly in the final reply.
