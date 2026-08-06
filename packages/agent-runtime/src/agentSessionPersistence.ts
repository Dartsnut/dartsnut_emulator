import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentInputItem } from "@openai/agents";
import type { AgentSessionTokenUsage } from "@dartsnut/shared-ipc";
import { normalizeTokenUsage } from "./tokenUsage";

export const AGENT_SESSION_SCHEMA_VERSION = 1;
export const AGENT_CONVERSATION_SCHEMA_VERSION = 2;
const ACTIVE_SESSION_FILES = [
  "manifest.json",
  "transcript.jsonl",
  "transactions.jsonl",
  "conversation.json",
  "model-chain.json",
  "usage.json"
] as const;

/** Max bytes read from the end of transcript.jsonl when tailing (avoids loading huge files). */
export const TRANSCRIPT_TAIL_READ_BYTES = 256 * 1024;

/** Relative to workspace root: `.dartsnut/agent-session`. */
export function resolveAgentSessionDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".dartsnut", "agent-session");
}

export type AgentSessionManifest = {
  schemaVersion: number;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  templateMode?: string | null;
  section?: string | null;
  /** Sticky assistant response locale (en / zh-Hans / zh-Hant); not used for routing. */
  preferredUserLocale?: "en" | "zh-Hans" | "zh-Hant" | null;
};

export type TranscriptRecord = {
  kind: "user" | "assistant" | "tool_status" | "thinking";
  at: number;
  text: string;
  toolName?: string;
};

export type ConversationFileV2 = {
  schemaVersion: number;
  items: AgentInputItem[];
};

export type TokenUsageFileV1 = {
  schemaVersion: number;
  usage: AgentSessionTokenUsage;
};

export type ModelChainFileV1 = {
  schemaVersion: 1;
  chainKey: string;
  responseId: string;
};

export function isAgentSessionPersistenceDisabledByEnv(): boolean {
  const v = process.env.DARTSNUT_DISABLE_AGENT_SESSION_PERSISTENCE;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Read JSONL records; drops trailing lines that do not parse (crash-safe tail).
 */
export function readJsonlRecords(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed line (typically incomplete tail).
    }
  }
  return out;
}

