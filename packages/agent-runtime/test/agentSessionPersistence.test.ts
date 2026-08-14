import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInputItem } from "@openai/agents";
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
      section: "build"
    });
    const m = p.readManifest();
    expect(m?.sessionId).toBe("s1");
    expect(m?.templateMode).toBe("widget-creator");
  });

  it("appendTransaction writes one JSON object per line", async () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    p.appendTransaction({ type: "test", at: 1, x: "a" });
    p.appendTransaction({ type: "test", at: 2, x: "b" });
    await p.flushWrites();
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

  it("saveConversationItemsAtomic round-trips native AgentInputItem array", async () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    const items: AgentInputItem[] = [
      { type: "message", role: "user", content: "hi" },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] }
    ];
    p.saveConversationItemsAtomic(items);
    await p.flushWrites();
    const back = p.readConversationItems();
    expect(back).toEqual(items);
  });

  it("persists model chain IDs only for matching provider scope", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.writeModelChainResponseIdAtomic("provider-a", "resp_1");
    expect(p.readModelChainResponseId("provider-a")).toBe("resp_1");
    expect(p.readModelChainResponseId("provider-b")).toBeNull();
    expect(p.readModelChainResponseId("provider-a")).toBeNull();
  });

  it("deletes incompatible active session files but preserves workspace and archives", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    const sessionDir = resolveAgentSessionDir(root);
    const archiveDir = path.join(sessionDir, "archives", "old");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(root, "main.py"), "print('keep')\n", "utf-8");
    fs.writeFileSync(path.join(archiveDir, "manifest.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(sessionDir, "manifest.json"), "{}", "utf-8");
    fs.writeFileSync(path.join(sessionDir, "conversation.json"), JSON.stringify({ schemaVersion: 1, messages: [] }), "utf-8");

    expect(p.readConversationItems()).toEqual([]);
    expect(fs.existsSync(path.join(sessionDir, "manifest.json"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "conversation.json"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "main.py"), "utf-8")).toBe("print('keep')\n");
    expect(fs.existsSync(path.join(archiveDir, "manifest.json"))).toBe(true);
  });

  it("readTranscriptTail returns only the last lines without reading from line 0", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    const target = path.join(resolveAgentSessionDir(root), "transcript.jsonl");
    const head = JSON.stringify({ kind: "user", at: 1, text: "head" });
    const tail = JSON.stringify({ kind: "assistant", at: 2, text: "tail" });
    fs.writeFileSync(target, `${head}\n${tail}\n`, "utf-8");
    const lines = p.readTranscriptTail(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("tail");
  });

  it("appendTranscript persists via async queue", async () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.ensureDir();
    p.appendTranscript({ kind: "user", at: 1, text: "hello" });
    await p.flushWrites();
    const tail = p.readTranscriptTail(5);
    expect(tail).toEqual([{ kind: "user", at: 1, text: "hello" }]);
  });

  it("writes and reads token usage atomically", () => {
    const root = path.join(mkTmp(), "ws");
    fs.mkdirSync(root, { recursive: true });
    const p = new AgentSessionPersistence(root);
    p.writeTokenUsageAtomic({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      lastRun: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
    });
    expect(p.readTokenUsage()).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16,
      lastRun: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
    });
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
    p.writeTokenUsageAtomic({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
    p.archiveOrResetSession("test-archive");
    expect(p.readManifest()).toBeNull();
    const archives = fs.readdirSync(path.join(resolveAgentSessionDir(root), "archives"));
    expect(archives.length).toBe(1);
    const archivedDir = path.join(resolveAgentSessionDir(root), "archives", archives[0]!);
    expect(fs.existsSync(path.join(archivedDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(archivedDir, "usage.json"))).toBe(true);
  });
});
