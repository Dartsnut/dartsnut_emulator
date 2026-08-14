import { describe, expect, it } from "vitest";
import {
  buildPromptWithChatMediaAttachments,
  inferChatMediaAttachmentKind,
  mergeChatMediaAttachments,
  type ChatMediaAttachment
} from "../src/chatMediaAttachments";

describe("inferChatMediaAttachmentKind", () => {
  it("recognizes image, audio, and video files from MIME types and file names", () => {
    expect(inferChatMediaAttachmentKind("image/png", "sprite.bin")).toBe("image");
    expect(inferChatMediaAttachmentKind("", "voice.ogg")).toBe("audio");
    expect(inferChatMediaAttachmentKind("video/quicktime", "clip")).toBe("video");
    expect(inferChatMediaAttachmentKind("application/pdf", "notes.pdf")).toBeNull();
  });
});

describe("mergeChatMediaAttachments", () => {
  it("keeps first-seen order and deduplicates by path", () => {
    const existing: ChatMediaAttachment[] = [
      { id: "a", path: "/tmp/sprite.png", name: "sprite.png", mimeType: "image/png", kind: "image", size: 123 }
    ];
    const merged = mergeChatMediaAttachments(existing, [
      { id: "b", path: "/tmp/sprite.png", name: "sprite-copy.png", mimeType: "image/png", kind: "image", size: 123 },
      { id: "c", path: "/tmp/hit.wav", name: "hit.wav", mimeType: "audio/wav", kind: "audio", size: 456 }
    ]);

    expect(merged).toEqual([
      { id: "a", path: "/tmp/sprite.png", name: "sprite.png", mimeType: "image/png", kind: "image", size: 123 },
      { id: "c", path: "/tmp/hit.wav", name: "hit.wav", mimeType: "audio/wav", kind: "audio", size: 456 }
    ]);
  });
});

describe("buildPromptWithChatMediaAttachments", () => {
  it("preserves the user prompt and appends explicit local media paths", () => {
    const prompt = buildPromptWithChatMediaAttachments("Use these as the boss assets.", [
      { id: "chat-1", path: "/Users/me/boss.png", name: "boss.png", mimeType: "image/png", kind: "image", size: 2048 },
      { id: "chat-2", path: "/Users/me/roar.mp3", name: "roar.mp3", mimeType: "", kind: "audio" }
    ]);

    expect(prompt).toContain("Use these as the boss assets.");
    expect(prompt).toContain("Attached media files:");
    expect(prompt).toContain("boss.png");
    expect(prompt).toContain("attachment_id: chat-1");
    expect(prompt).not.toContain("/Users/me/boss.png");
    expect(prompt).toContain("roar.mp3");
    expect(prompt).toContain("copy_chat_attachment");
  });

  it("uses a default request when only media files are submitted", () => {
    const prompt = buildPromptWithChatMediaAttachments("   ", [
      { id: "chat-3", path: "/Users/me/bg.webm", name: "bg.webm", mimeType: "video/webm", kind: "video" }
    ]);

    expect(prompt).toContain("Please add the attached media files into the current game or widget.");
    expect(prompt).toContain("attachment_id: chat-3");
    expect(prompt).not.toContain("/Users/me/bg.webm");
  });

  it("prefers copied workspace paths and hides original source paths", () => {
    const prompt = buildPromptWithChatMediaAttachments("Use this as the title art.", [
      {
        id: "chat-4",
        path: "/Volumes/drive/Downloads/title.png",
        workspacePath: "assets/chat/title.png",
        name: "title.png",
        mimeType: "image/png",
        kind: "image"
      }
    ]);

    expect(prompt).toContain("assets/chat/title.png");
    expect(prompt).not.toContain("/Volumes/drive/Downloads/title.png");
    expect(prompt).toContain("Use only these workspace-relative paths");
  });
});
