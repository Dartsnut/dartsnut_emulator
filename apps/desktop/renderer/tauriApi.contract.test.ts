import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined)
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined)
}));

import { createTauriApi } from "./tauriApi";

describe("Tauri bridge command contract", () => {
  it("exposes every renderer operation from shared IPC and emulator contracts", () => {
    const api = createTauriApi();
    const expectedTopLevel = [
      "health", "bridgeReady", "emitBridgeEvent", "onBridgeReady", "onBridgeEvent",
      "rendererReady", "reportRendererError", "openStartupLogs", "copyStartupDiagnostics",
      "resetRendererState", "restartWithoutGpu", "getBootstrapState", "getWorkspaceSessionSummary",
      "resetWorkspaceSession", "listProjects", "createProject", "removeProject", "selectProject",
      "createChat", "archiveChat", "generateChatTitle", "selectChat", "onProjectSwitchProgress",
      "getWindowChromeInsets", "getAppUpdateStatus", "installAppUpdateNow", "getAppUpdateAutoDownload",
      "setAppUpdateAutoDownload", "downloadAppUpdate", "checkAppUpdate", "setShellUiTheme",
      "pickWorkspace", "machineMcpSubmitQuestionAnswer", "agentQuestionSubmitAnswer", "sendPrompt",
      "cancelAgent", "getProviderSettings", "getPythonRuntimeStatus", "getPythonRuntimeProgress",
      "saveProviderSettings", "onAgentEvent", "onMainProcessConsoleMirror", "onWindowChromeInsets",
      "onAppUpdateStatus", "onSessionReset", "onBootstrapStateChanged", "onPythonRuntimeStatus",
      "onPythonRuntimeProgress", "sendEmulatorCommand", "pickWidgetPath", "getLastWidgetPath",
      "getEmulatorBackground", "openCaptureFolder", "onEmulatorState", "onEmulatorFrame", "onEmulatorLog",
      "onEmulatorLogsClear", "getWidgetConfig", "onWidgetConfig", "deployGetEligibility",
      "onDeployEligibility", "deployConnect", "onDeployConnectionChanged", "deployDisconnect", "deployRun",
      "deployReload", "deployApplyWidgetParams", "deployStop", "deployOpenLocalNetworkSettings", "onDeployLog",
      "onDeployFrame", "communityGetSession", "communityLogin", "communitySetPassword",
      "communityCancelGoogleLogin", "communityLogout", "communityGetLlmQuota", "communityListDeployDevices",
      "communityListMyGames", "communityGetPublishOptions", "communityListAppVersions", "communityCreateApp",
      "communityUploadNativeImage", "communitySubmitAppVersion", "communityUpdateWorkspaceVersion",
      "onCommunitySubmitProgress", "communityWithdrawAppVersion", "assets"
    ];
    expect(Object.keys(api).sort()).toEqual(expectedTopLevel.sort());
    expect(Object.keys(api.assets).sort()).toEqual([
      "getManifest", "onManifest", "bindSlot", "unbindSlot", "applyAssets", "readPreview",
      "pickSourceFile", "getPathForFile"
    ].sort());
  });
});
