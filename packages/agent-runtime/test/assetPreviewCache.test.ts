import { describe, expect, it } from "vitest";
import type { AssetManifest } from "@dartsnut/shared-ipc";
import { getMissingPreviewReads, getPreviewCacheKey } from "../../../apps/desktop/renderer/assetPreviewCache";

describe("assetPreviewCache", () => {
  const baseManifest: AssetManifest = {
    version: 1,
    slots: [
      {
        id: "hero",
        description: "Main sprite",
        kind: "static",
        size: [16, 16],
        frames: 1,
        placeholder: { color: [0, 0, 0] },
        binding: null
      }
    ]
  };

  it("does not schedule preview reads for unbound slots", () => {
    expect(getMissingPreviewReads(baseManifest, {})).toEqual([]);
  });

  it("requests the first bound frame when it is uncached", () => {
    const manifest: AssetManifest = {
      ...baseManifest,
      slots: [
        {
          ...baseManifest.slots[0],
          binding: {
            source: "assets/_sources/hero.png",
            frames: ["assets/hero/frame_000.png"],
            meta: "assets/hero/meta.json"
          }
        }
      ]
    };

    expect(getMissingPreviewReads(manifest, {})).toEqual([
      {
        cacheKey: getPreviewCacheKey("hero", "assets/hero/frame_000.png"),
        framePath: "assets/hero/frame_000.png"
      }
    ]);
  });

  it("skips bound frames that are already cached", () => {
    const framePath = "assets/hero/frame_000.png";
    const manifest: AssetManifest = {
      ...baseManifest,
      slots: [
        {
          ...baseManifest.slots[0],
          binding: {
            source: "assets/_sources/hero.png",
            frames: [framePath],
            meta: "assets/hero/meta.json"
          }
        }
      ]
    };

    expect(
      getMissingPreviewReads(manifest, {
        [getPreviewCacheKey("hero", framePath)]: "data:image/png;base64,abc"
      })
    ).toEqual([]);
  });
});
