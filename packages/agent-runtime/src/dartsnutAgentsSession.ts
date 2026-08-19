import type { AgentInputItem, Session } from "@openai/agents";
import type { AgentSessionPersistence } from "./agentSessionPersistence";
import type { AgentProfileId } from "@dartsnut/shared-ipc";

export type DartsnutAgentsSessionOptions = {
  sessionId: string;
  initialItems?: AgentInputItem[];
  sessionPersistence?: AgentSessionPersistence;
  sessionTemplateMode?: string | null;
  sessionSection?: string | null;
  agentProfileId?: AgentProfileId | null;
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
  private readonly manifestMeta: Omit<DartsnutAgentsSessionOptions, "sessionId" | "initialItems" | "sessionPersistence">;
  private items: AgentInputItem[];

  constructor(options: DartsnutAgentsSessionOptions) {
    this.sessionId = options.sessionId;
    this.persistence = options.sessionPersistence;
    this.manifestMeta = {
      sessionTemplateMode: options.sessionTemplateMode ?? null,
      sessionSection: options.sessionSection ?? null,
      agentProfileId: options.agentProfileId ?? null
    };
    const fromDisk = options.sessionPersistence?.readConversationItems() ?? [];
    this.items = cloneItems(options.initialItems ?? fromDisk);
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
      agentProfileId: this.manifestMeta.agentProfileId ?? null
    });
    this.persistence.saveConversationItemsAtomic(this.items);
  }
}
