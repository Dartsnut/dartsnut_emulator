const POLOAI_HOST = "poloai.top";
const VALID_TERMINAL_TYPES = new Set(["response.completed", "response.incomplete"]);
const VALID_OUTPUT_STATUSES = new Set(["in_progress", "completed", "incomplete"]);

export function isPoloAiUrl(input: string | URL): boolean {
  try { return new URL(String(input)).hostname.toLowerCase() === POLOAI_HOST; } catch { return false; }
}

export function normalizePoloAiTerminalPayload(payload: unknown): { payload: unknown; normalizedCount: number } {
  if (!payload || typeof payload !== "object") return { payload, normalizedCount: 0 };
  const record = payload as { type?: unknown; response?: { output?: unknown } };
  if (!VALID_TERMINAL_TYPES.has(String(record.type)) || !Array.isArray(record.response?.output)) return { payload, normalizedCount: 0 };
  const expectedStatus = record.type === "response.completed" ? "completed" : "incomplete";
  let normalizedCount = 0;
  const output = record.response!.output.map((item) => {
    if (!item || typeof item !== "object") return item;
    const status = (item as { status?: unknown }).status;
    if (typeof status === "string" && VALID_OUTPUT_STATUSES.has(status)) return item;
    normalizedCount += 1;
    return { ...(item as Record<string, unknown>), status: expectedStatus };
  });
  return normalizedCount > 0 ? { payload: { ...record, response: { ...record.response, output } }, normalizedCount } : { payload, normalizedCount: 0 };
}

function normalizeSseRecord(record: string): string {
  const match = record.match(/(^|\r?\n)data:\s*(\{[\s\S]*\})(?=\r?\n|$)/m);
  if (!match) return record;
  try {
    const normalized = normalizePoloAiTerminalPayload(JSON.parse(match[2]));
    return normalized.normalizedCount ? `${record.slice(0, match.index! + match[1].length)}data: ${JSON.stringify(normalized.payload)}${record.slice(match.index! + match[0].length)}` : record;
  } catch { return record; }
}

export function normalizePoloAiResponse(response: Response, requestUrl: string | URL): Response {
  if (!isPoloAiUrl(requestUrl) || !response.body) return response;
  const headers = new Headers(response.headers);
  if (!(headers.get("content-type") || "").includes("text/event-stream")) return response;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const separator = buffer.match(/\r?\n\r?\n/)![0];
        const record = buffer.slice(0, boundary + separator.length);
        buffer = buffer.slice(boundary + separator.length);
        controller.enqueue(encoder.encode(normalizeSseRecord(record)));
      }
    },
    flush(controller) { buffer += decoder.decode(); if (buffer) controller.enqueue(encoder.encode(normalizeSseRecord(buffer))); }
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
