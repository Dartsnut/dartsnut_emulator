import type { ProviderConfig } from "./providerConfig";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Default cap so a hung provider does not leave the UI stuck forever. */
const DEFAULT_CHAT_COMPLETION_TIMEOUT_MS = 180_000;

export class ProviderClient {
  constructor(private readonly config: ProviderConfig) { }

  async complete(messages: ChatMessage[], onChunk?: (delta: string) => void): Promise<string> {
    const timeoutMs = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || DEFAULT_CHAT_COMPLETION_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.2,
        stream: Boolean(onChunk)
      }),
      signal
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(
          `Provider request timed out after ${timeoutMs}ms. Check OPENAI_BASE_URL, network, and model availability.`
        );
      }
      throw error;
    });

    if (!response.ok) {
      const rawBody = await response.text();
      let detail = rawBody.trim();
      try {
        const parsed = JSON.parse(rawBody) as {
          error?: { message?: string; type?: string; code?: string | number };
          message?: string;
        };
        const typed = parsed.error
          ? [parsed.error.type, parsed.error.code, parsed.error.message].filter(Boolean).join(" - ")
          : parsed.message;
        if (typed) {
          detail = typed;
        }
      } catch {
        // Keep raw response body when provider returns non-JSON errors.
      }
      const suffix = detail ? `: ${detail}` : "";
      throw new Error(`Provider request failed: ${response.status}${suffix}`);
    }

    if (!onChunk) {
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return payload.choices?.[0]?.message?.content?.trim() || "No response content returned.";
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Provider streaming response body is unavailable.");
    }
    const decoder = new TextDecoder();
    let pending = "";
    let fullText = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          if (!delta) {
            continue;
          }
          fullText += delta;
          onChunk(delta);
        } catch {
          // Ignore malformed partial streaming frames.
        }
      }
    }
    return fullText.trim() || "No response content returned.";
  }
}
