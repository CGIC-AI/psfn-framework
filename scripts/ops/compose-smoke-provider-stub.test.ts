// ── Keyless Compose smoke contract (psfn-framework-j3iol) ──
//
// The smoke stack claims it needs no provider account. These tests pin that
// claim against the framework's own code rather than against a docker run:
//
//   1. The smoke owner fixtures load through the real providers/models parsers
//      and satisfy `resolveIntakeScreenerModels` + `assertScreenerBackendReady`
//      — the exact startup check that made a keyless stack impossible — and
//      still fail closed with the production error when the credential is gone.
//   2. The compose wiring keeps the double internal-only and hands the gateway
//      the bearer, with no provider-account slot left behind.
//   3. The double answers the real wire protocol over real HTTP, and each
//      screener verdict it returns is accepted by that screener's own
//      validator.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createStaticCredentialVault } from '../../src/boundary/custody/credential-vault.js';
import {
  assertScreenerBackendReady,
  type ScreenerTestCompletion,
  type ScreenerUserContentPart,
} from '../../src/boundary/gateway/intake/screener-transport.js';
import { resolveIntakeScreenerModels } from '../../src/boundary/gateway/intake/screener-model-selection.js';
import { screenL2 } from '../../src/boundary/gateway/intake/l2-screener.js';
import { screenL3 } from '../../src/boundary/gateway/intake/l3-screener.js';
import { screenImageWithVisionModel } from '../../src/boundary/gateway/intake/vision-screener.js';
import { LLMRequestCapability } from '../../src/primitives/llm/client-request-capability.js';
import { PiProviderRuntime } from '../../src/primitives/llm/provider-runtime.js';
import { loadModelsConfig } from '../../src/system/config/models-config.js';
import {
  applyProvidersRuntimeConfig,
  loadProvidersConfig,
} from '../../src/system/config/providers-config.js';
import type { SubstrateConfig } from '../../src/system/config/runtime-config-contracts.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const fixtureDir = join(repoRoot, 'docker/smoke-fixtures');
const composeFile = join(repoRoot, 'docker/docker-compose.smoke.yml');
const stubScript = join(repoRoot, 'scripts/ops/psfn-compose-smoke-provider-stub.mjs');

const STUB_KEY = 'compose-smoke-provider-stub-unit-test-key';
const STUB_REPLY = 'Smoke stub acknowledges the compose smoke turn.';
const STUB_KEY_ENV = 'PSFN_SMOKE_PROVIDER_STUB_API_KEY';
// 1x1 transparent PNG; the vision screener only needs a well-formed image part.
const TINY_PNG_BASE64
  = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function buildSmokeConfig(credentials: Record<string, string>): SubstrateConfig {
  const models = loadModelsConfig(fixtureDir, { seedDir: fixtureDir });
  const providers = loadProvidersConfig(fixtureDir, { seedDir: fixtureDir });
  const config = {
    modelRegistry: models.modelRegistry,
    modelCatalog: models.modelCatalog,
    modelRoleAssignments: models.modelRoleAssignments,
    modelRoster: models.modelRoster,
    primaryModel: models.primaryModel,
    primaryProvider: models.primaryProvider,
    credentialVault: createStaticCredentialVault(credentials),
  } as unknown as SubstrateConfig;
  applyProvidersRuntimeConfig(config, providers);
  return config;
}

function buildScreenerBackend(config: SubstrateConfig) {
  const runtime = new PiProviderRuntime(undefined, {
    providerRegistry: config.providerRegistry,
    modelRegistry: config.modelRegistry,
    credentialVault: config.credentialVault,
  });
  return { runtime, requestCapability: new LLMRequestCapability(config, runtime) };
}

