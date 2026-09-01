import path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import {
  IPCChannels,
  type AppUpdateCheckResponse,
  type AppUpdateDownloadResponse,
  type AppUpdateStatus
} from "@dartsnut/shared-ipc";
import { devLog } from "./devOnlyLog";
import { readAutoUpdatePreference, writeAutoUpdatePreference } from "./appUpdatePreferences";

type SendToRenderer = (channel: string, ...args: unknown[]) => void;

let latestStatus: AppUpdateStatus = {
  kind: "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: null,
  message: null
};
let updateReady = false;
let started = false;
let downloadInProgress = false;
let checkInProgress = false;
let updateInstallRequested = false;
let rendererSender: SendToRenderer | null = null;

const AUTO_UPDATE_PREFERENCES_FILE = "app-update-preferences.json";

type DevUpdatePreviewMode = "available" | "ready";

function devUpdatePreviewMode(): DevUpdatePreviewMode | null {
  if (app.isPackaged) {
    return null;
  }
  const value = process.env.DARTSNUT_DEV_UPDATE_PREVIEW;
  return value === "available" || value === "ready" ? value : null;
}

function devPreviewVersion(): string {
  return `${app.getVersion()}-dev-preview`;
}

function autoUpdatePreferencesPath(): string {
  return path.join(app.getPath("userData"), AUTO_UPDATE_PREFERENCES_FILE);
}

export function getAutoUpdateEnabled(): boolean {
  return readAutoUpdatePreference(autoUpdatePreferencesPath());
}

export function setAutoUpdateEnabled(enabled: boolean): boolean {
  try {
    writeAutoUpdatePreference(autoUpdatePreferencesPath(), enabled);
  } catch (error) {
    devLog.warn("[updater] Could not persist auto-update preference", error);
  }
  if (started && app.isPackaged) {
    autoUpdater.autoDownload = enabled;
  }
  return enabled;
}

function updateStatus(sendToRenderer: SendToRenderer, patch: Partial<AppUpdateStatus>): void {
  latestStatus = {
    ...latestStatus,
    ...patch,
    currentVersion: app.getVersion()
  };
  sendToRenderer(IPCChannels.appUpdateStatusChanged, latestStatus);
}

export function getAppUpdateStatus(): AppUpdateStatus {
  return latestStatus;
}

export function isDownloadedAppUpdateReady(): boolean {
  return updateReady;
}

export function isAppUpdateInstallRequested(): boolean {
  return updateInstallRequested;
}

export function installDownloadedAppUpdate(): boolean {
  if (!updateReady) {
    return false;
  }
  if (devUpdatePreviewMode()) {
    devLog.info("[updater] Dev preview install requested; skipping relaunch");
    return true;
  }
  updateInstallRequested = true;
  autoUpdater.quitAndInstall(false, true);
  return true;
}

export async function downloadAvailableAppUpdate(): Promise<AppUpdateDownloadResponse> {
  if (devUpdatePreviewMode()) {
    if (latestStatus.kind !== "available" || !latestStatus.availableVersion) {
      return { ok: false, reason: "not_available" };
    }
    updateReady = true;
    if (rendererSender) {
      updateStatus(rendererSender, {
        kind: "ready",
        percent: 100,
        message: "Update ready to install."
      });
    }
    return { ok: true };
  }
  if (updateReady || latestStatus.kind === "ready") {
    return { ok: false, reason: "not_available" };
  }
  if (downloadInProgress || latestStatus.kind === "downloading") {
    return { ok: false, reason: "already_downloading" };
  }
  if (latestStatus.kind !== "available" || !latestStatus.availableVersion) {
    return { ok: false, reason: "not_available" };
  }

  downloadInProgress = true;
  if (rendererSender) {
    updateStatus(rendererSender, {
      kind: "downloading",
      percent: 0,
      message: "Downloading update..."
    });
  }
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    devLog.warn("[updater] Update download failed", message);
    if (rendererSender) {
      updateStatus(rendererSender, {
        kind: "error",
        percent: null,
        message
      });
    }
    return { ok: false, reason: "failed", message };
  } finally {
    downloadInProgress = false;
  }
}

