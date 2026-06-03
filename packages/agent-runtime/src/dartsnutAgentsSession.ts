import type { AgentInputItem, Session } from "@openai/agents";
import type { AgentSessionPersistence } from "./agentSessionPersistence";
import type { ChatMessage } from "./providerClient";
import {
  agentInputItemsToChatMessages,
  chatMessagesToAgentInputItems
} from "./conversationProtocol";

export type DartsnutAgentsSessionOptions = {
  sessionId: string;
  initialConversation?: ChatMessage[];
  sessionPersistence?: AgentSessionPersistence;
  sessionTemplateMode?: string | null;
  sessionSection?: string | null;
  preferredUserLocale?: "en" | "zh-Hans" | "zh-Hant" | null;
};

function cloneItems(items: AgentInputItem[]): AgentInputItem[] {
  return structuredClone(items);
}

/**
 * File-backed SDK Session using existing `.dartsnut/agent-session/conversation.json`.
 */
export class DartsnutAgentsSession implements Session {
  private readonly sessionId: string;
  private readonly persistence?: AgentSessionPersistence;
  private readonly manifestMeta: Omit<DartsnutAgentsSessionOptions, "sessionId" | "initialConversation" | "sessionPersistence">;
  private items: AgentInputItem[];

  constructor(options: DartsnutAgentsSessionOptions) {
    this.sessionId = options.sessionId;
    this.persistence = options.sessionPersistence;
    this.manifestMeta = {
      sessionTemplateMode: options.sessionTemplateMode ?? null,
      sessionSection: options.sessionSection ?? null,
      preferredUserLocale: options.preferredUserLocale ?? null
    };
    const fromDisk = options.sessionPersistence?.readConversation() ?? [];
    const seed = options.initialConversation ?? fromDisk;
    this.items =
      seed.length > 0
        ? chatMessagesToAgentInputItems(seed)
        : fromDisk.length > 0
          ? chatMessagesToAgentInputItems(fromDisk)
          : [];
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const cloned = cloneItems(this.items);
    if (limit === undefined) {
      return cloned;
    }
    if (limit <= 0) {
      return [];
    }
    return cloned.slice(Math.max(0, cloned.length - limit));
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    this.items = [...this.items, ...cloneItems(items)];
    this.syncPersistence();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.items.length === 0) {
      return undefined;
    }
    const item = this.items[this.items.length - 1];
    this.items = this.items.slice(0, -1);
    this.syncPersistence();
    return cloneItems([item])[0];
  }

  async clearSession(): Promise<void> {
    this.items = [];
    if (this.persistence) {
      this.persistence.archiveOrResetSession("sdk-clear");
    }
  }

  getItemsSnapshot(): AgentInputItem[] {
    return cloneItems(this.items);
  }

  private syncPersistence(): void {
    if (!this.persistence) {
      return;
    }
    const nowIso = new Date().toISOString();
    const manifest = this.persistence.readManifest();
    this.persistence.writeManifestAtomic({
      schemaVersion: 1,
      sessionId: this.sessionId,
      createdAt: manifest?.createdAt ?? nowIso,
      updatedAt: nowIso,
      templateMode: this.manifestMeta.sessionTemplateMode ?? null,
      section: this.manifestMeta.sessionSection ?? null,
      preferredUserLocale: this.manifestMeta.preferredUserLocale ?? null
    });
    const messages = agentInputItemsToChatMessages(this.items);
    this.persistence.saveConversationAtomic(messages);
  }
}
