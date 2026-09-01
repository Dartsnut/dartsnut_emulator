import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (payload?: any) => void>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
    on: vi.fn((event: string, handler: (payload?: any) => void) => {
      handlers.set(event, handler);
      return updater;
    }),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn()
  };
  return {
    handlers,
    updater,
    app: {
      isPackaged: true,
      getVersion: () => "1.5.4",
      getPath: () => ""
    }
  };
});

vi.mock("electron", () => ({ app: mocks.app }));
vi.mock("electron-updater", () => ({ autoUpdater: mocks.updater }));
vi.mock("./devOnlyLog", () => ({
  devLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

async function loadUpdater(preference: boolean | null = null, packaged = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-updater-"));
  mocks.app.getPath = () => root;
  mocks.app.isPackaged = packaged;
  mocks.handlers.clear();
  mocks.updater.autoDownload = false;
  mocks.updater.autoInstallOnAppQuit = false;
  mocks.updater.on.mockClear();
  mocks.updater.setFeedURL.mockClear();
  mocks.updater.checkForUpdates.mockClear();
  mocks.updater.downloadUpdate.mockClear();
  mocks.updater.quitAndInstall.mockClear();
  if (preference !== null) {
    fs.writeFileSync(path.join(root, "app-update-preferences.json"), JSON.stringify({ autoDownload: preference }));
  }
  vi.resetModules();
  return import("./appUpdater");
}

describe("app updater", () => {
  it("checks without downloading by default and downloads only on request", async () => {
    const updater = await loadUpdater();
    const sent: any[] = [];
    updater.startAppUpdateCheck((_channel, status) => sent.push(status));
    expect(mocks.updater.autoDownload).toBe(false);
    expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();

    mocks.handlers.get("update-available")?.({ version: "1.5.5" });
    expect(updater.getAppUpdateStatus().kind).toBe("available");
    expect((await updater.downloadAvailableAppUpdate()).ok).toBe(true);
    expect(mocks.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(sent.some((status) => status.kind === "downloading")).toBe(true);

    mocks.handlers.get("update-downloaded")?.({ version: "1.5.5" });
    expect(updater.getAppUpdateStatus().kind).toBe("ready");

    // A trailing progress event must not hide the install prompt.
    mocks.handlers.get("download-progress")?.({ percent: 99.4 });
    expect(updater.getAppUpdateStatus()).toMatchObject({ kind: "ready", percent: 100 });
    expect(updater.installDownloadedAppUpdate()).toBe(true);
    expect(updater.isAppUpdateInstallRequested()).toBe(true);
    expect(mocks.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("retains automatic downloads when preference is enabled", async () => {
    const updater = await loadUpdater(true);
    updater.startAppUpdateCheck(() => undefined);
    expect(mocks.updater.autoDownload).toBe(true);
    mocks.handlers.get("update-available")?.({ version: "1.5.5" });
    expect(updater.getAppUpdateStatus().kind).toBe("downloading");
  });

  it("allows a manual update check after the startup check completes", async () => {
    const updater = await loadUpdater();
    updater.startAppUpdateCheck(() => undefined);
    await vi.waitFor(() => expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(1));
    mocks.handlers.get("update-not-available")?.();
    expect((await updater.checkForAppUpdate()).ok).toBe(true);
    expect(mocks.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it("supports an available development preview without touching the real updater", async () => {
    const previousPreview = process.env.DARTSNUT_DEV_UPDATE_PREVIEW;
    process.env.DARTSNUT_DEV_UPDATE_PREVIEW = "available";
    try {
      const updater = await loadUpdater(null, false);
      updater.startAppUpdateCheck(() => undefined);
      expect(updater.getAppUpdateStatus().kind).toBe("available");
      expect((await updater.downloadAvailableAppUpdate()).ok).toBe(true);
      expect(updater.getAppUpdateStatus().kind).toBe("ready");
      expect(mocks.updater.downloadUpdate).not.toHaveBeenCalled();
      updater.installDownloadedAppUpdate();
      expect(mocks.updater.quitAndInstall).not.toHaveBeenCalled();
    } finally {
      if (previousPreview === undefined) {
        delete process.env.DARTSNUT_DEV_UPDATE_PREVIEW;
      } else {
        process.env.DARTSNUT_DEV_UPDATE_PREVIEW = previousPreview;
      }
      mocks.app.isPackaged = true;
    }
  });
});
