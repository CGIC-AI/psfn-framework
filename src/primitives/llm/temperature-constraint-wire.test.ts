import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels } from '@earendil-works/pi-ai';
import type { LLMCompletionModelHint, LLMContext } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { LLMClient } from './client.js';
import { PiProviderRuntime } from './provider-runtime.js';

/**
 * psfn-framework-glst7: a model card that declares
 * `capabilities.rejectsTemperature` must never see a `temperature` key in the
 * request body, whichever path built the request. The provider here is a real
 * loopback OpenAI-compatible endpoint driven through the real pi-ai runtime, so
 * the assertions read the JSON body exactly as it crossed the wire.
 */

const ROUTER_KEY_ENV = 'PSFN_TEMPERATURE_WIRE_TEST_KEY';
const FIXED_MODEL = 'fixed-temperature-model';
const FREE_MODEL = 'free-temperature-model';

const bodies: Record<string, unknown>[] = [];
let server: Server;
let baseUrl = '';
const tempDirs: string[] = [];

function sseChunk(model: string, delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-wire-test',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } } : {}),
  })}\n\n`;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  bodies.push(body);
  const model = typeof body.model === 'string' ? body.model : 'unknown';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sseChunk(model, { role: 'assistant', content: 'ok' }, null));
  res.write(sseChunk(model, {}, 'stop'));
  res.end('data: [DONE]\n\n');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  bodies.length = 0;
  process.env[ROUTER_KEY_ENV] = 'wire-test-key';
});

afterEach(() => {
  delete process.env[ROUTER_KEY_ENV];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(): SubstrateConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'psfn-temperature-wire-'));
  tempDirs.push(dataDir);
  const providerRegistry: NonNullable<SubstrateConfig['providerRegistry']> = {
    schemaVersion: 1,
    providers: [{
      id: 'wire-router',
      type: 'generic_openai',
      enabled: true,
      label: 'Wire router',
      apiBaseUrl: baseUrl,
      apiKeyRef: { kind: 'env', envName: ROUTER_KEY_ENV },
    }],
  };
  return {
    primaryModel: FIXED_MODEL,
    primaryProvider: 'wire-router',
    extractionModel: FREE_MODEL,
    extractionProvider: 'wire-router',
    primaryMaxTokens: 512,
    extractionMaxTokens: 512,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: join(dataDir, 'test.db'),
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 32_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    retryMaxAttempts: 0,
    retryBaseDelayMs: 0,
    providerRegistry,
    modelRegistry: {
      schemaVersion: 1,
      models: [
        {
          // The card of a provider that fixes sampling temperature. Its own
          // tuning still names one, as a migrated owner file might.
          id: 'fixed-temperature-slot',
          rank: 10,
          apiKind: 'openai-completions',
          identity: { provider: 'wire-router', model: FIXED_MODEL, source: { type: 'configured' } },
          purposes: [{ purpose: 'chat', primary: true }, { purpose: 'reasoning', primary: true }],
          capabilities: { maxOutputTokens: 512, contextWindow: 32_000, rejectsTemperature: true },
          tuning: { maxOutputTokens: 512, temperature: 0.7 },
        },
        {
          id: 'free-temperature-slot',
          rank: 20,
          apiKind: 'openai-completions',
          identity: { provider: 'wire-router', model: FREE_MODEL, source: { type: 'configured' } },
          purposes: [{ purpose: 'background', primary: true }],
          capabilities: { maxOutputTokens: 512, contextWindow: 32_000 },
          tuning: { maxOutputTokens: 512, temperature: 0.4 },
        },
      ],
    },
  };
}

function gatewayClient(config: SubstrateConfig): LLMClient {
  const runtime = new PiProviderRuntime(createModels(), {
    providerRegistry: config.providerRegistry,
    modelRegistry: config.modelRegistry,
  });
  return new LLMClient(config, { runtime });
}

function context(modelHint?: LLMCompletionModelHint): LLMContext {
  return {
    systemPrompt: 'System',
    messages: [{ role: 'user', content: 'hello' }],
    correlation: {
      companionId: 'companion-1',
      channelId: 'api:wire-test',
      channelType: 'api',
      callType: 'chat',
      requestId: 'request-1',
      turnId: 'turn-1',
    },
    ...(modelHint ? { modelHint } : {}),
  };
}

function onlyBody(): Record<string, unknown> {
  expect(bodies).toHaveLength(1);
  return bodies[0]!;
}

describe('rejectsTemperature on the provider wire (psfn-framework-glst7)', () => {
  it('direct: the registry-resolved candidate omits its card tuning temperature', async () => {
    await gatewayClient(makeConfig()).complete(context(), 'reasoning');

    const body = onlyBody();
    expect(body.model).toBe(FIXED_MODEL);
    expect(body).not.toHaveProperty('temperature');
  });

  it('direct streaming: the interactive stream omits it too', async () => {
    await gatewayClient(makeConfig()).stream(context());

    const body = onlyBody();
    expect(body.model).toBe(FIXED_MODEL);
    expect(body).not.toHaveProperty('temperature');
  });

  it('hinted: a caller-pinned temperature 0 never reaches a rejecting model', async () => {
    // The introspection and blind-review runtimes pin temperature 0 this way.
    await gatewayClient(makeConfig()).complete(
      context({ maxTokens: 256, temperature: 0 }),
      'reasoning',
    );

    const body = onlyBody();
    expect(body.model).toBe(FIXED_MODEL);
    expect(body).not.toHaveProperty('temperature');
  });

  it('slot hint: selecting the rejecting slot on another lane omits the lane temperature', async () => {
    await gatewayClient(makeConfig()).complete(
      context({ slotKey: 'fixed-temperature-slot', temperature: 0 }),
      'background',
    );

    const body = onlyBody();
    expect(body.model).toBe(FIXED_MODEL);
    expect(body).not.toHaveProperty('temperature');
  });

  it('provider+model hint: retargeting a free lane onto the rejecting model omits it', async () => {
    await gatewayClient(makeConfig()).complete(
      context({ provider: 'wire-router', model: FIXED_MODEL }),
      'background',
    );

    const body = onlyBody();
    expect(body.model).toBe(FIXED_MODEL);
    expect(body).not.toHaveProperty('temperature');
  });

  it('routed: the agent-to-gateway transport hop omits it for completions and streams', async () => {
    const config = makeConfig();
    const agent = new LLMClient(config, { transport: gatewayClient(config) });

    await agent.complete(context({ temperature: 0 }), 'reasoning');
    await agent.stream(context());

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.model).toBe(FIXED_MODEL);
      expect(body).not.toHaveProperty('temperature');
    }
  });

  it('control: a model without the flag keeps its tuning and a hinted temperature', async () => {
    const client = gatewayClient(makeConfig());

    await client.complete(context(), 'background');
    await client.complete(context({ temperature: 0 }), 'background');

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ model: FREE_MODEL, temperature: 0.4 });
    expect(bodies[1]).toMatchObject({ model: FREE_MODEL, temperature: 0 });
  });
});
