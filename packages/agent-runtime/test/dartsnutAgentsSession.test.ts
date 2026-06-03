import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DartsnutAgentsSession } from "../src/dartsnutAgentsSession";
import { AgentSessionPersistence } from "../src/agentSessionPersistence";
import { chatMessagesToAgentInputItems, agentInputItemsToChatMessages } from "../src/conversationProtocol";
import type { ChatMessage } from "../src/providerClient";

describe("DartsnutAgentsSession", () => {
  it("round-trips conversation through AgentInputItem protocol", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-agents-session-"));
    const persistence = new AgentSessionPersistence(workspace);
    const seed: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: "thinking aloud",
        reasoningContent: "internal reasoning",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"main.py\"}" }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" }
    ];
    const session = new DartsnutAgentsSession({
      sessionId: "sess-1",
      initialConversation: seed,
      sessionPersistence: persistence
    });
    const items = await session.getItems();
    expect(items.length).toBeGreaterThan(0);
    const roundTrip = agentInputItemsToChatMessages(items);
    expect(roundTrip.some((m) => m.role === "user" && m.content === "hello")).toBe(true);
    expect(roundTrip.some((m) => m.role === "tool")).toBe(true);
    await session.addItems(chatMessagesToAgentInputItems([{ role: "user", content: "next turn" }]));
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
});