export class AgentSessionPersistence {
  private readonly dir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.dir = resolveAgentSessionDir(workspaceRoot);
  }

  private enqueueWrite(_label: string, task: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(task).catch(() => undefined);
  }

  /** Wait for queued async writes (tests / shutdown). */
  async flushWrites(): Promise<void> {
    await this.writeChain;
  }

  getSessionDir(): string {
    return this.dir;
  }

  hasPersistedSession(): boolean {
    return fs.existsSync(path.join(this.dir, "manifest.json"));
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  readManifest(): AgentSessionManifest | null {
    const file = path.join(this.dir, "manifest.json");
    if (!fs.existsSync(file)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as AgentSessionManifest;
      if (!parsed || typeof parsed.sessionId !== "string") {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  writeManifestAtomic(manifest: AgentSessionManifest): void {
    this.ensureDir();
    const target = path.join(this.dir, "manifest.json");
    const tmp = path.join(this.dir, `.manifest.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
    fs.renameSync(tmp, target);
  }

  appendTranscript(record: TranscriptRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    const target = path.join(this.dir, "transcript.jsonl");
    this.enqueueWrite("appendTranscript", async () => {
      this.ensureDir();
      await fsp.appendFile(target, line, "utf-8");
    });
  }

  appendTransaction(record: Record<string, unknown>): void {
    const line = `${JSON.stringify(record)}\n`;
    const target = path.join(this.dir, "transactions.jsonl");
    this.enqueueWrite("appendTransaction", async () => {
      this.ensureDir();
      await fsp.appendFile(target, line, "utf-8");
    });
  }

  readTranscriptTail(maxLines: number): TranscriptRecord[] {
    const target = path.join(this.dir, "transcript.jsonl");
    if (!fs.existsSync(target) || maxLines <= 0) {
      return [];
    }
    const stat = fs.statSync(target);
    const readStart =
      stat.size > TRANSCRIPT_TAIL_READ_BYTES ? stat.size - TRANSCRIPT_TAIL_READ_BYTES : 0;
    const length = stat.size - readStart;
    const fd = fs.openSync(target, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, readStart);
      let raw = buf.toString("utf-8");
      if (readStart > 0) {
        const firstNewline = raw.indexOf("\n");
        if (firstNewline >= 0) {
          raw = raw.slice(firstNewline + 1);
        }
      }
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      const tail = lines.slice(-maxLines);
      const out: TranscriptRecord[] = [];
      for (const line of tail) {
        try {
          out.push(JSON.parse(line) as TranscriptRecord);
        } catch {
          // skip bad line
        }
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }

  readConversationItems(): AgentInputItem[] {
    const target = path.join(this.dir, "conversation.json");
    if (!fs.existsSync(target)) {
      return [];
    }
    try {
      const data = JSON.parse(fs.readFileSync(target, "utf-8")) as ConversationFileV2;
      if (!data || data.schemaVersion !== AGENT_CONVERSATION_SCHEMA_VERSION || !Array.isArray(data.items)) {
        this.deleteActiveSession();
        return [];
      }
      return data.items;
    } catch {
      this.deleteActiveSession();
      return [];
    }
  }

  saveConversationItemsAtomic(items: AgentInputItem[]): void {
    const payload: ConversationFileV2 = { schemaVersion: AGENT_CONVERSATION_SCHEMA_VERSION, items };
    const target = path.join(this.dir, "conversation.json");
    const tmp = path.join(this.dir, `.conversation.${process.pid}.${Date.now()}.tmp`);
    const body = JSON.stringify(payload);
    this.enqueueWrite("saveConversationAtomic", async () => {
      this.ensureDir();
      await fsp.writeFile(tmp, body, "utf-8");
      await fsp.rename(tmp, target);
    });
  }

  readModelChainResponseId(chainKey: string): string | null {
    const target = path.join(this.dir, "model-chain.json");
    if (!fs.existsSync(target)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(target, "utf-8")) as ModelChainFileV1;
      if (
        data?.schemaVersion !== 1 ||
        data.chainKey !== chainKey ||
        typeof data.responseId !== "string" ||
        data.responseId.length === 0
      ) {
        this.clearModelChain();
        return null;
      }
      return data.responseId;
    } catch {
      return null;
    }
  }

  writeModelChainResponseIdAtomic(chainKey: string, responseId: string): void {
    this.ensureDir();
    const target = path.join(this.dir, "model-chain.json");
    const tmp = path.join(this.dir, `.model-chain.${process.pid}.${Date.now()}.tmp`);
    const payload: ModelChainFileV1 = { schemaVersion: 1, chainKey, responseId };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, target);
  }

  clearModelChain(): void {
    fs.rmSync(path.join(this.dir, "model-chain.json"), { force: true });
  }

  /** Remove incompatible active session state without touching workspace files or archives. */
  deleteActiveSession(): void {
    for (const file of ACTIVE_SESSION_FILES) {
      const target = path.join(this.dir, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target, { force: true });
      }
    }
  }

  readTokenUsage(): AgentSessionTokenUsage | null {
    const target = path.join(this.dir, "usage.json");
    if (!fs.existsSync(target)) {
      return null;
    }
    try {
      const data = JSON.parse(fs.readFileSync(target, "utf-8")) as TokenUsageFileV1;
      if (!data || data.schemaVersion !== AGENT_SESSION_SCHEMA_VERSION) {
        return null;
      }
      const usage = normalizeTokenUsage(data.usage);
      if (!usage) {
        return null;
      }
      const lastRun = normalizeTokenUsage(data.usage.lastRun);
      return {
        ...usage,
        ...(lastRun ? { lastRun } : {})
      };
    } catch {
      return null;
    }
  }

  writeTokenUsageAtomic(usage: AgentSessionTokenUsage): void {
    this.ensureDir();
    const target = path.join(this.dir, "usage.json");
    const tmp = path.join(this.dir, `.usage.${process.pid}.${Date.now()}.tmp`);
    const payload: TokenUsageFileV1 = { schemaVersion: AGENT_SESSION_SCHEMA_VERSION, usage };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, target);
  }

  /**
   * Move active session files into `archives/<iso-ish-label>/` and leave the session dir ready for a new session.
   */
  archiveOrResetSession(label: string): void {
    if (!fs.existsSync(this.dir)) {
      return;
    }
    const existing = ACTIVE_SESSION_FILES.filter((file) => fs.existsSync(path.join(this.dir, file)));
    if (existing.length === 0) {
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveName = `${stamp}-${label.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
    const archiveDir = path.join(this.dir, "archives", archiveName);
    fs.mkdirSync(archiveDir, { recursive: true });
    for (const f of existing) {
      fs.renameSync(path.join(this.dir, f), path.join(archiveDir, f));
    }
  }
}
