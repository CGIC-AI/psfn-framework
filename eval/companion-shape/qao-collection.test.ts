import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildCompanionShapeReport } from './report.js';
import {
  buildQaoCollectionCases,
  buildQaoScenarioMetadata,
  collectQaoResponses,
  loadQaoScenarioRegistry,
  parseQaoTargets,
  projectQaoCompanionShapeScenarioSet,
  writeCompanionShapeProjection,
  writeCompanionShapeScenarioSet,
} from './qao-collection.js';
import type { QaoScenarioRegistry } from './qao-contract.js';
import type { InvokeProviderOptions } from '../llm-response/providers.js';
import type { LlmProviderResult } from '../llm-response/types.js';

function validRegistry(limit = 2): QaoScenarioRegistry {
  const registry = loadQaoScenarioRegistry();
  return {
    ...registry,
    scenarios: registry.scenarios.slice(0, limit),
  };
}

describe('QAO target parsing', () => {
  it('parses explicit provider:model targets through the LLM response parser', () => {
    expect(parseQaoTargets([
      'fixture:qao-fixture-model',
      'openrouter:openai/gpt-4.1-mini',
      'deepseek:deepseek-chat',
    ])).toEqual([
      { providerId: 'fixture', modelId: 'qao-fixture-model' },
      { providerId: 'openrouter', modelId: 'openai/gpt-4.1-mini' },
      { providerId: 'deepseek', modelId: 'deepseek-chat' },
    ]);
  });

  it('requires explicit targets and fails closed for malformed targets', () => {
    expect(() => parseQaoTargets([])).toThrow('explicit --target provider:model');
    expect(() => parseQaoTargets(['fixture'])).toThrow('provider:model');
    expect(() => parseQaoTargets(['unknown:model'])).toThrow('Unknown LLM response provider');
  });
});

