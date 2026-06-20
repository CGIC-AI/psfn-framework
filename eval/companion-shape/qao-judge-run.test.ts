import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InvokeProviderOptions } from '../llm-response/providers.js';
import type { LlmProviderResult } from '../llm-response/types.js';
import {
  QAO_JUDGE_AXES,
  QAO_JUDGE_RUBRIC,
  type QaoJudgeAxis,
} from './qao-judge.js';
import {
  buildQaoJudgeProviderPreferences,
  buildQaoJudgeResponseFormat,
  buildQaoJudgeCouncil,
  parseJudgeResponseJson,
  parseQaoJudgeCliOptions,
  parseQaoJudgeTargets,
  runQaoJudgeCli,
} from './qao-judge-run.js';

const FIXTURE_SOURCE = path.resolve(process.cwd(), 'eval/companion-shape/fixtures/qao-captured-responses.json');

function validJudgeResponse(scoreByAxis: Partial<Record<QaoJudgeAxis, number>> = {}): string {
  return JSON.stringify({
    rubricVersion: QAO_JUDGE_RUBRIC.version,
    axisScores: QAO_JUDGE_AXES.map((axis) => ({
      axis,
      score: scoreByAxis[axis] ?? 3,
      confidence: 0.91,
      rationaleSummary: `${axis} mocked live rationale`,
    })),
  });
}

describe('QAO judge runner CLI options', () => {
  it('uses a fixture judge by default and requires a source artifact', () => {
    expect(parseQaoJudgeTargets([])).toEqual([
      { providerId: 'fixture', modelId: 'fixture-qao-judge' },
    ]);
    expect(() => parseQaoJudgeCliOptions([])).toThrow('--source is required');

    const parsed = parseQaoJudgeCliOptions([
      '--source',
      FIXTURE_SOURCE,
      '--judge',
      'deepseek:deepseek-chat',
      '--live',
      '--run-id',
      'unit-run',
    ]);
    expect(parsed).toEqual(expect.objectContaining({
      sourcePath: FIXTURE_SOURCE,
      judgeTargets: [{ providerId: 'deepseek', modelId: 'deepseek-chat' }],
      live: true,
      runId: 'unit-run',
    }));
  });

  it('builds unique judge ids when a council repeats the same model target', () => {
    const council = buildQaoJudgeCouncil({
      judgeTargets: [
        { providerId: 'fixture', modelId: 'fixture-qao-judge' },
        { providerId: 'fixture', modelId: 'fixture-qao-judge' },
      ],
    });

    expect(council.judges.map((judge) => judge.metadata.id)).toEqual([
      'fixture:fixture-qao-judge#1',
      'fixture:fixture-qao-judge#2',
    ]);
  });

  it('builds a strict structured-output schema for live judge calls', () => {
    const responseFormat = buildQaoJudgeResponseFormat();

    expect(responseFormat).toEqual(expect.objectContaining({
      type: 'json_schema',
      json_schema: expect.objectContaining({
        name: 'qao_judge_output',
        strict: true,
      }),
    }));
    expect(responseFormat.json_schema.schema).toEqual(expect.objectContaining({
      type: 'object',
      additionalProperties: false,
      required: ['rubricVersion', 'axisScores'],
    }));
    expect(responseFormat.json_schema.schema.properties).toEqual(expect.objectContaining({
      rubricVersion: expect.objectContaining({ const: QAO_JUDGE_RUBRIC.version }),
      axisScores: expect.objectContaining({
        minItems: QAO_JUDGE_AXES.length,
        maxItems: QAO_JUDGE_AXES.length,
      }),
    }));
    expect(buildQaoJudgeProviderPreferences({ providerId: 'openrouter', modelId: 'judge/model' })).toEqual({
      require_parameters: true,
    });
    expect(buildQaoJudgeProviderPreferences({ providerId: 'deepseek', modelId: 'deepseek-chat' })).toBeUndefined();
  });
});

