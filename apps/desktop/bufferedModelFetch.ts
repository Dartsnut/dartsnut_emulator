/**
 * Holds a model response until its body is complete. The Agents SDK can then
 * retry a broken SSE request before any partial model events escape.
 */
export async function fetchBufferedModelResponse(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetchImpl(input, init);
  let body: ArrayBuffer | null;
  try {
    body = response.body ? await response.arrayBuffer() : null;
  } catch (error) {
    if (init?.signal?.aborted) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`fetch failed: ${detail}`, { cause: error });
    wrapped.name = "FetchError";
    throw wrapped;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