export async function checkForAppUpdate(): Promise<AppUpdateCheckResponse> {
  const previewMode = devUpdatePreviewMode();
  if (previewMode) {
    updateReady = previewMode === "ready";
    if (rendererSender) {
      updateStatus(rendererSender, {
        kind: updateReady ? "ready" : "available",
        availableVersion: devPreviewVersion(),
        percent: updateReady ? 100 : 0,
        message: updateReady ? "Update ready to install." : "Update available (development preview)."
      });
    }
    return { ok: true };
  }
  if (!started || !app.isPackaged || !rendererSender) {
    return { ok: false, reason: "disabled", message: "Updates are disabled in development." };
  }
  if (updateReady || latestStatus.kind === "ready") {
    return { ok: false, reason: "already_ready", message: "Downloaded update is ready to install." };
  }
  if (checkInProgress || latestStatus.kind === "checking") {
    return { ok: false, reason: "already_checking" };
  }

  checkInProgress = true;
  updateStatus(rendererSender, {
    kind: "checking",
    availableVersion: null,
    percent: null,
    message: "Checking for updates..."
  });
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    devLog.warn("[updater] Update check failed", message);
    updateStatus(rendererSender, {
      kind: "error",
      percent: null,
      message
    });
    return { ok: false, reason: "failed", message };
  } finally {
    checkInProgress = false;
  }
}

export function startAppUpdateCheck(sendToRenderer: SendToRenderer): void {
  rendererSender = sendToRenderer;
  if (started) {
    sendToRenderer(IPCChannels.appUpdateStatusChanged, latestStatus);
    return;
  }
  started = true;

  if (!app.isPackaged) {
    const previewMode = devUpdatePreviewMode();
    if (previewMode) {
      updateReady = previewMode === "ready";
      updateStatus(sendToRenderer, {
        kind: updateReady ? "ready" : "available",
        availableVersion: devPreviewVersion(),
        percent: updateReady ? 100 : 0,
        message: updateReady ? "Update ready to install." : "Update available (development preview)."
      });
      return;
    }
    updateStatus(sendToRenderer, {
      kind: "idle",
      availableVersion: null,
      percent: null,
      message: "Updates are disabled in development."
    });
    return;
  }

  autoUpdater.autoDownload = getAutoUpdateEnabled();
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: "https://dartsnutstore.oss-cn-hongkong.aliyuncs.com/agent-update/"
  });
  autoUpdater.logger = {
    info: (message: unknown) => devLog.info("[updater]", message),
    warn: (message: unknown) => devLog.warn("[updater]", message),
    error: (message: unknown) => devLog.error("[updater]", message),
    debug: (message: unknown) => devLog.debug("[updater]", message)
  };

  autoUpdater.on("checking-for-update", () => {
    updateReady = false;
    updateStatus(sendToRenderer, {
      kind: "checking",
      availableVersion: null,
      percent: null,
      message: "Checking for updates..."
    });
  });

  autoUpdater.on("update-not-available", () => {
    updateStatus(sendToRenderer, {
      kind: "not_available",
      availableVersion: null,
      percent: null,
      message: "Dartsnut Agent is up to date."
    });
  });

  autoUpdater.on("update-available", (info) => {
    updateStatus(sendToRenderer, {
      kind: autoUpdater.autoDownload ? "downloading" : "available",
      availableVersion: info.version,
      percent: 0,
      message: autoUpdater.autoDownload ? "Downloading update..." : "Update available."
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    // electron-updater may deliver one final progress event after
    // `update-downloaded`. Keep terminal ready state stable so the renderer
    // does not replace the install prompt with the transient download pill.
    if (updateReady || latestStatus.kind === "ready") {
      return;
    }
    updateStatus(sendToRenderer, {
      kind: "downloading",
      percent: Math.max(0, Math.min(100, progress.percent)),
      message: "Downloading update..."
    });
  });

  autoUpdater.on("update-downloaded", (event) => {
    updateReady = true;
    updateStatus(sendToRenderer, {
      kind: "ready",
      availableVersion: event.version,
      percent: 100,
      message: "Update ready to install."
    });
  });

  autoUpdater.on("error", (error) => {
    devLog.warn("[updater] Update check failed", error);
    updateStatus(sendToRenderer, {
      kind: "error",
      percent: null,
      message: error.message || "Update check failed."
    });
  });

  void checkForAppUpdate();
}