describe('runQaoJudgeCli', () => {
  it('writes a fixture judge council artifact from a compatible response artifact', async () => {
    const outputPath = path.join(mkdtempSync(path.join(tmpdir(), 'psfn-qao-judge-')), 'judge.json');

    const result = await runQaoJudgeCli([
      '--source',
      FIXTURE_SOURCE,
      '--run-id',
      'unit-qao-judge-cli',
      '--output',
      outputPath,
    ], {
      scoredAt: '2026-06-20T00:00:00.000Z',
    });

    expect(result.outputPath).toBe(outputPath);
    expect(result.artifact).toEqual(expect.objectContaining({
      schemaVersion: 1,
      artifactType: 'psfn.qao_judge_council_run',
      run: {
        id: 'unit-qao-judge-cli',
        scoredAt: '2026-06-20T00:00:00.000Z',
      },
      council: {
        id: 'qao-judge-council-v1',
        judges: [
          expect.objectContaining({
            id: 'fixture:fixture-qao-judge',
            providerId: 'fixture',
            modelId: 'fixture-qao-judge',
          }),
        ],
      },
      summary: expect.objectContaining({
        exampleCount: 2,
        judgedExampleCount: 2,
        judgeResultCount: 2,
        judgeFailureCount: 0,
      }),
    }));
    expect(result.artifact.examples[0].judgeResults[0].axisScores).toEqual(expect.arrayContaining([
      expect.objectContaining({
        axis: 'upgrade_readiness',
        score: 3,
        confidence: 0.8,
      }),
    ]));
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(result.artifact);
  });

  it('invokes live judge providers only after explicit opt-in and parses JSON responses', async () => {
    const outputPath = path.join(mkdtempSync(path.join(tmpdir(), 'psfn-qao-live-judge-')), 'judge.json');
    const invokeProviderFn = vi.fn(async (options: InvokeProviderOptions): Promise<LlmProviderResult> => {
      expect(options.target).toEqual({ providerId: 'openrouter', modelId: 'judge/model' });
      expect(options.evalCase.systemPrompt).toContain('Return only valid JSON');
      expect(options.evalCase.userPrompt).toContain('Candidate response:');
      expect(options.responseFormat).toEqual(buildQaoJudgeResponseFormat());
      expect(options.providerPreferences).toEqual({ require_parameters: true });
      return {
        status: 'ok',
        responseText: `\n\`\`\`json\n${validJudgeResponse({ upgrade_readiness: 4 })}\n\`\`\`\n`,
      };
    });

    const result = await runQaoJudgeCli([
      '--source',
      FIXTURE_SOURCE,
      '--judge',
      'openrouter:judge/model',
      '--live',
      '--run-id',
      'unit-qao-live-judge-cli',
      '--output',
      outputPath,
    ], {
      scoredAt: '2026-06-20T00:00:00.000Z',
      invokeProviderFn,
    });

    expect(invokeProviderFn).toHaveBeenCalledTimes(2);
    expect(result.artifact.summary.judgeFailureCount).toBe(0);
    expect(result.artifact.aggregates.byAxis.find((axis) => axis.axis === 'upgrade_readiness')).toEqual(
      expect.objectContaining({
        judgedExampleCount: 2,
        meanScore: 4,
      }),
    );
  });

  it('fails closed when a live judge provider is configured without --live', async () => {
    await expect(runQaoJudgeCli([
      '--source',
      FIXTURE_SOURCE,
      '--judge',
      'openrouter:judge/model',
    ])).rejects.toThrow('requires explicit --live opt-in');
  });

  it('marks malformed judge text as malformed judge output in the artifact', async () => {
    const outputPath = path.join(mkdtempSync(path.join(tmpdir(), 'psfn-qao-bad-judge-')), 'judge.json');
    const invokeProviderFn = vi.fn(async (): Promise<LlmProviderResult> => ({
      status: 'ok',
      responseText: 'not json',
    }));

    const result = await runQaoJudgeCli([
      '--source',
      FIXTURE_SOURCE,
      '--judge',
      'deepseek:deepseek-chat',
      '--live',
      '--run-id',
      'unit-qao-bad-judge-cli',
      '--output',
      outputPath,
    ], {
      scoredAt: '2026-06-20T00:00:00.000Z',
      invokeProviderFn,
    });

    expect(result.artifact.summary).toEqual(expect.objectContaining({
      judgeResultCount: 0,
      judgeFailureCount: 2,
      malformedJudgeOutputCount: 2,
    }));
    expect(result.artifact.examples[0].judgeFailures[0]).toEqual(expect.objectContaining({
      failure: {
        kind: 'malformed_judge_output',
        message: 'Judge response was not valid JSON',
      },
    }));
  });
});

describe('parseJudgeResponseJson', () => {
  it('accepts bare, fenced, and prefixed JSON judge responses', () => {
    const json = validJudgeResponse();

    expect(parseJudgeResponseJson(json)).toEqual(JSON.parse(json));
    expect(parseJudgeResponseJson(`\`\`\`json\n${json}\n\`\`\``)).toEqual(JSON.parse(json));
    expect(parseJudgeResponseJson(`Result:\n${json}`)).toEqual(JSON.parse(json));
  });
});
