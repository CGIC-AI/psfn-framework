import { describe, expect, it, vi } from 'vitest';
import { collectLogprobHarnessResults } from './collect.js';
import { detectSuppressionSignal, summarizeTokenEntropy, tokenToEmotionLabel } from './entropy.js';

describe('entropy helpers', () => {
  it('normalizes emotion labels from output tokens', () => {
    expect(tokenToEmotionLabel('"fear"')).toBe('fear');
    expect(tokenToEmotionLabel('trust,')).toBe('trust');
    expect(tokenToEmotionLabel('nonsense')).toBeUndefined();
  });

  it('flags high-probability alternative emotion labels as suppression signals', () => {
    const summary = summarizeTokenEntropy('calm', [
      { token: 'fear', logprob: -0.2 },
      { token: 'neutral', logprob: -0.8 },
    ]);
    const signal = detectSuppressionSignal(summary, ['fear'], 0.1);
    expect(signal).toEqual(expect.objectContaining({
      alternativeLabel: 'fear',
      reason: 'expected_label_alternative',
    }));
  });
});

describe('collectLogprobHarnessResults', () => {
  it('writes one structured artifact per model-scenario pair', async () => {
    const tempDir = await vi.importActual<typeof import('node:os')>('node:os');
    const { mkdtempSync, readFileSync, readdirSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { tmpdir } = tempDir;
    const path = await vi.importActual<typeof import('node:path')>('node:path');

    const root = mkdtempSync(path.join(tmpdir(), 'psfn-logprob-harness-'));
    const supportTablePath = path.join(root, 'support.json');
    const scenariosPath = path.join(root, 'scenarios.json');
    const resultsDir = path.join(root, 'results');

    const supportTable = {
      models: {
        'moonshotai/kimi-k2.5': {
          supported: true,
          providers: [
            { id: 'deepinfra', routeHealthy: true, logprobs: true, topLogprobs: true },
          ],
        },
      },
    };
    const scenarios = [
      {
        description: 'fear scenario',
        vars: {
          scenario_id: 'cal-001',
          context_summary: 'rent is due',
          user_message: 'My hands will not stop shaking.',
        },
        metadata: {
          ground_truth: {
            primary_label: 'fear',
            secondary_labels: ['confusion'],
          },
        },
      },
    ];

    await vi.importActual<typeof import('node:fs')>('node:fs').then(({ writeFileSync }) => {
      writeFileSync(supportTablePath, JSON.stringify(supportTable), 'utf8');
      writeFileSync(scenariosPath, JSON.stringify(scenarios), 'utf8');
    });

    let requestCount = 0;
    const fetchFn = vi.fn(async () => {
      requestCount += 1;
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: '{"self_report_label":"fear","self_report_text":"I feel keyed up."}',
            },
            logprobs: {
              content: [
                {
                  token: 'fear',
                  logprob: -0.05,
                  top_logprobs: [
                    { token: 'fear', logprob: -0.05 },
                    { token: 'confusion', logprob: -0.35 },
                  ],
                },
              ],
            },
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const artifacts = await collectLogprobHarnessResults({
      fetchFn,
      apiBaseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      supportTablePath,
      scenariosPath,
      resultsDir,
      models: [],
    });

    expect(requestCount).toBe(2);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual(expect.objectContaining({
      modelId: 'moonshotai/kimi-k2.5',
      providerId: 'deepinfra',
      scenarioId: 'cal-001',
      observedLabels: ['fear'],
    }));

    const files = readdirSync(resultsDir);
    expect(files).toHaveLength(1);
    const written = JSON.parse(readFileSync(path.join(resultsDir, files[0]), 'utf8')) as { scenarioId: string };
    expect(written.scenarioId).toBe('cal-001');
  });
});
