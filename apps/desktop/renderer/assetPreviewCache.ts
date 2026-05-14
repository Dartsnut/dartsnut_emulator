import type { AssetManifest } from "@dartsnut/shared-ipc";

export interface PreviewReadRequest {
  cacheKey: string;
  framePath: string;
}

export function getPreviewCacheKey(slotId: string, framePath: string | null | undefined): string {
  return `${slotId}:${framePath ?? "none"}`;
}

export function getMissingPreviewReads(
  manifest: AssetManifest,
  previewDataUrls: Record<string, string | null>
): PreviewReadRequest[] {
  const reads: PreviewReadRequest[] = [];
  for (const slot of manifest.slots) {
    const framePath = slot.binding?.frames[0];
    if (!framePath) {
      continue;
    }
    const cacheKey = getPreviewCacheKey(slot.id, framePath);
    if (previewDataUrls[cacheKey] !== undefined) {
      continue;
    }
    reads.push({ cacheKey, framePath });
  }
  return reads;
}
