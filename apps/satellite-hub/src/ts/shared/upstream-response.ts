import type { IncomingMessage } from "node:http";

/** Errors deliberately contain neither upstream text nor the original exception. */
export class UpstreamResponseError extends Error {
  constructor(readonly code: "size" | "length" | "timeout" | "cancelled" | "unavailable" | "json") {
    super(`Upstream response rejected (${code})`);
    this.name = "UpstreamResponseError";
  }
}

export interface UpstreamReadBudget {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Long-lived SSE uses an idle deadline and a separate cumulative frame cap. */
  eventStream?: boolean;
}

type UpstreamResponse = Response | IncomingMessage;

export async function discardUpstream(response: UpstreamResponse): Promise<void> {
  if ("destroy" in response) response.destroy();
  else await response.body?.cancel().catch(() => undefined);
}

/** Byte admission happens before buffering/decoding, for fetch and mTLS alike. */
export async function* upstreamChunks(response: UpstreamResponse, budget: UpstreamReadBudget): AsyncGenerator<Uint8Array> {
  const incoming = "destroy" in response ? response : null;
  const fetched = incoming ? null : response as Response;
  const declared = incoming ? incoming.headers["content-length"] : fetched!.headers.get("content-length");
  const invalidLength = declared != null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)));
  if (invalidLength || (declared != null && !budget.eventStream && Number(declared) > budget.maxBytes)) {
    await discardUpstream(response);
    throw new UpstreamResponseError(invalidLength ? "length" : "size");
  }
  if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes <= 0 || !Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs <= 0) {
    await discardUpstream(response);
    throw new UpstreamResponseError("unavailable");
  }
  const reader = fetched?.body?.getReader();
  const iterator = incoming?.[Symbol.asyncIterator]();
  if (!reader && !iterator) return;
  let complete = false;
  let received = 0;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let rejectRead: ((reason: Error) => void) | undefined;
  const cancel = (): void => {
    incoming?.destroy();
    if (reader) void reader.cancel().catch(() => undefined);
  };
  const abort = (): void => { cancel(); rejectRead?.(new UpstreamResponseError(timedOut ? "timeout" : "cancelled")); };
  const armDeadline = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; abort(); }, budget.timeoutMs);
    timer.unref();
  };
  budget.signal?.addEventListener("abort", abort, { once: true });
  armDeadline();
  try {
    if (budget.signal?.aborted) throw new UpstreamResponseError("cancelled");
    for (;;) {
      const next = reader ? reader.read() : iterator!.next();
      // Keep one interrupt waiter. Racing every read against one never-settled
      // promise would retain a reaction per chunk for the lifetime of SSE.
      const { done, value } = await new Promise<IteratorResult<Uint8Array | string>>((resolve, reject) => {
        rejectRead = reject;
        void next.then(resolve, reject);
      }).finally(() => { rejectRead = undefined; });
      if (timedOut || budget.signal?.aborted) throw new UpstreamResponseError(timedOut ? "timeout" : "cancelled");
      if (done) { complete = true; break; }
      const chunk: Uint8Array = typeof value === "string" ? Buffer.from(value) : value;
      received = budget.eventStream ? chunk.byteLength : received + chunk.byteLength;
      if (received > budget.maxBytes) throw new UpstreamResponseError("size");
      if (budget.eventStream) armDeadline();
      yield chunk;
    }
  } catch (error) {
    throw error instanceof UpstreamResponseError ? error : new UpstreamResponseError("unavailable");
  } finally {
    clearTimeout(timer);
    budget.signal?.removeEventListener("abort", abort);
    if (!complete) cancel();
    if (reader) {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}

export async function readUpstreamBytes(response: UpstreamResponse, budget: UpstreamReadBudget): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of upstreamChunks(response, budget)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function readUpstreamText(response: UpstreamResponse, budget: UpstreamReadBudget): Promise<string> {
  return (await readUpstreamBytes(response, budget)).toString("utf8");
}

export async function readUpstreamJson(response: UpstreamResponse, budget: UpstreamReadBudget): Promise<unknown> {
  const text = await readUpstreamText(response, budget);
  try { return JSON.parse(text) as unknown; }
  catch { throw new UpstreamResponseError("json"); }
}

/** Header/connect deadlines do not impose a lifetime limit on valid SSE. */
export async function fetchUpstream(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const parent = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try { return await fetchImpl(input, { ...init, signal }); }
  catch { throw new UpstreamResponseError(parent?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "unavailable"); }
  finally { clearTimeout(timer); }
}

/** Counts retained UTF-8 bytes without rescanning an ever-growing reply. */
export class Utf8ByteBudget {
  private bytes = 0;
  private trailingHighSurrogate = false;
  constructor(private readonly maxBytes: number) {}

  append(text: string): void {
    if (!text) return;
    const first = text.charCodeAt(0);
    const joinsSurrogate = this.trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff;
    const bytes = this.bytes + Buffer.byteLength(text) - (joinsSurrogate ? 2 : 0);
    if (bytes > this.maxBytes) throw new UpstreamResponseError("size");
    this.bytes = bytes;
    const last = text.charCodeAt(text.length - 1);
    this.trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  }
}
