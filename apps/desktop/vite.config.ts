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
  envDir: path.resolve(__dirname, "../.."),
  server: {
    // Cargo rewrites and locks Windows DLLs while compiling. Vite does not need
    // to watch Rust build artifacts (Tauri watches the Rust sources itself).
    watch: {
      ignored: ["**/src-tauri/target/**", "**/rig-spike/target/**"]
    }
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "desktop-file-origin-assets",
      transformIndexHtml(html) {
        // Electron loads packaged assets from file://; crossorigin on local module assets
        // can turn a valid file into an opaque CORS request in WebKit/Electron.
        return html.replace(/\s+crossorigin(?:="[^"]*")?/g, "");
      }
    }
  ],
  resolve: {
    alias: {
      "@dartsnut/shared-ipc": sharedIpcEntry,
      "@dartsnut/emulator-protocol": emulatorProtocolEntry
    }
  }
});
