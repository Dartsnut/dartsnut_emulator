const MAX_SSE_PREFLIGHT_BYTES = 256 * 1024;

function hasSseRecordBoundary(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  return text.includes("\n\n") || text.includes("\r\n\r\n");
}

/** Holds only the first SSE record so early disconnects remain retryable. */
export async function fetchBufferedModelResponse(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetchImpl(input, init);
  const contentType = response.headers.get("content-type") || "";
  if (!response.body || (contentType && !contentType.includes("text/event-stream"))) return response;
  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  try {
    while (prefixBytes <= MAX_SSE_PREFLIGHT_BYTES) {
      const next = await reader.read();
      if (next.done) break;
      prefix.push(next.value);
      prefixBytes += next.value.byteLength;
      if (hasSseRecordBoundary(Buffer.concat(prefix))) break;
    }
    if (prefixBytes > MAX_SSE_PREFLIGHT_BYTES) throw new Error("SSE preflight record exceeds 256 KiB.");
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (init?.signal?.aborted) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`fetch failed: ${detail}`, { cause: error });
    wrapped.name = "FetchError";
    throw wrapped;
  }
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          controller.enqueue(next.value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
