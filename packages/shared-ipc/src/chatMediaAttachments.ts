export type ChatMediaAttachmentKind = "image" | "audio" | "video";

export interface ChatMediaAttachment {
  /** Stable renderer-generated ID. The model sees this ID, not the source path. */
  id: string;
  /** Original absolute path from the renderer drop event, or the copied path when no workspace copy exists yet. */
  path: string;
  /** Workspace-relative copied asset path. When present, prompts should tell the agent to use only this path. */
  workspacePath?: string;
  name: string;
  mimeType: string;
  kind: ChatMediaAttachmentKind;
  size?: number;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".avi", ".m4v"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function inferChatMediaAttachmentKind(mimeType: string, name: string): ChatMediaAttachmentKind | null {
  const normalizedMime = mimeType.toLowerCase();
  if (normalizedMime.startsWith("image/")) {
    return "image";
  }
  if (normalizedMime.startsWith("audio/")) {
    return "audio";
  }
  if (normalizedMime.startsWith("video/")) {
    return "video";
  }

  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return null;
}

export function mergeChatMediaAttachments(
  existing: ChatMediaAttachment[],
  incoming: ChatMediaAttachment[]
): ChatMediaAttachment[] {
  const seen = new Set<string>();
  const out: ChatMediaAttachment[] = [];
  for (const attachment of [...existing, ...incoming]) {
    if (!attachment.path || seen.has(attachment.path)) {
      continue;
    }
    seen.add(attachment.path);
    out.push(attachment);
  }
  return out;
}

function describeAttachment(attachment: ChatMediaAttachment): string {
  const details = [attachment.kind, attachment.mimeType || "unknown MIME"];
  if (typeof attachment.size === "number") {
    details.push(`${attachment.size} bytes`);
  }
  if (attachment.workspacePath) {
    return `- ${attachment.name} (${details.join(", ")}): ${attachment.workspacePath}`;
  }
  return `- ${attachment.name} (${details.join(", ")}), attachment_id: ${attachment.id}`;
}

export function buildPromptWithChatMediaAttachments(
  prompt: string,
  attachments: ChatMediaAttachment[]
): string {
  const trimmed = prompt.trim();
  if (attachments.length === 0) {
    return trimmed;
  }

  const userRequest = trimmed || "Please add the attached media files into the current game or widget.";
  const attachmentLines = attachments.map(describeAttachment).join("\n");
  const allCopiedIntoWorkspace = attachments.every((attachment) => Boolean(attachment.workspacePath));
  const handlingDirective = allCopiedIntoWorkspace
    ? "Use only these workspace-relative paths in code/config."
    : "Copy each attachment with copy_chat_attachment, then use only its returned workspace path in code/config.";
  return `${userRequest}\n\nAttached media files:\n${attachmentLines}\n\n${handlingDirective}`;
}
