import { describe, expect, it } from "vitest";
import {
  parseGlyphSizeFromFontBasename,
  parseWidgetFontCatalogFromManifest
} from "../src/widgetFonts";

describe("parseGlyphSizeFromFontBasename", () => {
  it("parses NxM from filename", () => {
    expect(parseGlyphSizeFromFontBasename("10x20.pil")).toEqual({ width: 10, height: 20 });
    expect(parseGlyphSizeFromFontBasename("CG-pixel-3x5-mono.pbm")).toEqual({ width: 3, height: 5 });
  });

  it("returns null when no size token", () => {
    expect(parseGlyphSizeFromFontBasename("big_digits.pil")).toBeNull();
  });
});

describe("parseWidgetFontCatalogFromManifest", () => {
  it("dedupes by sourceNames; WxH names beat pilMetrics bounds", () => {
    const catalog = parseWidgetFontCatalogFromManifest({
      fonts: [
        {
          fontType: "pil",
          sourceNames: ["big_digits.pil"],
          pilMetrics: { maxGlyphWidth: 24, maxGlyphHeight: 102 }
        },
        {
          fontType: "pbm",
          sourceNames: ["big_digits.pbm"],
          pilMetrics: null
        },
        {
          fontType: "pil",
          sourceNames: ["10x20.pil"],
          pilMetrics: { maxGlyphWidth: 20, maxGlyphHeight: 20 }
        },
        {
          fontType: "pil",
          sourceNames: ["6x13.pil"],
          pilMetrics: { maxGlyphWidth: 12, maxGlyphHeight: 13 }
        }
      ]
    });
    expect(catalog).toHaveLength(3);
    const big = catalog.find((e) => e.file === "big_digits.pil");
    expect(big).toEqual({ file: "big_digits.pil", glyphWidth: 24, glyphHeight: 102 });
    const ten = catalog.find((e) => e.file === "10x20.pil");
    expect(ten).toEqual({ file: "10x20.pil", glyphWidth: 10, glyphHeight: 20 });
    const six = catalog.find((e) => e.file === "6x13.pil");
    expect(six).toEqual({ file: "6x13.pil", glyphWidth: 6, glyphHeight: 13 });
  });
});
