import { describe, expect, it, vi } from 'vitest';

import {
  AutomataLessonProposalService,
  type GovernedAutomataLessonReviewPort,
} from './lesson-proposal.js';
import type { AutomataLessonGroup } from './lesson-projection.js';

const group: AutomataLessonGroup = {
  groupId: `automata-lesson:v1:${'a'.repeat(64)}`,
  automatonClass: 'subagent.bounded',
  promptRevision: 'sha256:prompt-r1',
  toolName: 'repo',
  failureCategory: 'missing-instruction',
  lessonCode: 'repo-read-before-edit',
  sourceCount: 3,
  support: 'supported',
  evidenceQuality: 'verified',
  sourceFindingIds: ['finding-1', 'finding-2', 'finding-3'],
  evidenceIds: [`sha256:${'b'.repeat(64)}`],
  sourceTraceTruncated: false,
  contradiction: { present: false, sourceFindingIds: [] },
  inferenceOnly: false,
  interpretation: 'candidate-pattern-not-verified-defect',
};

describe('AutomataLessonProposalService', () => {
  it('prepares a diff-only package for the existing governed review route without submitting or mutating', () => {
    const propose = vi.fn();
    const service = new AutomataLessonProposalService({
      review: { propose } as GovernedAutomataLessonReviewPort,
      policy: { maxChangeChars: 2_000, maxSourceIds: 10 },
    });

    const prepared = service.prepare({
      group,
      target: { kind: 'instruction', id: 'memory.extraction', baseRevision: 'sha256:prompt-r1' },
      before: 'Inspect the task.',
      after: 'Inspect the task.\nRead relevant files before editing.',
      rationaleCode: 'recurrent-supported-finding',
    });

    expect(propose).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({
      status: 'prepared-not-submitted',
      reviewPath: '/api/admin/shared-workspace/proposals',
      request: {
        artifactPath: expect.stringMatching(/^automata\/lesson-proposals\/[0-9a-f]{64}\.json$/u),
        mediaType: 'application/json',
        provenance: expect.stringContaining(group.groupId),
      },
    });
    const artifact = JSON.parse(prepared.request.content) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      kind: 'automata_lesson_change_proposal',
      state: 'review_required',
      target: { kind: 'instruction', id: 'memory.extraction', baseRevision: 'sha256:prompt-r1' },
      source: {
        groupId: group.groupId,
        sourceFindingIds: group.sourceFindingIds,
        evidenceIds: group.evidenceIds,
        interpretation: 'candidate-pattern-not-verified-defect',
      },
    });
    expect(artifact).toHaveProperty('diff', expect.stringContaining('+Read relevant files before editing.'));
  });

  it('submits only to the governed review port and returns its pending review receipt', async () => {
    const propose = vi.fn(async () => ({ reviewId: 'review-1', status: 'pending' as const }));
    const service = new AutomataLessonProposalService({
      review: { propose },
      policy: { maxChangeChars: 2_000, maxSourceIds: 10 },
    });
    const prepared = service.prepare({
      group,
      target: { kind: 'tool', id: 'repo', baseRevision: 'sha256:tool-r4' },
      before: 'Repository operations.',
      after: 'Repository operations. Read before edits.',
      rationaleCode: 'recurrent-supported-finding',
    });

    await expect(service.submitForReview(prepared)).resolves.toEqual({
      reviewId: 'review-1',
      status: 'pending',
    });
    expect(propose).toHaveBeenCalledExactlyOnceWith(prepared.request);
  });

  it('refuses contradicted, low-support, inference-only, or unverified sources', () => {
    const service = new AutomataLessonProposalService({
      review: { propose: vi.fn() },
      policy: { maxChangeChars: 2_000, maxSourceIds: 10 },
    });
    const input = {
      target: { kind: 'instruction' as const, id: 'memory.extraction', baseRevision: 'sha256:r1' },
      before: 'Before.',
      after: 'After.',
      rationaleCode: 'recurrent-supported-finding',
    };

    expect(() => service.prepare({ ...input, group: { ...group, support: 'low-support' } }))
      .toThrow(/supported/);
    expect(() => service.prepare({
      ...input,
      group: { ...group, contradiction: { present: true, sourceFindingIds: ['finding-x'] } },
    })).toThrow(/contradicted/);
    expect(() => service.prepare({ ...input, group: { ...group, inferenceOnly: true } }))
      .toThrow(/inference-only/);
    expect(() => service.prepare({ ...input, group: { ...group, evidenceQuality: 'unverified' } }))
      .toThrow(/verified evidence/);
  });
});
