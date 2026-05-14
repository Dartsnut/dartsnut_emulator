import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/providerClient";
import {
  AgentSessionPersistence,
  readJsonlRecords,
  resolveAgentSessionDir
} from "../src/agentSessionPersistence";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agent-session-"));
}

afterEach(() => {
  // temp dirs are unique per test; no global cleanup required
});

describe("resolveAgentSessionDir", () => {
  it("places session dir under workspace", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    expect(resolveAgentSessionDir(root)).toBe(path.join(root, ".dartsnut", "agent-session"));
  });
});

describe("AgentSessionPersistence", () => {
  it("writes manifest atomically and reads it back", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    p.writeManifestAtomic({
      schemaVersion: 1,
      sessionId: "s1",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
      templateMode: "widget-creator",
      section: "creation-intake"
    });
    const m = p.readManifest();
    expect(m?.sessionId).toBe("s1");
    expect(m?.templateMode).toBe("widget-creator");
  });

  it("appendTransaction writes one JSON object per line", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    p.appendTransaction({ type: "test", at: 1, x: "a" });
    p.appendTransaction({ type: "test", at: 2, x: "b" });
    const txPath = path.join(resolveAgentSessionDir(root), "transactions.jsonl");
    const raw = fs.readFileSync(txPath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: "test", at: 1, x: "a" });
  });

  it("readJsonlRecords skips malformed tail line", () => {
    const dir = mkTmp();
    const f = path.join(dir, "x.jsonl");
    fs.writeFileSync(f, '{"ok":true}\n{"broken":', "utf-8");
    const rows = readJsonlRecords(f);
    expect(rows).toEqual([{ ok: true }]);
  });

  it("saveConversationAtomic round-trips ChatMessage array", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ];
    p.saveConversationAtomic(messages);
    const back = p.readConversation();
    expect(back).toEqual(messages);
  });

  it("archiveOrResetSession moves files into archives", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    p.writeManifestAtomic({
      schemaVersion: 1,
      sessionId: "old",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z"
    });
    p.archiveOrResetSession("test-archive");
    expect(p.readManifest()).toBeNull();
    const archives = fs.readdirSync(path.join(resolveAgentSessionDir(root), "archives"));
    expect(archives.length).toBe(1);
    const archivedDir = path.join(resolveAgentSessionDir(root), "archives", archives[0]!);
    expect(fs.existsSync(path.join(archivedDir, "manifest.json"))).toBe(true);
  });
});
