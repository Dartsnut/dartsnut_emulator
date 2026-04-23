import type { ProviderConfig } from "./providerConfig";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class ProviderClient {
  constructor(private readonly config: ProviderConfig) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: 0.2
      })
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

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return payload.choices?.[0]?.message?.content?.trim() || "No response content returned.";
  }
}
