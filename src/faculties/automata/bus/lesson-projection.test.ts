import { describe, expect, it } from 'vitest';

import type { AutomataLessonSourceFinding } from './lesson-projection.js';
import {
  AutomataLessonProjectionService,
  projectAutomataLessons,
} from './lesson-projection.js';

const baseFinding = {
  companionId: 'companion-a',
  eventId: 'finding-1',
  automatonClass: 'subagent.bounded',
  promptRevision: 'sha256:prompt-r1',
  toolName: 'repo',
  failureCategory: 'missing-instruction',
  lessonCode: 'repo-read-before-edit',
  provenance: 'computed',
  verificationStatus: 'verified',
  evidenceRefs: ['file:///private/transcripts/run-1.jsonl#turn=9'],
  audiences: ['operator'],
  sensitivity: 'personal',
  contradictionEventIds: [],
} as const satisfies AutomataLessonSourceFinding;

describe('projectAutomataLessons', () => {
  it('groups recurrent findings across the requested dimensions and exposes only redacted trace IDs', () => {
    const projection = projectAutomataLessons([
      baseFinding,
      {
        ...baseFinding,
        eventId: 'finding-2',
        evidenceRefs: ['session://private-partner-conversation/turn-4'],
      },
    ], { minimumSupport: 2, maxGroups: 10, maxSourcesPerGroup: 10 });

    expect(projection.groups).toEqual([
      expect.objectContaining({
        automatonClass: 'subagent.bounded',
        promptRevision: 'sha256:prompt-r1',
        toolName: 'repo',
        failureCategory: 'missing-instruction',
        lessonCode: 'repo-read-before-edit',
        sourceCount: 2,
        support: 'supported',
        evidenceQuality: 'verified',
        sourceFindingIds: ['finding-1', 'finding-2'],
        evidenceIds: [
          expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        ],
        interpretation: 'candidate-pattern-not-verified-defect',
      }),
    ]);
    expect(JSON.stringify(projection)).not.toContain('file:///private');
    expect(JSON.stringify(projection)).not.toContain('private-partner-conversation');
  });

  it('visibly qualifies low support, contradictions, and model inference', () => {
    const projection = projectAutomataLessons([
      {
        ...baseFinding,
        provenance: 'recalled',
        verificationStatus: 'pending',
        contradictionEventIds: ['finding-contradiction'],
      },
    ], { minimumSupport: 2, maxGroups: 10, maxSourcesPerGroup: 10 });

    expect(projection.groups[0]).toMatchObject({
      sourceCount: 1,
      support: 'low-support',
      evidenceQuality: 'unverified',
      contradiction: {
        present: true,
        sourceFindingIds: ['finding-contradiction'],
      },
      inferenceOnly: true,
      interpretation: 'candidate-pattern-not-verified-defect',
    });
  });

  it('keeps verified and unverified evidence quality in separate groups', () => {
    const projection = projectAutomataLessons([
      baseFinding,
      { ...baseFinding, eventId: 'finding-pending', verificationStatus: 'pending' },
    ], { minimumSupport: 2, maxGroups: 10, maxSourcesPerGroup: 10 });

    expect(projection.groups).toHaveLength(2);
    expect(projection.groups.map(group => group.evidenceQuality).sort())
      .toEqual(['unverified', 'verified']);
    expect(projection.groups.every(group => group.support === 'low-support')).toBe(true);
  });

  it('fails closed on companion, audience, and sensitivity scope violations', () => {
    const policy = { minimumSupport: 2, maxGroups: 10, maxSourcesPerGroup: 10 };
    expect(() => projectAutomataLessons([
      { ...baseFinding, companionId: 'companion-b' },
    ], policy, { companionId: 'companion-a', audience: 'operator', maxSensitivity: 'confidential' }))
      .toThrow(/cross-companion/);
    expect(() => projectAutomataLessons([
      { ...baseFinding, audiences: ['eligible-automata'] },
    ], policy, { companionId: 'companion-a', audience: 'operator', maxSensitivity: 'confidential' }))
      .toThrow(/outside.*audience/);
    expect(() => projectAutomataLessons([
      { ...baseFinding, sensitivity: 'confidential' },
    ], policy, { companionId: 'companion-a', audience: 'operator', maxSensitivity: 'personal' }))
      .toThrow(/outside.*sensitivity/);
  });

  it('recomputes from current sources after correction, supersession, or retraction without retaining stale history', async () => {
    let current: AutomataLessonSourceFinding[] = [
      baseFinding,
      { ...baseFinding, eventId: 'finding-2', evidenceRefs: ['artifact://second'] },
    ];
    const service = new AutomataLessonProjectionService({
      source: { listCurrent: async () => current },
      policy: { minimumSupport: 2, maxGroups: 10, maxSourcesPerGroup: 10 },
    });

    expect((await service.query({
      companionId: 'companion-a', audience: 'operator', maxSensitivity: 'confidential',
    })).groups[0]?.sourceFindingIds).toEqual(['finding-1', 'finding-2']);

    current = [{
      ...baseFinding,
      eventId: 'correction-3',
      promptRevision: 'sha256:prompt-r2',
      lessonCode: 'use-new-review-path',
      evidenceRefs: ['artifact://corrected'],
    }];
    const corrected = await service.query({
      companionId: 'companion-a', audience: 'operator', maxSensitivity: 'confidential',
    });

    expect(corrected.groups).toHaveLength(1);
    expect(corrected.groups[0]).toMatchObject({
      promptRevision: 'sha256:prompt-r2',
      lessonCode: 'use-new-review-path',
      sourceFindingIds: ['correction-3'],
      support: 'low-support',
    });
    expect(JSON.stringify(corrected)).not.toContain('finding-1');
    expect(JSON.stringify(corrected)).not.toContain('finding-2');
  });
});
