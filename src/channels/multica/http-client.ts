export type MulticaFetch = typeof fetch;

export class MulticaHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    body: string,
  ) {
    super(`Multica ${method} ${path} returned ${status}: ${body}`);
  }
}

export async function withMulticaOperationTimeout<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let timeout: NodeJS.Timeout | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const rejectForAbort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      rejectForAbort();
      return;
    }
    signal.addEventListener('abort', rejectForAbort, { once: true });
  });
  try {
    timeout = setTimeout(() => controller.abort(new Error('Multica operation timed out')), timeoutMs);
    timeout.unref();
    return await Promise.race([action(signal), abortPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!controller.signal.aborted) controller.abort();
  }
}

export class MulticaHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly requestTimeoutMs: number,
    private readonly fetchImpl: MulticaFetch = fetch,
  ) {}

  async postJson(
    path: string,
    body: Record<string, unknown>,
    token = this.token,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return await this.requestJson(path, { method: 'POST', body: JSON.stringify(body) }, token, signal);
  }

  async requestJson(path: string, init: RequestInit, token = this.token, signal?: AbortSignal): Promise<unknown> {
    return await withMulticaOperationTimeout(async requestSignal => {
      const response = await this.fetchImpl(
        new URL(path, `${this.baseUrl}/`),
        {
          ...init,
          signal: requestSignal,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(init.body ? { 'content-type': 'application/json' } : {}),
          },
        },
      );
      const text = await response.text();
      if (!response.ok) {
        throw new MulticaHttpError(response.status, init.method ?? 'GET', path, text);
      }
      if (!text.trim()) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Multica ${init.method ?? 'GET'} ${path} returned invalid JSON`);
      }
    }, this.requestTimeoutMs, signal);
  }
}
