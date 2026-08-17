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
