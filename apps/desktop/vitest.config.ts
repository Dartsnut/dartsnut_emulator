import { defineConfig } from "vitest/config";

/**
 * Tauri cutover test surface. Electron-main tests remain in-tree as historical
 * migration fixtures, but are intentionally excluded from the default desktop
 * suite because `dist-electron` is no longer produced.
 */
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: []
      }
    },
    include: [
      "renderer/AppUpdateOverlay.test.tsx",
      "renderer/AskQuestionCard.test.tsx",
      "renderer/RemoveProjectDialog.test.tsx",
      "renderer/WindowControls.test.tsx",
      "renderer/analytics.test.ts",
      "renderer/chatTitlePolicy.test.ts",
      "renderer/emulatorCapture.test.ts",
      "renderer/emulatorDarts.test.ts",
      "renderer/emulatorProjectUi.test.ts",
      "renderer/rawTimeline.test.ts",
      "renderer/tauriApi.contract.test.ts",
      "renderer/theme.test.ts",
      "renderer/useChatPersonaController.test.ts",
      "renderer/widgetParams.test.ts",
      "appUpdatePreferences.test.ts"
    ],
    exclude: ["node_modules", "src-tauri/**", "rig-spike/**"]
  }
});
