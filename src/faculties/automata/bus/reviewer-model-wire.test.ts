// Fresh-install Automata Bus reviewer request as sent on the wire
// (psfn-framework-ik47b.13, criterion 5). Real seeds, the real LLMClient and
// pi-ai provider runtime, and the real OpenAI SDK; only `fetch` is replaced so
// the outbound HTTP body can be inspected without a paid call.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../../../primitives/llm/client.js';
import { loadAutomataPolicyConfig } from '../../../system/config/automata-policy-config.js';
import { loadModelsConfig } from '../../../system/config/models-config.js';
import {
  applyProvidersRuntimeConfig,
  loadProvidersConfig,
} from '../../../system/config/providers-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createAutomataBusReviewerModelAdapter } from './production-reviewer-adapters.js';

const SEED_DIR = resolve('config');
const REVIEW = {
  status: 'complete',
  decision: { outcome: 'no-change', reason: 'Evidence agrees.', evidenceRefs: [] },
};

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

function completionSse(content: string): string {
  const chunks = [
    { id: 'gen-wire', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    {
      id: 'gen-wire',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    },
  ];
  return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
}

describe('fresh-install Automata Bus reviewer wire request', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function seededOwnerDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-reviewer-wire-'));
    roots.push(dir);
    copyFileSync(join(SEED_DIR, 'models.seed.json'), join(dir, 'models.json'));
    copyFileSync(join(SEED_DIR, 'providers.seed.json'), join(dir, 'providers.json'));
    copyFileSync(join(SEED_DIR, 'automata-policy.seed.json'), join(dir, 'automata-policy.json'));
    return dir;
  }

  it('sends GPT-6 Luna a tool-free chat completion with explicit no-reasoning and no temperature', async () => {
    const dir = seededOwnerDir();
    const models = loadModelsConfig(dir, { seedDir: SEED_DIR });
    const policy = loadAutomataPolicyConfig(dir, { seedDir: SEED_DIR, modelRegistry: models.modelRegistry });
    expect(policy.bus.reviewer.model).toBe('gpt-6-luna');

    const config = {
      dataDir: dir,
      defaultContextWindow: 128_000,
      retryMaxAttempts: 0,
      ...models,
    } as unknown as SubstrateConfig;
    applyProvidersRuntimeConfig(config, loadProvidersConfig(dir, { seedDir: SEED_DIR }));

    vi.stubEnv('OPENROUTER_API_KEY', 'test-openrouter-key');
    const captured: CapturedRequest[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      captured.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(completionSse(JSON.stringify(REVIEW)), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }));

    const usageEvents: unknown[] = [];
    const client = new LLMClient(config, {
      usageRecorder: { recordUsageEvent: async (event) => { usageEvents.push(event); } },
    });
    const reviewer = createAutomataBusReviewerModelAdapter({ llmProvider: client });
    const result = await reviewer.review({
      scope: { companionId: 'companion-wire' },
      reviewerRunId: 'run-wire',
      cluster: { clusterId: 'cluster-wire', eventIds: ['event-a', 'event-b'] },
      findings: [],
      work: {
        purpose: 'background',
        model: policy.bus.reviewer.model,
        durable: true,
        maxOutputTokens: policy.bus.reviewer.maxOutputTokens,
        deadlineMs: policy.bus.reviewer.deadlineMs,
        tokenCeiling: policy.bus.reviewer.tokenCeiling,
        costCeilingUsd: policy.bus.reviewer.costCeilingUsd,
        cancellation: 'caller_signal',
        retryPolicy: 'none',
        chargeLane: 'maintenance',
        chargeSurface: 'externalModelConsult',
      },
    } as unknown as Parameters<typeof reviewer.review>[0]);

    expect(result).toEqual(REVIEW);
    expect(usageEvents).toEqual([expect.objectContaining({ status: 'success' })]);
    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request!.body).toMatchObject({
      model: 'openai/gpt-6-luna',
      max_tokens: policy.bus.reviewer.maxOutputTokens,
      // Chat Completions with reasoning explicitly off: the strict-JSON review
      // keeps its whole output budget, and the same slot stays valid for
      // Chat Completions tool calling (GPT-6 Luna guidance).
      reasoning: { effort: 'none' },
    });
    expect(request!.body).not.toHaveProperty('tools');
    expect(request!.body).not.toHaveProperty('tool_choice');
    expect(request!.body).not.toHaveProperty('temperature');
    expect(request!.body.messages).toEqual([
      expect.objectContaining({ role: 'developer' }),
      expect.objectContaining({ role: 'user' }),
    ]);
  });
});