describe('Compose smoke keyless owner fixtures', () => {
  it('satisfies the intake screener startup check without any provider account', () => {
    const config = buildSmokeConfig({ [STUB_KEY_ENV]: STUB_KEY });
    const selection = resolveIntakeScreenerModels(config, {
      l3DualModel: false,
      visionEnabled: true,
    });

    expect(selection.l2).toMatchObject({ provider: 'smoke-stub', model: 'smoke-stub-background' });
    expect(selection.l3.map(route => route.model)).toEqual([
      'smoke-stub-chat',
      'smoke-stub-background',
    ]);
    expect(selection.vision).toMatchObject({
      provider: 'smoke-stub',
      model: 'smoke-stub-chat',
      supportsVision: true,
    });

    expect(() => assertScreenerBackendReady(buildScreenerBackend(config), [
      selection.l2,
      ...selection.l3,
      selection.vision!,
    ])).not.toThrow();
  });

  it('still fails closed with the production error when the credential is absent', () => {
    const config = buildSmokeConfig({});
    const selection = resolveIntakeScreenerModels(config, {
      l3DualModel: false,
      visionEnabled: true,
    });

    expect(() => assertScreenerBackendReady(buildScreenerBackend(config), [selection.l2]))
      .toThrow('Intake screener provider "smoke-stub" has no gateway-resolved credential');
  });

  it('routes every canonical purpose at the in-stack double and nothing else', () => {
    const providers = loadProvidersConfig(fixtureDir, { seedDir: fixtureDir });
    const models = loadModelsConfig(fixtureDir, { seedDir: fixtureDir });

    expect(providers.registry.providers).toHaveLength(1);
    expect(providers.registry.providers[0]).toMatchObject({
      id: 'smoke-stub',
      type: 'generic_openai',
      enabled: true,
      apiBaseUrl: 'http://provider-stub:3000/v1',
      apiKeyRef: { kind: 'env', envName: STUB_KEY_ENV },
    });
    for (const entry of models.modelRegistry.models) {
      expect(entry.identity.provider).toBe('smoke-stub');
      expect(entry.apiKind).toBe('openai-completions');
    }
  });
});

describe('Compose smoke provider double wiring', () => {
  const compose = parseYaml(readFileSync(composeFile, 'utf8')) as {
    services?: Record<string, {
      depends_on?: Record<string, { condition?: string }>;
      environment?: Record<string, string>;
      healthcheck?: unknown;
      networks?: string[];
      ports?: unknown;
      volumes?: string[];
    }>;
  };

  it('keeps the double internal-only, unpublished, and health-gated', () => {
    const stub = compose.services?.['provider-stub'];
    expect(stub?.networks).toEqual(['psfn-smoke-internal']);
    expect(stub?.ports).toBeUndefined();
    expect(stub?.healthcheck).toBeDefined();
    expect(compose.services?.gateway?.depends_on?.['provider-stub'])
      .toEqual({ condition: 'service_healthy' });
  });

  it('hands the gateway the double bearer and leaves no provider-account slot', () => {
    const gateway = compose.services?.gateway;
    expect(gateway?.environment?.[STUB_KEY_ENV]).toBeDefined();
    expect(gateway?.environment).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(compose.services?.agent?.environment).not.toHaveProperty(STUB_KEY_ENV);
  });

  it('mounts the smoke owner fixtures read-only into the seed', () => {
    expect(compose.services?.seed?.volumes)
      .toContain('../docker/smoke-fixtures:/app/docker/smoke-fixtures:ro');
  });
});

