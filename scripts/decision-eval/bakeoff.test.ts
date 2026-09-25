import { describe, expect, it } from 'vitest';
import type { DecisionOutcome } from '../../src/primitives/llm/decision/types.js';
import { QAO_JUDGE_RUBRIC, type QaoJudgeRunArtifact } from '../../tools/evals/eval/companion-shape/qao-judge.js';
import { BAKEOFF_CASES } from './bakeoff-cases.js';
import { createFixtureBackend, runBakeoff, type BakeoffBackend } from './bakeoff.js';
import { buildJevJudgeQuestions, compareJevWithCouncil } from './qao-jev-judge.js';

describe('decision bake-off', () => {
  it('covers every migrated site with labeled cases', () => {
    expect(new Set(BAKEOFF_CASES.map(testCase => testCase.siteId))).toEqual(new Set([
      'participation.appraise', 'room.ambiguity', 'memory.rerank', 'intake.l2',
    ]));
    for (const testCase of BAKEOFF_CASES) {
      expect(Object.keys(testCase.truth).every(name => name in testCase.questions), testCase.id).toBe(true);
    }
  });

  it('runs both backends per case and aggregates accuracy, Brier and model identifiers', async () => {
    const failingJev: BakeoffBackend = {
      id: 'jev',
      model: 'typesafe/jev-1.13',
      decide: async (testCase): Promise<DecisionOutcome> => (testCase.siteId === 'intake.l2'
        ? { ok: false, reason: 'error', backend: 'jev', latencyMs: 3 }
        : { ...(await createFixtureBackend('jev', 0.9).decide(testCase)), backend: 'jev', model: 'typesafe/jev-1.13-20260917' } as DecisionOutcome),
    };
    const artifact = await runBakeoff({
      cases: BAKEOFF_CASES,
      local: createFixtureBackend('fixture-local', 0.7),
      jev: failingJev,
      runId: 'test-run',
      now: () => new Date('2026-09-24T00:00:00.000Z'),
    });
    expect(artifact).toMatchObject({
      artifactType: 'decision_bakeoff',
      runId: 'test-run',
      caseCount: BAKEOFF_CASES.length,
      local: { model: 'fixture:fixture-local' },
      jev: { model: 'typesafe/jev-1.13', answeredBy: ['typesafe/jev-1.13-20260917'] },
    });
    const room = artifact.report.sites.find(site => site.siteId === 'room.ambiguity')!;
    expect(room.calibration?.local.accuracy).toBe(1);
    expect(room.calibration?.local.brier).toBeCloseTo(0.09);
    expect(room.calibration?.jev.brier).toBeCloseTo(0.01);
    const l2 = artifact.report.sites.find(site => site.siteId === 'intake.l2')!;
    expect(l2.jevFailures).toEqual({ error: 2 });
    expect(l2.calibration?.jev.accuracy).toBeNull();
  });
});

describe('Jev as QAO judge', () => {
  it('asks one 0..4 score question per rubric axis', () => {
    const questions = buildJevJudgeQuestions();
    expect(Object.keys(questions)).toEqual(QAO_JUDGE_RUBRIC.axes.map(axis => axis.id));
    expect(questions.voice_continuity).toMatchObject({ type: 'score' });
    expect((questions.voice_continuity as unknown as { criteria: string[] }).criteria).toHaveLength(5);
  });

  it('compares Jev scores with the council mean per axis', () => {
    const council = {
      rubric: QAO_JUDGE_RUBRIC,
      aggregates: {
        byExampleAxis: [
          { exampleId: 'e1', axis: 'voice_continuity', meanScore: 3.5 },
          { exampleId: 'e2', axis: 'voice_continuity', meanScore: 1 },
        ],
        byAxis: [],
      },
    } as unknown as QaoJudgeRunArtifact;
    const score = (value: number): DecisionOutcome => ({
      ok: true, answers: { voice_continuity: { type: 'score', score: value } }, backend: 'jev', probabilitySource: 'jev', latencyMs: 1,
    });
    const [voice] = compareJevWithCouncil(council, new Map([['e1', score(3.9)], ['e2', score(3.1)]]));
    expect(voice).toMatchObject({ axis: 'voice_continuity', compared: 2, exactLevelAgreement: 0.5, passFailAgreement: 0.5 });
    expect(voice?.meanAbsoluteDifference).toBeCloseTo((0.4 + 2.1) / 2);
  });
});
