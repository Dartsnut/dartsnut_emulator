import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AppUpdateStatus } from "@dartsnut/shared-ipc";
import { UpdateReadyOverlay } from "./App";

const availableStatus: AppUpdateStatus = {
  kind: "available",
  currentVersion: "1.5.4",
  availableVersion: "1.5.5",
  percent: 0,
  message: "Update available."
};

describe("update overlay", () => {
  it("shows manual download, skip, and auto-download preference for available updates", () => {
    const markup = renderToStaticMarkup(
      <UpdateReadyOverlay
        status={availableStatus}
        autoUpdateEnabled={false}
        installing={false}
        error={null}
        onDownload={vi.fn()}
        onAutoUpdateChange={vi.fn()}
        onInstallNow={vi.fn()}
        onLater={vi.fn()}
      />
    );
    expect(markup).toContain("Update available");
    expect(markup).toContain("Download update");
    expect(markup).toContain("Skip");
    expect(markup).toContain("Automatically download updates");
    expect(markup).toContain('data-analytics-id="app_update_download"');
  });

  it("retains install prompt after download completes", () => {
    const markup = renderToStaticMarkup(
      <UpdateReadyOverlay
        status={{ ...availableStatus, kind: "ready", percent: 100 }}
        autoUpdateEnabled={false}
        installing={false}
        error={null}
        onDownload={vi.fn()}
        onAutoUpdateChange={vi.fn()}
        onInstallNow={vi.fn()}
        onLater={vi.fn()}
      />
    );
    expect(markup).toContain("Update ready");
    expect(markup).toContain("Update now");
    expect(markup).toContain("Next launch");
    expect(markup).not.toContain("Automatically download updates");
  });
});
