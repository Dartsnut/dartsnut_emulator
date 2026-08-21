import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectStore } from "./projectStore";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-project-store-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ProjectStore lazy chat persistence", () => {
  it("does not create chat metadata or history until createChat is called", () => {
    const userDataPath = makeTemporaryRoot();
    const projectFolder = path.join(makeTemporaryRoot(), "game");
    fs.mkdirSync(projectFolder);
    const store = new ProjectStore(userDataPath);

    const project = store.ensureProject(projectFolder, "Game");

    expect(store.list().chats).toEqual([]);
    expect(fs.existsSync(path.join(userDataPath, "projects", "chats"))).toBe(false);

    const chat = store.createChat(project.id);

    expect(store.list().chats).toEqual([chat]);
    expect(fs.existsSync(path.join(userDataPath, "projects", "chats", chat.id))).toBe(true);
  });

  it("hides archived chats without deleting their history", () => {
    const userDataPath = makeTemporaryRoot();
    const projectFolder = path.join(makeTemporaryRoot(), "game");
    fs.mkdirSync(projectFolder);
    const store = new ProjectStore(userDataPath);
    const project = store.ensureProject(projectFolder, "Game");
    const chat = store.createChat(project.id);
    store.markChatOpened(chat.id);

    const archived = store.archiveChat(chat.id);

    expect(archived?.archivedAt).toBeTruthy();
    expect(store.list().chats).toEqual([]);
    expect(store.chatsForProject(project.id)).toEqual([]);
    expect(store.lastOpenedChat()).toBeNull();
    expect(fs.existsSync(path.join(userDataPath, "projects", "chats", chat.id))).toBe(true);
    expect(store.archiveChat(chat.id)?.archivedAt).toBe(archived?.archivedAt);
  });

  it("stores a new chat persona before any transcript exists", () => {
    const userDataPath = makeTemporaryRoot();
    const projectFolder = path.join(makeTemporaryRoot(), "game");
    fs.mkdirSync(projectFolder);
    const store = new ProjectStore(userDataPath);
    const project = store.ensureProject(projectFolder, "Game");
    const chat = store.createChat(project.id);

    store.sessionPersistence(chat.id).setAgentProfileId("teen-builder");

    expect(store.sessionPersistence(chat.id).readAgentProfileId()).toBe("teen-builder");
    expect(store.sessionPersistence(chat.id).readTranscriptTail(10)).toEqual([]);
  });

  it("only replaces a default title on an unarchived chat", () => {
    const store = new ProjectStore(makeTemporaryRoot());
    const project = store.ensureProject(makeTemporaryRoot(), "Game");
    const generated = store.createChat(project.id);
    const renamed = store.createChat(project.id, "Custom title");
    const archived = store.createChat(project.id);
    store.archiveChat(archived.id);

    expect(store.updateDefaultChatTitle(generated.id, "Generated title")?.title).toBe("Generated title");
    expect(store.updateDefaultChatTitle(renamed.id, "Overwrite")).toBeNull();
    expect(store.updateDefaultChatTitle(archived.id, "Overwrite")).toBeNull();
  });
});

describe("ProjectStore project removal", () => {
  it("removes project metadata and every chat cache without touching source files", () => {
    const userDataPath = makeTemporaryRoot();
    const projectFolder = path.join(makeTemporaryRoot(), "game");
    const sourceFile = path.join(projectFolder, "main.py");
    fs.mkdirSync(projectFolder);
    fs.writeFileSync(sourceFile, "print('still here')\n");
    const store = new ProjectStore(userDataPath);
    const project = store.ensureProject(projectFolder, "Game");
    const activeChat = store.createChat(project.id, "Active chat");
    const archivedChat = store.createChat(project.id, "Archived chat");
    store.markChatOpened(activeChat.id);
    store.archiveChat(archivedChat.id);
    fs.writeFileSync(path.join(userDataPath, "projects", "chats", activeChat.id, "transcript.jsonl"), "active\n");
    fs.writeFileSync(path.join(userDataPath, "projects", "chats", archivedChat.id, "transcript.jsonl"), "archived\n");

    expect(store.removeProject(project.id)).toEqual(project);

    expect(store.getProject(project.id)).toBeNull();
    expect(store.getChat(activeChat.id)).toBeNull();
    expect(store.getChat(archivedChat.id)).toBeNull();
    expect(fs.existsSync(path.join(userDataPath, "projects", "chats", activeChat.id))).toBe(false);
    expect(fs.existsSync(path.join(userDataPath, "projects", "chats", archivedChat.id))).toBe(false);
    expect(fs.readFileSync(sourceFile, "utf8")).toBe("print('still here')\n");
    const persisted = JSON.parse(
      fs.readFileSync(path.join(userDataPath, "projects", "projects.json"), "utf8")
    ) as { projects: unknown[]; chats: unknown[]; lastOpenedChatId?: string | null };
    expect(persisted.projects).toEqual([]);
    expect(persisted.chats).toEqual([]);
    expect(persisted.lastOpenedChatId).toBeNull();
  });

  it("leaves the store unchanged when the project does not exist", () => {
    const userDataPath = makeTemporaryRoot();
    const store = new ProjectStore(userDataPath);
    const project = store.ensureProject(makeTemporaryRoot(), "Game");
    const storeFile = path.join(userDataPath, "projects", "projects.json");
    const before = fs.readFileSync(storeFile, "utf8");

    expect(store.removeProject("missing-project")).toBeNull();
    expect(store.getProject(project.id)).toEqual(project);
    expect(fs.readFileSync(storeFile, "utf8")).toBe(before);
  });

  it("refuses chat cache paths outside the app cache root", () => {
    const userDataPath = makeTemporaryRoot();
    const sourceFolder = makeTemporaryRoot();
    const outsideCache = path.join(userDataPath, "outside-cache");
    const sentinel = path.join(outsideCache, "sentinel.txt");
    fs.mkdirSync(outsideCache);
    fs.writeFileSync(sentinel, "keep\n");
    const projectsRoot = path.join(userDataPath, "projects");
    fs.mkdirSync(projectsRoot);
    fs.writeFileSync(path.join(projectsRoot, "projects.json"), JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: "project-1", name: "Game", folderPath: sourceFolder, createdAt: "1", updatedAt: "1", lastOpenedAt: "1" }],
      chats: [{ id: "../../outside-cache", projectId: "project-1", title: "Unsafe", createdAt: "1", updatedAt: "1" }],
      lastOpenedChatId: "../../outside-cache"
    }));
    const store = new ProjectStore(userDataPath);

    expect(() => store.removeProject("project-1")).toThrow("outside the app cache directory");
    expect(store.getProject("project-1")).not.toBeNull();
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep\n");
  });
});
