import path from "node:path";
import fs from "node:fs";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  IPCChannels,
  type AgentEvent,
  type BootstrapState,
  type PromptRequest
} from "@dartsnut/shared-ipc";
import {
  loadProviderConfig,
  validateProviderConfig,
  ProviderClient,
  SessionEngine,
  WorkspacePolicy,
  loadSkillBundle
} from "@dartsnut/agent-runtime";

let win: BrowserWindow | null = null;
let workspaceRoot: string | null = null;
let firstRunComplete = false;

const proofStatePath = () => path.join(app.getPath("userData"), "first-run-proof.json");

function readProofState() {
  const file = proofStatePath();
  if (fs.existsSync(file)) {
    const content = JSON.parse(fs.readFileSync(file, "utf-8")) as { complete?: boolean };
    firstRunComplete = Boolean(content.complete);
  }
}

function writeProofState(complete: boolean) {
  fs.mkdirSync(path.dirname(proofStatePath()), { recursive: true });
  fs.writeFileSync(proofStatePath(), JSON.stringify({ complete }, null, 2));
  firstRunComplete = complete;
}

function providerStatus(): BootstrapState["providerStatus"] {
  const validation = validateProviderConfig(loadProviderConfig());
  return validation.ok ? "ready" : "missing_config";
}

function getBootstrapState(): BootstrapState {
  return {
    workspaceRoot,
    providerStatus: providerStatus(),
    firstRunComplete
  };
}

function resolveSkillBundlePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "packages/agent-runtime/skills/dartsnut-skill.md"),
    path.resolve(process.cwd(), "../packages/agent-runtime/skills/dartsnut-skill.md"),
    path.resolve(__dirname, "../../../packages/agent-runtime/skills/dartsnut-skill.md")
  ];
  const existingPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existingPath) {
    throw new Error(`Skill bundle is missing at ${candidates[0]}`);
  }
  return existingPath;
}

function buildSession(): SessionEngine {
  if (!workspaceRoot) {
    throw new Error("Workspace is not selected.");
  }
  const config = loadProviderConfig();
  const validation = validateProviderConfig(config);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  const skillPath = resolveSkillBundlePath();
  const skillPrompt = loadSkillBundle(skillPath);
  return new SessionEngine({
    provider: new ProviderClient(config),
    workspacePolicy: new WorkspacePolicy(workspaceRoot),
    skillPrompt
  });
}

async function createWindow() {
  readProofState();
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

ipcMain.handle(IPCChannels.bootstrapState, () => getBootstrapState());

ipcMain.handle(IPCChannels.pickWorkspace, async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"]
  });
  if (!result.canceled && result.filePaths[0]) {
    workspaceRoot = result.filePaths[0];
  }
  return getBootstrapState();
});

ipcMain.handle(IPCChannels.sendPrompt, async (_event: unknown, req: PromptRequest) => {
  const events: AgentEvent[] = [];
  try {
    const session = buildSession();
    await session.runPrompt(req.prompt, (agentEvent: AgentEvent) => {
      events.push(agentEvent);
      win?.webContents.send(IPCChannels.subscribeEvents, agentEvent);
    });
    if (!firstRunComplete) {
      writeProofState(true);
    }
    return { ok: true, events };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown prompt error";
    const event: AgentEvent = { type: "error", message, at: Date.now() };
    win?.webContents.send(IPCChannels.subscribeEvents, event);
    return { ok: false, events: [event] };
  }
});
