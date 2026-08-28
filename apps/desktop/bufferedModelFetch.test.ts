import { describe, expect, it, vi } from "vitest";
import { fetchBufferedModelResponse } from "./bufferedModelFetch";

describe("fetchBufferedModelResponse", () => {
  it("returns a fully buffered response with metadata intact", async () => {
    const fetchImpl = vi.fn(async () => new Response("complete", {
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "text/event-stream", "x-request-id": "request-1" }
    }));

    const response = await fetchBufferedModelResponse(fetchImpl, "https://example.com/v1/responses", {
      method: "POST",
      body: "request-body"
    });

    expect(await response.text()).toBe("complete");
    expect(response.status).toBe(202);
    expect(response.statusText).toBe("Accepted");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("request-1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects before exposing any bytes when an SSE body disconnects", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("net::ERR_CONNECTION_CLOSED"));
      }
    });

    await expect(fetchBufferedModelResponse(
      vi.fn(async () => new Response(stream, { status: 200 })),
      "https://example.com/v1/responses"
    )).rejects.toThrow("net::ERR_CONNECTION_CLOSED");
  });

  it("returns after first SSE record without buffering the whole stream", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        await blocked;
        controller.enqueue(new TextEncoder().encode("data: second\n\n"));
        controller.close();
      }
    });
    const response = await fetchBufferedModelResponse(
      vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })),
      "https://example.com/v1/responses"
    );
    release?.();
    expect(await response.text()).toBe("data: first\n\ndata: second\n\n");
  });
});
