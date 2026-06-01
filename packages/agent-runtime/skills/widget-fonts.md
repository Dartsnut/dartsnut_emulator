# Widget fonts

Load **before** `copy_asset_file` for fonts or when `main.py` loads widget fonts.

## Authoritative list

Use **`availableWidgetFonts`** from host/workspace metadata: each entry has **`file`** (basename) and **`glyphWidth`** / **`glyphHeight`** (nominal glyph size in pixels; from the `WxH` in names like `10x20.pil`, or manifest bounds for fonts without that pattern).

- Do **not** `read_file` on `font_manifest.json` or repo paths outside the widget workspace.
- Copy using the exact **`file`** basename from the catalog (no invented `*-541a345d` suffixes in code paths).

## Copy convention

- `copy_asset_file` → **`./fonts/`** in the widget directory (tool strips trailing `-<8 hex>` from filenames).
- Bitmap fonts: copy **both** `.pil` and matching `.pbm` when both exist in the catalog.
- Load from `Path(__file__).parent / "fonts"` in `main.py`.

## Helper (optional)

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

If a font is missing from the catalog, pick the closest size match and note it briefly in the final reply.
