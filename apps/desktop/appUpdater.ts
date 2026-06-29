import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { IPCChannels, type AppUpdateStatus } from "@dartsnut/shared-ipc";
import { devLog } from "./devOnlyLog";

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

export function installDownloadedAppUpdate(): void {
  if (!updateReady) {
    return;
  }
  autoUpdater.quitAndInstall(false, true);
}

export function startAppUpdateCheck(sendToRenderer: SendToRenderer): void {
  if (started) {
    sendToRenderer(IPCChannels.appUpdateStatusChanged, latestStatus);
    return;
  }
  started = true;

  if (!app.isPackaged) {
    updateStatus(sendToRenderer, {
      kind: "idle",
      availableVersion: null,
      percent: null,
      message: "Updates are disabled in development."
    });
    return;
  }

  autoUpdater.autoDownload = true;
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
      kind: "downloading",
      availableVersion: info.version,
      percent: 0,
      message: "Downloading update..."
    });
  });

  autoUpdater.on("download-progress", (progress) => {
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

  updateStatus(sendToRenderer, {
    kind: "checking",
    availableVersion: null,
    percent: null,
    message: "Checking for updates..."
  });

  autoUpdater.checkForUpdates().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    devLog.warn("[updater] Update check failed", message);
    updateStatus(sendToRenderer, {
      kind: "error",
      percent: null,
      message
    });
  });
}