describe('Compose smoke provider double over HTTP', () => {
  let child: ChildProcessWithoutNullStreams;
  let baseUrl = '';

  beforeAll(async () => {
    const port = 34_517;
    baseUrl = `http://127.0.0.1:${String(port)}`;
    child = spawn(process.execPath, [stubScript], {
      env: {
        ...process.env,
        PSFN_SMOKE_PROVIDER_STUB_HOST: '127.0.0.1',
        PSFN_SMOKE_PROVIDER_STUB_PORT: String(port),
        PSFN_SMOKE_PROVIDER_STUB_API_KEY: STUB_KEY,
        PSFN_SMOKE_PROVIDER_STUB_REPLY: STUB_REPLY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const probe = await fetch(`${baseUrl}/health`);
        if (probe.ok || probe.status === 204) return;
      } catch {
        if (Date.now() > deadline) throw new Error('provider stub did not become ready');
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  });

  afterAll(async () => {
    child.kill('SIGTERM');
    await once(child, 'exit');
  });

  async function postCompletion(body: unknown, key: string | undefined): Promise<Response> {
    return fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects a request that does not present the configured bearer', async () => {
    const anonymous = await postCompletion({ model: 'smoke-stub-chat', messages: [] }, undefined);
    expect(anonymous.status).toBe(401);
    const wrong = await postCompletion(
      { model: 'smoke-stub-chat', messages: [] },
      'not-the-configured-key',
    );
    expect(wrong.status).toBe(401);
  });

  it('serves the fixture catalog at the derived models URL', async () => {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${STUB_KEY}` },
    });
    expect(response.status).toBe(200);
    const catalog = await response.json() as { data: Array<{ id: string }> };
    expect(catalog.data.map(entry => entry.id))
      .toEqual(['smoke-stub-chat', 'smoke-stub-background']);
  });

  it('answers a streamed completion the way pi-ai sends it', async () => {
    const response = await postCompletion({
      model: 'smoke-stub-chat',
      messages: [{ role: 'user', content: 'Smoke ping.' }],
      stream: true,
      stream_options: { include_usage: true },
    }, STUB_KEY);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain(STUB_REPLY);
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"total_tokens"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  // The screener transport's own test seam, pointed at the running double: the
  // verdict the double returns is parsed by the real screener validator, so a
  // schema drift on either side fails here rather than inside a docker run.
  const completeThroughStub: ScreenerTestCompletion = async (input) => {
    const userMessage: string | ScreenerUserContentPart[] = input.userMessage;
    const response = await postCompletion({
      model: typeof input.model === 'string' ? input.model : input.model.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: userMessage },
      ],
    }, STUB_KEY);
    const payload = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return payload.choices[0]!.message.content;
  };

  const screenerDeps = {
    backend: {},
    model: { provider: 'smoke-stub', model: 'smoke-stub-background' },
    timeoutMs: 5_000,
    testCompletion: completeThroughStub,
  } as const;

  it('returns an L2 verdict the L2 validator accepts', async () => {
    const classification = await screenL2(
      'Smoke ping from the docker compose stack.',
      { sourceClass: 'primary_user', sourceRiskTier: 'trusted' },
      { ...screenerDeps },
    );
    expect(classification.labels).toEqual([]);
    expect(classification.injectionConfidence).toBe(0);
    expect(classification.summary.length).toBeGreaterThan(0);
  });

  it('returns an L3 verdict the L3 validator accepts', async () => {
    const verdict = await screenL3(
      'Smoke ping from the docker compose stack.',
      { sourceClass: 'primary_user', sourceRiskTier: 'trusted' },
      { ...screenerDeps, maxOutputTokens: 1_200 },
    );
    expect(verdict.flagged).toBe(false);
    expect(verdict.labels).toEqual([]);
    expect(verdict.injectionConfidence).toBe(0);
    expect(verdict.safeRepresentation.summary.length).toBeGreaterThan(0);
    expect(verdict.safeRepresentation.contentType.length).toBeGreaterThan(0);
  });

  it('returns a vision verdict the vision validator accepts', async () => {
    const verdict = await screenImageWithVisionModel(
      { mimeType: 'image/png', dataBase64: TINY_PNG_BASE64 },
      {
        ...screenerDeps,
        model: { provider: 'smoke-stub', model: 'smoke-stub-chat' },
        maxOutputTokens: 1_600,
      },
    );
    expect(verdict.noLegibleText).toBe(true);
    expect(verdict.ocrText).toBe('');
    expect(verdict.flags).toEqual([]);
  });
});
