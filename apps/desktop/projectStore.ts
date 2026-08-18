import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentSessionPersistence, resolveAgentSessionDir } from "@dartsnut/agent-runtime";

export type ProjectRecord = {
  id: string;
  name: string;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  migrationComplete?: boolean;
};

export type ChatRecord = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

type StoreFile = {
  schemaVersion: 1;
  projects: ProjectRecord[];
  chats: ChatRecord[];
  lastOpenedChatId?: string | null;
};

function now(): string { return new Date().toISOString(); }
function atomicWrite(file: string, body: string): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, body, "utf8");
  fs.renameSync(tmp, file);
}

export class ProjectStore {
  private readonly root: string;
  private readonly file: string;
  private data: StoreFile = { schemaVersion: 1, projects: [], chats: [] };

  constructor(userDataPath: string) {
    this.root = path.join(userDataPath, "projects");
    this.file = path.join(this.root, "projects.json");
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as StoreFile;
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.projects) && Array.isArray(parsed.chats)) this.data = parsed;
    } catch { /* first run */ }
  }
  private save(): void { atomicWrite(this.file, `${JSON.stringify(this.data, null, 2)}\n`); }
  private chatDir(id: string): string {
    const chatsRoot = path.resolve(this.root, "chats");
    const directory = path.resolve(chatsRoot, id);
    const relative = path.relative(chatsRoot, directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Chat cache path is outside the app cache directory.");
    }
    return directory;
  }

  list(): { projects: ProjectRecord[]; chats: ChatRecord[] } {
    return { projects: [...this.data.projects].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)), chats: this.data.chats.filter((chat) => !chat.archivedAt) };
  }
  getProject(id: string): ProjectRecord | null { return this.data.projects.find((p) => p.id === id) ?? null; }
  getChat(id: string): ChatRecord | null { return this.data.chats.find((c) => c.id === id) ?? null; }
  lastOpenedChat(): ChatRecord | null {
    const explicit = this.data.lastOpenedChatId ? this.getChat(this.data.lastOpenedChatId) : null;
    if (explicit && !explicit.archivedAt) return explicit;
    return this.data.chats.filter((chat) => !chat.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
  }
  markChatOpened(chatId: string): ChatRecord | null {
    const chat = this.getChat(chatId);
    if (!chat || chat.archivedAt) return null;
    chat.updatedAt = now();
    this.data.lastOpenedChatId = chat.id;
    this.save();
    return chat;
  }
  ensureProject(folderPath: string, name?: string): ProjectRecord {
    const folder = path.resolve(folderPath);
    const existing = this.data.projects.find((p) => path.resolve(p.folderPath) === folder);
    if (existing) return existing;
    const stamp = now();
    const project: ProjectRecord = { id: randomUUID(), name: name?.trim() || path.basename(folder) || folder, folderPath: folder, createdAt: stamp, updatedAt: stamp, lastOpenedAt: stamp };
    this.data.projects.push(project); this.save(); return project;
  }
  touchProject(id: string): ProjectRecord | null { const p = this.getProject(id); if (!p) return null; const stamp = now(); p.lastOpenedAt = stamp; p.updatedAt = stamp; this.save(); return p; }
  removeProject(projectId: string): ProjectRecord | null {
    const project = this.getProject(projectId);
    if (!project) return null;
    const removedChats = this.data.chats.filter((chat) => chat.projectId === projectId);
    const cacheDirectories = removedChats.map((chat) => this.chatDir(chat.id));
    for (const directory of cacheDirectories) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    const removedChatIds = new Set(removedChats.map((chat) => chat.id));
    const nextData: StoreFile = {
      ...this.data,
      projects: this.data.projects.filter((candidate) => candidate.id !== projectId),
      chats: this.data.chats.filter((chat) => chat.projectId !== projectId),
      lastOpenedChatId:
        this.data.lastOpenedChatId && removedChatIds.has(this.data.lastOpenedChatId)
          ? null
          : this.data.lastOpenedChatId
    };
    atomicWrite(this.file, `${JSON.stringify(nextData, null, 2)}\n`);
    this.data = nextData;
    return project;
  }
  createChat(projectId: string, title = "New chat"): ChatRecord {
    if (!this.getProject(projectId)) throw new Error("Project does not exist.");
    const stamp = now(); const chat: ChatRecord = { id: randomUUID(), projectId, title, createdAt: stamp, updatedAt: stamp };
    this.data.chats.push(chat); fs.mkdirSync(this.chatDir(chat.id), { recursive: true }); this.save(); return chat;
  }
  chatsForProject(projectId: string): ChatRecord[] { return this.data.chats.filter((c) => c.projectId === projectId && !c.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  sessionPersistence(chatId: string): AgentSessionPersistence { return new AgentSessionPersistence(this.chatDir(chatId)); }
  updateChatTitle(chatId: string, title: string): void { const c = this.getChat(chatId); if (!c) return; c.title = title.trim().slice(0, 80) || "New chat"; c.updatedAt = now(); this.save(); }
  updateDefaultChatTitle(chatId: string, title: string): ChatRecord | null {
    const chat = this.getChat(chatId);
    if (!chat || chat.archivedAt || chat.title !== "New chat") return null;
    chat.title = title.trim().slice(0, 80) || "New chat"; chat.updatedAt = now(); this.save(); return chat;
  }
  archiveChat(chatId: string): ChatRecord | null {
    const chat = this.getChat(chatId);
    if (!chat) return null;
    if (chat.archivedAt) return chat;
    const stamp = now(); chat.archivedAt = stamp; chat.updatedAt = stamp;
    if (this.data.lastOpenedChatId === chat.id) this.data.lastOpenedChatId = null;
    this.save(); return chat;
  }

  migrateLegacy(project: ProjectRecord): void {
    if (project.migrationComplete) return;
    const legacy = resolveAgentSessionDir(project.folderPath);
    if (!fs.existsSync(legacy)) { project.migrationComplete = true; this.save(); return; }
    const files = ["manifest.json", "transcript.jsonl", "transactions.jsonl", "conversation.json", "model-chain.json", "usage.json"];
    const chatId = (() => { try { const m = JSON.parse(fs.readFileSync(path.join(legacy, "manifest.json"), "utf8")) as { sessionId?: string }; return m.sessionId || randomUUID(); } catch { return randomUUID(); } })();
    let chat = this.getChat(chatId);
    if (!chat) { const stamp = now(); chat = { id: chatId, projectId: project.id, title: "Migrated chat", createdAt: stamp, updatedAt: stamp }; this.data.chats.push(chat); }
    const target = this.chatDir(chat.id); fs.mkdirSync(target, { recursive: true });
    for (const file of files) { const src = path.join(legacy, file); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, file)); }
    if (!fs.existsSync(path.join(target, "manifest.json"))) throw new Error("Legacy session manifest missing after migration.");
    for (const file of files) { const src = path.join(legacy, file); if (fs.existsSync(src)) fs.rmSync(src); }
    try { fs.rmdirSync(legacy); fs.rmdirSync(path.dirname(legacy)); } catch { /* non-empty or unrelated files */ }
    project.migrationComplete = true; project.updatedAt = now(); this.save();
  }
}
