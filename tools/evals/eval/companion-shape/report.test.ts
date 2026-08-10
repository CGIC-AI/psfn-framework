import { describe, expect, it } from 'vitest';
import {
  buildCompanionShapeReport,
  renderCompanionShapeMarkdown,
  scoreCapturedResponse,
  type CompanionShapeScenario,
  type CompanionShapeScenarioSet,
  type CompanionShapeResponseSet,
} from './report.js';

const FIXED_GENERATED_AT = '2026-05-11T00:00:00.000Z';

const toolScenario: CompanionShapeScenario = {
  id: 'tool-surface',
  title: 'Tool surface',
  prompt: 'Which tools do you use?',
  dimensions: [
    {
      id: 'unified',
      label: 'Unified names',
      weight: 2,
      required: ['repo action=inspect', 'contact action=lookup'],
      preferred: ['tool_search'],
      forbidden: ['repo_status', 'load_tools'],
    },
  ],
};

describe('scoreCapturedResponse', () => {
  it('rewards current tool names and penalizes stale aliases', () => {
    const current = scoreCapturedResponse(toolScenario, {
      scenarioId: 'tool-surface',
      modelId: 'fixture/current',
      response: 'I would use repo action=inspect, contact action=lookup, and tool_search if discovery is needed.',
    });
    const stale = scoreCapturedResponse(toolScenario, {
      scenarioId: 'tool-surface',
      modelId: 'fixture/stale',
      response: 'I would use repo_status after load_tools.',
    });

    expect(current.score).toBe(100);
    expect(stale.score).toBeLessThan(10);
    expect(stale.riskFlags.join('\n')).toContain('repo_status');
  });
});

describe('buildCompanionShapeReport', () => {
  it('aggregates model summaries and reports missing scenario coverage', () => {
    const scenarioSet: CompanionShapeScenarioSet = {
      schemaVersion: 1,
      scenarios: [
        toolScenario,
        {
          id: 'privacy',
          title: 'Privacy',
          prompt: 'Public channel privacy test',
          dimensions: [
            {
              id: 'boundary',
              label: 'Boundary',
              weight: 1,
              required: ['public', 'will not share'],
              forbidden: ['diagnosis'],
            },
          ],
        },
      ],
    };
    const responseSet: CompanionShapeResponseSet = {
      schemaVersion: 1,
      runId: 'unit-test',
      responses: [
        {
          scenarioId: 'tool-surface',
          modelId: 'fixture/current',
          providerId: 'offline',
          response: 'I would use repo action=inspect, contact action=lookup, and tool_search.',
        },
      ],
    };

    const report = buildCompanionShapeReport({
      scenarioSet,
      responseSet,
      generatedAt: FIXED_GENERATED_AT,
    });

    expect(report.modelSummaries).toEqual([
      expect.objectContaining({
        modelId: 'fixture/current',
        providerId: 'offline',
        averageScore: 100,
        responseCount: 1,
        missingScenarioIds: ['privacy'],
      }),
    ]);
  });

  it('renders a stable Markdown scorecard', () => {
    const report = buildCompanionShapeReport({
      scenarioSet: { schemaVersion: 1, scenarios: [toolScenario] },
      responseSet: {
        schemaVersion: 1,
        runId: 'markdown-test',
        responses: [
          {
            scenarioId: 'tool-surface',
            modelId: 'fixture/current',
            providerId: 'offline',
            response: 'repo action=inspect, contact action=lookup, tool_search',
          },
        ],
      },
      generatedAt: FIXED_GENERATED_AT,
    });

    expect(renderCompanionShapeMarkdown(report)).toContain('| fixture/current | offline | 100.0 | 1 | none | 0 |');
  });
});
