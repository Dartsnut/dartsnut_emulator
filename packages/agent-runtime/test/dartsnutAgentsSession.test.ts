import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInputItem } from "@openai/agents";
import { DartsnutAgentsSession } from "../src/dartsnutAgentsSession";
import { AgentSessionPersistence } from "../src/agentSessionPersistence";
import { resolveSessionUserLocale } from "@dartsnut/shared-ipc";

describe("DartsnutAgentsSession", () => {
  it("round-trips native AgentInputItem conversation", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-session-"));
    const persistence = new AgentSessionPersistence(workspace);
    const seed: AgentInputItem[] = [
      { type: "message", role: "user", content: "hello" },
      {
        type: "function_call",
        callId: "call_1",
        name: "read_file",
        arguments: "{\"path\":\"main.py\"}",
        status: "completed"
      },
      { type: "function_call_result", name: "read_file", callId: "call_1", status: "completed", output: "{\"ok\":true}" }
    ];
    const session = new DartsnutAgentsSession({
      sessionId: "sess-1",
      initialItems: seed,
      sessionPersistence: persistence
    });
    const items = await session.getItems();
    expect(items).toEqual(seed);
    await session.addItems([{ type: "message", role: "user", content: "next turn" }]);
    await persistence.flushWrites();
    const reloaded = new DartsnutAgentsSession({
      sessionId: "sess-1",
      sessionPersistence: persistence
    });
    const persisted = await reloaded.getItems();
    const hasNextTurn = persisted.some(
      (item) =>
        item.type === "message" &&
        item.role === "user" &&
        (typeof item.content === "string" ? item.content === "next turn" : false)
    );
    expect(hasNextTurn).toBe(true);
  });

  it("persists resolved locale so short follow-ups can reuse it", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-session-locale-"));
    const persistence = new AgentSessionPersistence(workspace);
    const firstLocale = resolveSessionUserLocale(null, "我想要一个时钟小组件");
    const session = new DartsnutAgentsSession({
      sessionId: "sess-locale",
      sessionPersistence: persistence,
      preferredUserLocale: firstLocale
    });

    await session.addItems([{ type: "message", role: "user", content: "我想要一个时钟小组件" }]);
    await persistence.flushWrites();

    expect(persistence.readManifest()?.preferredUserLocale).toBe("zh-Hans");
    const followUpLocale = resolveSessionUserLocale(
      persistence.readManifest()?.preferredUserLocale ?? null,
      "ok"
    );
    expect(followUpLocale).toBe("zh-Hans");
  });
});
