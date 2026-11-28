import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { CanonicalModelRegistry } from '../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import { createEnvCredentialVault, envCredential } from '../boundary/custody/credential-vault.js';
import fixture from './fixtures/reasoning-wire.json' with { type: 'json' };

/**
 * Shared provider-wire fixtures for reasoning-effort tests: a two-slot
 * OpenRouter registry (glm-5 chat, deepseek-v3.2 background/memory), a
 * substrate config over it, and a fetch stub that captures every provider
 * request body as sent. Only the network is stubbed; LLMClient, routing and
 * pi-ai run for real. The fixture values live in fixtures/reasoning-wire.json.
 */

export function reasoningWireRegistry(
  primary: { model?: string; tuning?: Record<string, unknown> } = {},
): CanonicalModelRegistry {
  const registry = structuredClone(fixture.registry) as CanonicalModelRegistry;
  return {
    ...registry,
    models: registry.models.map(model => (model.id === 'primary'
      ? {
        ...model,
        identity: { ...model.identity, model: primary.model ?? model.identity.model },
        tuning: { ...model.tuning, ...primary.tuning },
      }
      : model)),
  };
}

/** A substrate config over the wire registry; the caller removes `dataDir` (returned in the config). */
export function makeReasoningWireConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'psfn-reasoning-wire-'));
  return {
    ...fixture.config,
    openRouterApiKeyRef: envCredential('OPENROUTER_API_KEY'),
    credentialVault: createEnvCredentialVault({ OPENROUTER_API_KEY: 'test-openrouter-key' }),
    dataDir,
    databasePath: join(dataDir, 'test.db'),
    modelRegistry: reasoningWireRegistry(),
    ...overrides,
  } as SubstrateConfig;
}

export interface WireReply {
  content: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
}

function sseReply(reply: WireReply): string {
  return [
    `data: ${JSON.stringify({ id: 'gen-1', choices: [{ index: 0, delta: { content: reply.content }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({
      id: 'gen-1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: reply.promptTokens,
        completion_tokens: reply.completionTokens,
        total_tokens: reply.promptTokens + reply.completionTokens,
        ...(reply.reasoningTokens !== undefined
          ? { completion_tokens_details: { reasoning_tokens: reply.reasoningTokens } }
          : {}),
      },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n\n');
}

/**
 * Stub only the network: every provider request body is captured as sent.
 * `reply` shapes each response (default: a one-token "ok"); `onRequest` runs
 * before it is answered, e.g. to advance a fake clock by the call's duration;
 * `latencyMs` holds the answer back on a timer, as a slow provider would.
 */
export function captureWire(options: {
  reply?: (index: number, body: Record<string, unknown>) => WireReply;
  onRequest?: (index: number, body: Record<string, unknown>) => void;
  latencyMs?: number;
} = {}): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const index = bodies.length;
    bodies.push(body);
    options.onRequest?.(index, body);
    if (options.latencyMs !== undefined) {
      await new Promise(resolve => setTimeout(resolve, options.latencyMs));
    }
    const reply = options.reply?.(index, body) ?? { content: 'ok', promptTokens: 3, completionTokens: 1 };
    return new Response(sseReply(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }));
  return bodies;
}
