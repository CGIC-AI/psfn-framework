import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_LLM_RESPONSE_CASES } from './cases.js';
import { collectLlmResponses, projectCompanionShapeResponseSet } from './harness.js';
import { invokeProvider } from './providers.js';
import { redactSecrets } from './redaction.js';
import { parseTarget, parseTargets } from './targets.js';
import type { LlmProviderResult } from './types.js';

describe('target parsing', () => {
  it('parses provider:model targets and defaults to the fixture provider', () => {
    expect(parseTarget('openrouter:openai/gpt-4.1-mini')).toEqual({
      providerId: 'openrouter',
      modelId: 'openai/gpt-4.1-mini',
    });
    expect(parseTargets([])).toEqual([
      { providerId: 'fixture', modelId: 'fixture-response-model' },
    ]);
  });

  it('fails closed for unknown providers and malformed target syntax', () => {
    expect(() => parseTarget('unknown:model')).toThrow('Unknown LLM response provider');
    expect(() => parseTarget('openrouter')).toThrow('provider:model');
  });
});

describe('collectLlmResponses', () => {
  it('captures fixture artifacts with metadata, raw response refs, and companion-shape projection', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'psfn-llm-response-'));

    const artifact = await collectLlmResponses({
      runId: 'unit-fixture',
      targets: [{ providerId: 'fixture', modelId: 'fixture-response-model' }],
      cases: CANONICAL_LLM_RESPONSE_CASES,
      outputDir,
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    expect(artifact).toEqual(expect.objectContaining({
      schemaVersion: 1,
      artifactType: 'psfn.llm_response_run',
      run: expect.objectContaining({
        id: 'unit-fixture',
        targetCount: 1,
        caseCount: 4,
        liveProvidersEnabled: false,
      }),
      summary: {
        total: 4,
        ok: 3,
        failed: 1,
        failuresByKind: { provider_error: 1 },
      },
    }));
    expect(artifact.responses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        caseId: 'chat-direct-answer',
        providerId: 'fixture',
        modelId: 'fixture-response-model',
        status: 'ok',
        stopReason: 'fixture_stop',
        tokenUsage: expect.objectContaining({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) }),
        response: expect.objectContaining({
          body: expect.stringContaining('response eval harness'),
          bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          rawResponseRef: expect.stringContaining('raw-responses'),
        }),
      }),
      expect.objectContaining({
        caseId: 'provider-error-shape',
        status: 'failed',
        failure: expect.objectContaining({ kind: 'provider_error' }),
      }),
    ]));

    const rawFiles = readdirSync(path.join(outputDir, 'raw-responses'));
    expect(rawFiles).toHaveLength(4);
    const rawFixture = readFileSync(path.join(outputDir, 'raw-responses', rawFiles[0]), 'utf8');
    expect(rawFixture).toContain('"fixture": true');

    const projected = projectCompanionShapeResponseSet(artifact);
    expect(projected.responses).toHaveLength(3);
    expect(projected.responses[0]).toEqual(expect.objectContaining({
      scenarioId: expect.any(String),
      providerId: 'fixture',
      response: expect.any(String),
    }));
  });

  it('records provider failures per case without dropping target coverage', async () => {
    const failureResult: LlmProviderResult = {
      status: 'failed',
      failure: {
        kind: 'malformed_response',
        message: 'Provider response did not contain choices',
      },
      sanitizedRawResponse: {
        choices: [],
      },
    };
    const invokeProviderFn = vi.fn(async () => failureResult);

    const artifact = await collectLlmResponses({
      runId: 'unit-failure',
      targets: [{ providerId: 'fixture', modelId: 'fixture-response-model' }],
      cases: CANONICAL_LLM_RESPONSE_CASES.slice(0, 2),
      invokeProviderFn,
    });

    expect(invokeProviderFn).toHaveBeenCalledTimes(2);
    expect(artifact.responses).toHaveLength(2);
    expect(artifact.summary).toEqual({
      total: 2,
      ok: 0,
      failed: 2,
      failuresByKind: { malformed_response: 2 },
    });
  });

  it('requires explicit opt-in for live providers', async () => {
    await expect(collectLlmResponses({
      runId: 'unit-live-closed',
      targets: [{ providerId: 'openrouter', modelId: 'openai/gpt-4.1-mini' }],
      cases: CANONICAL_LLM_RESPONSE_CASES.slice(0, 1),
    })).rejects.toThrow('requires explicit --live opt-in');
  });
});

describe('provider validation and redaction', () => {
  it('fails closed on malformed OpenAI-compatible provider responses', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    const result = await invokeProvider({
      target: { providerId: 'openrouter', modelId: 'openai/gpt-4.1-mini' },
      evalCase: CANONICAL_LLM_RESPONSE_CASES[0],
      env: { OPENROUTER_API_KEY: 'sk-or-unit-secret' },
      fetchFn,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'failed',
      failure: expect.objectContaining({ kind: 'malformed_response' }),
    }));
  });

  it('redacts explicit and patterned secrets recursively', () => {
    const redacted = redactSecrets({
      header: 'Bearer sk-or-unit-secret',
      nested: {
        url: 'https://example.test/v1?api_key=sk-test-secret-token',
        body: 'value sk-or-unit-secret value',
      },
    }, [{ label: 'OPENROUTER_API_KEY', value: 'sk-or-unit-secret' }]);

    expect(JSON.stringify(redacted)).not.toContain('sk-or-unit-secret');
    expect(JSON.stringify(redacted)).not.toContain('sk-test-secret-token');
    expect(redacted).toEqual({
      header: 'Bearer [REDACTED:OPENROUTER_API_KEY]',
      nested: {
        url: 'https://example.test/v1?api_key=[REDACTED:query-secret]',
        body: 'value [REDACTED:OPENROUTER_API_KEY] value',
      },
    });
  });
});