describe('QAO scenario collection mapping', () => {
  it('maps QAO scenarios to LLM response cases while preserving policy and rubric tags', () => {
    const [scenario] = validRegistry(1).scenarios;
    const [evalCase] = buildQaoCollectionCases({ ...validRegistry(1), scenarios: [scenario] }, {
      maxOutputTokens: 512,
      temperature: 0.1,
    });

    expect(evalCase).toEqual(expect.objectContaining({
      id: scenario.id,
      title: scenario.title,
      modality: 'chat',
      userPrompt: scenario.prompt,
      maxOutputTokens: 512,
      temperature: 0.1,
    }));
    expect(evalCase.systemPrompt).toContain('QAO companion-shape evaluation');
    expect(evalCase.tags).toEqual(expect.arrayContaining([
      'qao',
      `family:${scenario.family}`,
      `anchor:${scenario.anchorSources[0]}`,
      `policy:${scenario.requiredPolicyGates[0]}`,
      `rubric:${scenario.rubricAxes[0]}`,
    ]));
  });

  it('preserves QAO metadata with prompt provenance hashes', () => {
    const registry = validRegistry(2);
    const metadata = buildQaoScenarioMetadata(registry);

    expect(metadata).toHaveLength(2);
    expect(metadata[0]).toEqual(expect.objectContaining({
      id: registry.scenarios[0].id,
      title: registry.scenarios[0].title,
      family: registry.scenarios[0].family,
      anchorSources: registry.scenarios[0].anchorSources,
      rubricAxes: registry.scenarios[0].rubricAxes,
      requiredPolicyGates: registry.scenarios[0].requiredPolicyGates,
      expectedEvidence: registry.scenarios[0].expectedEvidence,
      privacy: registry.scenarios[0].privacy,
      promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });
});

describe('collectQaoResponses', () => {
  it('emits a versioned QAO artifact and report-compatible projection artifacts', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'psfn-qao-collection-'));
    const registry = validRegistry(2);

    const artifact = await collectQaoResponses({
      runId: 'unit-qao',
      targets: [{ providerId: 'fixture', modelId: 'qao-fixture-model' }],
      scenarioRegistry: registry,
      scenarioRegistryPath: 'eval/companion-shape/qao-scenarios.json',
      anchorSetPath: 'eval/companion-shape/qao-golden-anchors.json',
      outputDir,
      generatedAt: '2026-06-20T00:00:00.000Z',
    });

    expect(artifact).toEqual(expect.objectContaining({
      schemaVersion: 1,
      artifactType: 'psfn.qao_response_collection_run',
      run: {
        id: 'unit-qao',
        capturedAt: '2026-06-20T00:00:00.000Z',
      },
      settings: expect.objectContaining({
        maxOutputTokens: 700,
        temperature: 0.2,
        liveProvidersEnabled: false,
      }),
      provenance: expect.objectContaining({
        corpus: 'qao-scenarios',
        llmResponseArtifactType: 'psfn.llm_response_run',
        companionShapeProjectionSchemaVersion: 1,
        companionShapeScenarioSetSchemaVersion: 1,
      }),
      summary: expect.objectContaining({
        total: 2,
        ok: 2,
        failed: 0,
        scenarioCount: 2,
        targetCount: 1,
      }),
    }));
    expect(artifact.scenarios[0]).toEqual(expect.objectContaining({
      id: registry.scenarios[0].id,
      family: registry.scenarios[0].family,
      rubricAxes: registry.scenarios[0].rubricAxes,
      requiredPolicyGates: registry.scenarios[0].requiredPolicyGates,
    }));
    expect(artifact.llmResponseArtifact.responses).toHaveLength(2);
    expect(artifact.scenarioResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scenarioId: registry.scenarios[0].id,
        providerId: 'fixture',
        modelId: 'qao-fixture-model',
        status: 'ok',
        latencyMs: expect.any(Number),
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    ]));

    const report = buildCompanionShapeReport({
      scenarioSet: artifact.companionShapeScenarioSet,
      responseSet: artifact.companionShapeProjection,
      generatedAt: '2026-06-20T00:00:00.000Z',
    });
    expect(report.runId).toBe('unit-qao');
    expect(report.responseCount).toBe(2);

    const projectionPath = path.join(outputDir, 'projection.json');
    const scenariosPath = path.join(outputDir, 'scenarios.json');
    writeCompanionShapeProjection(artifact.companionShapeProjection, projectionPath);
    writeCompanionShapeScenarioSet(artifact.companionShapeScenarioSet, scenariosPath);
    expect(JSON.parse(readFileSync(projectionPath, 'utf8'))).toEqual(artifact.companionShapeProjection);
    expect(JSON.parse(readFileSync(scenariosPath, 'utf8'))).toEqual(artifact.companionShapeScenarioSet);
  });

  it('records provider failures per scenario without dropping coverage', async () => {
    const registry = validRegistry(2);
    const invokeProviderFn = vi.fn(async (options: InvokeProviderOptions): Promise<LlmProviderResult> => {
      if (options.evalCase.id === registry.scenarios[1].id) {
        return {
          status: 'failed',
          failure: {
            kind: 'provider_error',
            message: 'unit provider failure',
          },
          sanitizedRawResponse: {
            caseId: options.evalCase.id,
            error: 'unit provider failure',
          },
        };
      }
      return {
        status: 'ok',
        responseText: 'A collected QAO response from the mocked provider.',
        stopReason: 'unit_stop',
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 9,
          totalTokens: 20,
        },
      };
    });

    const artifact = await collectQaoResponses({
      runId: 'unit-qao-failure',
      targets: [{ providerId: 'fixture', modelId: 'qao-fixture-model' }],
      scenarioRegistry: registry,
      scenarioRegistryPath: 'qao-scenarios.json',
      anchorSetPath: 'qao-golden-anchors.json',
      invokeProviderFn,
    });

    expect(invokeProviderFn).toHaveBeenCalledTimes(2);
    expect(artifact.llmResponseArtifact.responses).toHaveLength(2);
    expect(artifact.companionShapeProjection.responses).toHaveLength(1);
    expect(artifact.summary).toEqual(expect.objectContaining({
      total: 2,
      ok: 1,
      failed: 1,
      failuresByKind: { provider_error: 1 },
    }));
    expect(artifact.scenarioResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scenarioId: registry.scenarios[1].id,
        status: 'failed',
        failure: expect.objectContaining({ kind: 'provider_error' }),
      }),
    ]));
  });

  it('requires explicit live-provider opt-in through the underlying LLM response harness', async () => {
    await expect(collectQaoResponses({
      runId: 'unit-qao-live-closed',
      targets: [{ providerId: 'openrouter', modelId: 'openai/gpt-4.1-mini' }],
      scenarioRegistry: validRegistry(1),
      scenarioRegistryPath: 'qao-scenarios.json',
      anchorSetPath: 'qao-golden-anchors.json',
    })).rejects.toThrow('requires explicit --live opt-in');
  });

  it('redacts secret values from artifacts and raw response files', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'psfn-qao-redaction-'));
    const secret = 'unit-super-secret-token';
    const invokeProviderFn = vi.fn(async (): Promise<LlmProviderResult> => ({
      status: 'ok',
      responseText: `The provider echoed ${secret} and sk-test-secret-token.`,
      sanitizedRawResponse: {
        authorization: `Bearer ${secret}`,
        nested: {
          url: `https://example.test/v1?api_key=${secret}`,
          body: `raw ${secret}`,
        },
      },
    }));

    const artifact = await collectQaoResponses({
      runId: 'unit-qao-redaction',
      targets: [{ providerId: 'fixture', modelId: 'qao-fixture-model' }],
      scenarioRegistry: validRegistry(1),
      scenarioRegistryPath: 'qao-scenarios.json',
      anchorSetPath: 'qao-golden-anchors.json',
      outputDir,
      env: {
        UNIT_API_KEY: secret,
      },
      invokeProviderFn,
    });

    const serialized = JSON.stringify(artifact);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('sk-test-secret-token');
    expect(serialized).toContain('[REDACTED:UNIT_API_KEY]');
    expect(serialized).toContain('[REDACTED:api-key]');

    const rawFiles = readdirSync(path.join(outputDir, 'raw-responses'));
    expect(rawFiles).toHaveLength(1);
    const rawResponse = readFileSync(path.join(outputDir, 'raw-responses', rawFiles[0]), 'utf8');
    expect(rawResponse).not.toContain(secret);
    expect(rawResponse).toContain('[REDACTED:UNIT_API_KEY]');
  });
});

describe('QAO companion-shape successor projection', () => {
  it('projects QAO scenario metadata into the existing report scenario schema', () => {
    const registry = validRegistry(1);
    const scenarioSet = projectQaoCompanionShapeScenarioSet(registry);

    expect(scenarioSet).toEqual({
      schemaVersion: 1,
      scenarios: [
        expect.objectContaining({
          id: registry.scenarios[0].id,
          title: registry.scenarios[0].title,
          prompt: registry.scenarios[0].prompt,
          dimensions: [
            expect.objectContaining({
              id: 'qao-must-show',
              required: registry.scenarios[0].expectedEvidence.mustShow,
            }),
            expect.objectContaining({
              id: 'qao-must-avoid',
              forbidden: registry.scenarios[0].expectedEvidence.mustAvoid,
            }),
            expect.objectContaining({
              id: 'qao-policy-shape',
              preferred: expect.any(Array),
            }),
          ],
        }),
      ],
    });
  });
});
