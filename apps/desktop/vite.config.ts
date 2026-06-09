import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve to TS source so Rollup sees named exports (dist CJS uses `__exportStar`, which Vite does not trace). */
const sharedIpcEntry = path.resolve(__dirname, "../../packages/shared-ipc/src/index.ts");
const emulatorProtocolEntry = path.resolve(__dirname, "../../packages/emulator-protocol/src/index.ts");

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@dartsnut/shared-ipc": sharedIpcEntry,
      "@dartsnut/emulator-protocol": emulatorProtocolEntry
    }
  }
});
