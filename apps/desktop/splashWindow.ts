import { BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs";

let splashWindow: BrowserWindow | null = null;

export function createSplashWindow(logoPath?: string): BrowserWindow {
  // Read logo and convert to base64 if provided
  let logoDataUri = "";
  if (logoPath && fs.existsSync(logoPath)) {
    const logoBuffer = fs.readFileSync(logoPath);
    const base64 = logoBuffer.toString("base64");
    const ext = path.extname(logoPath).slice(1);
    logoDataUri = `data:image/${ext};base64,${base64}`;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      background: #121212;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-user-select: none;
      user-select: none;
    }
    #logo {
      width: 120px;
      height: 120px;
      margin-bottom: 24px;
      ${logoDataUri ? `background-image: url('${logoDataUri}');` : ""}
      background-size: contain;
      background-repeat: no-repeat;
      background-position: center;
    }
    h1 {
      color: #ffffff;
      font-size: 18px;
      font-weight: 500;
      margin: 0 0 16px;
    }
    #progress-container {
      width: 300px;
      margin-bottom: 12px;
    }
    #progress-bar {
      width: 100%;
      height: 8px;
      background: #333333;
      border-radius: 4px;
      overflow: hidden;
    }
    #progress-fill {
      width: 0%;
      height: 100%;
      background: linear-gradient(90deg, #4a90e2 0%, #5ba3f5 100%);
      border-radius: 4px;
      transition: width 0.3s ease-out;
    }
    #status {
      color: #888888;
      font-size: 14px;
      margin-top: 12px;
      text-align: center;
      min-height: 20px;
    }
  </style>
</head>
<body>
  <div id="logo"></div>
  <h1>DartsnutChat</h1>
  <div id="progress-container">
    <div id="progress-bar">
      <div id="progress-fill"></div>
    </div>
  </div>
  <p id="status">Initializing...</p>
</body>
</html>
  `;

  splashWindow = new BrowserWindow({
    width: 500,
    height: 300,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: "#121212",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  splashWindow.on("closed", () => {
    splashWindow = null;
  });

  return splashWindow;
}

export function updateSplashProgress(stage: string, percent: number, message: string): void {
  if (!splashWindow || splashWindow.isDestroyed()) {
    return;
  }

  const script = `
    (function() {
      const fill = document.getElementById('progress-fill');
      const status = document.getElementById('status');
      if (fill) fill.style.width = '${Math.min(100, Math.max(0, percent))}%';
      if (status) status.textContent = ${JSON.stringify(message)};
    })();
  `;

  splashWindow.webContents.executeJavaScript(script).catch(() => {
    // Ignore errors if window closed during update
  });
}

export function closeSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}
