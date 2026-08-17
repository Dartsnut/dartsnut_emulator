import { describe, expect, it } from "vitest";
import { shouldSetInitialChatTitle } from "./chatTitlePolicy";

describe("initial chat title policy", () => {
  it("allows an existing persona chat to receive its first title", () => {
    expect(shouldSetInitialChatTitle(
      "Build a maze game",
      "chat-1",
      { id: "chat-1", title: "New chat" }
    )).toBe(true);
  });

  it("does not overwrite an existing title", () => {
    expect(shouldSetInitialChatTitle(
      "Change the colors",
      "chat-1",
      { id: "chat-1", title: "Maze game" }
    )).toBe(false);
  });

  it("keeps legacy first-message behavior when no chat exists yet", () => {
    expect(shouldSetInitialChatTitle("Build a timer", undefined, null)).toBe(true);
    expect(shouldSetInitialChatTitle("  ", undefined, null)).toBe(false);
  });
});
