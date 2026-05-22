export interface WidgetFontCatalogEntry {
  /** Basename for `copy_asset_file` (e.g. `10x20.pil`); hash suffixes are stripped by the tool. */
  file: string;
  glyphWidth: number;
  glyphHeight: number;
}

interface ManifestFontRow {
  fontType?: string;
  sourceNames?: string[];
  pilMetrics?: { maxGlyphWidth?: number; maxGlyphHeight?: number } | null;
}

/** Parse `WxH` from names like `10x20.pil` or `CG-pixel-3x5-mono.pil`. */
export function parseGlyphSizeFromFontBasename(file: string): { width: number; height: number } | null {
  const base = file.replace(/\.(pil|pbm)$/i, "");
  const match = base.match(/(\d+)x(\d+)/i);
  if (!match) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function resolveGlyphSize(row: ManifestFontRow, file: string): { width: number; height: number } | null {
  // Names like `10x20.pil` encode nominal glyph width×height; pilMetrics max bounds can be larger (e.g. 20×20).
  const fromName = parseGlyphSizeFromFontBasename(file);
  if (fromName) {
    return fromName;
  }
  const mw = row.pilMetrics?.maxGlyphWidth;
  const mh = row.pilMetrics?.maxGlyphHeight;
  if (typeof mw === "number" && typeof mh === "number" && mw > 0 && mh > 0) {
    return { width: mw, height: mh };
  }
  return null;
}

/**
 * Deduplicated widget font list with glyph pixel sizes for Creation context.
 * Uses manifest `sourceNames` (logical basenames), not hashed `fileName` values.
 */
export function parseWidgetFontCatalogFromManifest(manifest: {
  fonts?: ManifestFontRow[];
}): WidgetFontCatalogEntry[] {
  const byFile = new Map<string, WidgetFontCatalogEntry>();
  for (const row of manifest.fonts ?? []) {
    const file = row.sourceNames?.[0];
    if (typeof file !== "string" || file.length === 0) {
      continue;
    }
    const size = resolveGlyphSize(row, file);
    if (!size) {
      continue;
    }
    const entry: WidgetFontCatalogEntry = {
      file,
      glyphWidth: size.width,
      glyphHeight: size.height
    };
    const prev = byFile.get(file);
    if (!prev || row.fontType === "pil") {
      byFile.set(file, entry);
    }
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}
