import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenAI-compatible chat-completions endpoint whose answers a test
 * scripts per request, so the real pi-ai transport, request hooks, abort
 * handling and model-call gate run end to end without a provider.
 */
export type ScriptedEndpointAnswer =
  /** Accept the request and never answer. */
  | 'hang_before_headers'
  /** Answer 200 with the opening role chunk, then stall (a provider still prefilling). */
  | 'role_chunk_then_hang'
  /** Stream some text without usage, then stall. */
  | 'partial_text_then_hang'
  | 'http_500'
  | 'http_504'
  /** Stream a short reply with usage. */
  | 'complete';

export interface ScriptedOpenAIEndpoint {
  readonly baseUrl: string;
  /** Requests that reached the endpoint. */
  readonly requests: number;
  /**
   * Script the next request; `delayMs` holds a `complete` answer that long
   * after its role chunk, and `usage` replaces its final usage chunk (cached
   * prompt tokens, a provider-billed `cost`).
   */
  enqueue(answer: ScriptedEndpointAnswer, options?: ScriptedAnswerOptions): void;
  /** Resolves once the next request has received its scripted opening. */
  nextArrival(): Promise<void>;
  close(): Promise<void>;
}

export interface ScriptedAnswerOptions {
  delayMs?: number;
  usage?: Record<string, unknown>;
}

const SCRIPTED_REPLY = 'done';
const SCRIPTED_USAGE = { prompt_tokens: 40, completion_tokens: 2, total_tokens: 42 };

function sse(res: ServerResponse, chunk: unknown): void {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function startScriptedOpenAIEndpoint(): Promise<ScriptedOpenAIEndpoint> {
  const queue: Array<{ answer: ScriptedEndpointAnswer } & ScriptedAnswerOptions> = [];
  const waiters: Array<() => void> = [];
  const open = new Set<ServerResponse>();
  let requests = 0;
  const arrived = () => waiters.shift()?.();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const next = queue.shift();
      const answer = next?.answer ?? 'complete';
      open.add(res);
      res.on('close', () => open.delete(res));
      const id = `scripted-${String(requests)}`;
      if (answer === 'http_500' || answer === 'http_504') {
        res.writeHead(answer === 'http_500' ? 500 : 504, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'scripted upstream failure' } }));
        arrived();
        return;
      }
      if (answer === 'hang_before_headers') {
        arrived();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' } }] });
      if (answer === 'role_chunk_then_hang') {
        arrived();
        return;
      }
      if (answer === 'partial_text_then_hang') {
        sse(res, { id, choices: [{ index: 0, delta: { content: 'The partial answer the provider already generated' } }] });
        // Let the client parse the delta before the test acts.
        setTimeout(arrived, 50);
        return;
      }
      arrived();
      setTimeout(() => {
        if (res.destroyed) return;
        sse(res, { id, choices: [{ index: 0, delta: { content: SCRIPTED_REPLY }, finish_reason: 'stop' }] });
        sse(res, { id, choices: [], usage: next?.usage ?? SCRIPTED_USAGE });
        res.end('data: [DONE]\n\n');
      }, next?.delayMs);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    get requests() { return requests; },
    enqueue(answer, options) { queue.push({ answer, ...options }); },
    nextArrival: () => new Promise<void>(resolve => waiters.push(resolve)),
    async close() {
      for (const res of open) res.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** Provider + model registry entries that route every purpose to the endpoint. */
export function scriptedEndpointRegistries(input: {
  baseUrl: string;
  apiKeyEnv: string;
  maxOutputTokens: number;
  cost?: { inputPer1MUsd: number; outputPer1MUsd: number; cacheReadPer1MUsd: number; cacheWritePer1MUsd: number };
}) {
  return {
    providerRegistry: {
      schemaVersion: 1 as const,
      providers: [{
        id: 'scripted-endpoint',
        type: 'generic_openai' as const,
        enabled: true,
        label: 'Scripted endpoint',
        apiBaseUrl: input.baseUrl,
        apiKeyRef: { kind: 'env' as const, envName: input.apiKeyEnv },
      }],
    },
    model: {
      id: 'scripted',
      rank: 10,
      apiKind: 'openai-completions' as const,
      identity: { provider: 'scripted-endpoint', model: 'scripted-model', source: { type: 'configured' as const } },
      purposes: [
        { purpose: 'chat' as const, primary: true },
        { purpose: 'background' as const, primary: true },
        { purpose: 'extraction' as const, primary: true },
      ],
      capabilities: { maxOutputTokens: input.maxOutputTokens, contextWindow: 200_000 },
      tuning: { maxOutputTokens: input.maxOutputTokens, contextWindow: 200_000, thinkingEnabled: false },
      ...(input.cost ? { cost: { ...input.cost, currency: 'USD' } } : {}),
    },
  };
}
