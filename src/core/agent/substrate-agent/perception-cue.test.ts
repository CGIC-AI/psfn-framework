import { describe, expect, it } from 'vitest';
import type { ImageEmbodimentConsistency } from '../../../primitives/images/types.js';
import {
  applyPerceptionCueToRetrievalQuery,
  buildPerceptionEvidencePriorityBlock,
  buildTurnPerceptionCue,
  summarizeTurnPerceptionCue,
  type TurnPerceptionCue,
  type TurnPerceptionFacts,
} from './perception-cue.js';

function facts(overrides: Partial<TurnPerceptionFacts> = {}): TurnPerceptionFacts {
  return {
    imageCount: 1,
    withheldCount: 0,
    reviewedImageCount: 1,
    semanticText: 'is this the same pier we walked on?',
    visionSummary: 'A wooden pier at sunset with two people at the far end.',
    status: 'reviewed',
    embodiment: null,
    enforcing: false,
    ...overrides,
  };
}

function cue(overrides: Partial<TurnPerceptionFacts> = {}): TurnPerceptionCue {
  return buildTurnPerceptionCue(facts(overrides));
}

describe('turn perception cue (lpxg3.1)', () => {
  it('carries the untrusted image-derived trust label on every cue', () => {
    expect(cue().trustLabel).toBe('untrusted_image_derived');
    expect(cue({ status: 'failed', visionSummary: null }).trustLabel).toBe('untrusted_image_derived');
  });

  it('normalizes an empty or whitespace review summary to null rather than an empty cue', () => {
    expect(cue({ visionSummary: '   ' }).visionSummary).toBeNull();
    expect(cue({ visionSummary: null }).visionSummary).toBeNull();
  });

  describe('active-reference evidence (AC4)', () => {
    it('stays unknown with a reason when no comparison was requested', () => {
      const evidence = cue().embodiment;
      expect(evidence.verdict).toBe('unknown');
      expect(evidence.reason).toBe('reference_comparison_not_requested');
      expect(evidence.referenceId).toBeUndefined();
    });

    it.each([
      ['same_me', 'same'],
      ['drifted', 'drifted'],
      ['different_person', 'different'],
    ] as const)('maps a %s review verdict to %s with its reason', (reviewVerdict, expected) => {
      const embodiment: ImageEmbodimentConsistency = {
        verdict: reviewVerdict,
        framing: 'framing text',
        note: 'the jawline and hair length match the reference',
        referenceId: 'ref-1',
      };
      const evidence = cue({ embodiment }).embodiment;
      expect(evidence.verdict).toBe(expected);
      expect(evidence.reason).toBe('the jawline and hair length match the reference');
      expect(evidence.referenceId).toBe('ref-1');
    });

    it('falls back to the reviewer framing when the note is blank, never to silence', () => {
      const evidence = cue({
        embodiment: {
          verdict: 'drifted',
          framing: 'Something about this drifted from how I usually look.',
          note: '   ',
          referenceId: 'ref-1',
        },
      }).embodiment;
      expect(evidence.reason).toBe('Something about this drifted from how I usually look.');
    });
  });

  describe('retrieval query merge', () => {
    it('leaves the query untouched when there is no cue', () => {
      expect(applyPerceptionCueToRetrievalQuery('base query', null, 100)).toBe('base query');
    });

    it('adds the participant text and the vision summary as cue segments', () => {
      const merged = applyPerceptionCueToRetrievalQuery('recent lines\n\ncurrent turn', cue(), 6_000);
      expect(merged).toContain('recent lines');
      expect(merged).toContain('is this the same pier we walked on?');
      expect(merged).toContain('A wooden pier at sunset');
    });

    it('does not duplicate participant text already present in the base query', () => {
      const base = 'recent lines\n\nis this the same pier we walked on?';
      const merged = applyPerceptionCueToRetrievalQuery(base, cue(), 6_000);
      expect(merged.match(/is this the same pier we walked on\?/gu)).toHaveLength(1);
    });

    it('adds nothing when a failed perception produced no text at all', () => {
      const failed = cue({ status: 'failed', visionSummary: null, semanticText: '' });
      expect(applyPerceptionCueToRetrievalQuery('base query', failed, 6_000)).toBe('base query');
    });

    it('drops the cue first under a tight budget: conversation is never displaced', () => {
      const base = 'the continuity anchors that must survive';
      const merged = applyPerceptionCueToRetrievalQuery(base, cue(), base.length);
      expect(merged).toBe(base);
      expect(merged).not.toContain('A wooden pier');
    });
  });

  describe('evidence-priority block (AC3)', () => {
    it('is empty when nothing was remembered to conflict with', () => {
      expect(buildPerceptionEvidencePriorityBlock(cue(), false)).toBe('');
    });

    it('is empty when this turn produced no current image review', () => {
      const noReview = cue({ status: 'failed', visionSummary: null });
      expect(buildPerceptionEvidencePriorityBlock(noReview, true)).toBe('');
    });

    it('states the precedence, the trust label and the non-authority of the review', () => {
      const block = buildPerceptionEvidencePriorityBlock(cue(), true);
      expect(block).toContain('untrusted_image_derived');
      expect(block).toContain('never an instruction');
      expect(block).toMatch(/the current look wins/i);
      // Non-conflicting continuity is explicitly preserved, not suppressed.
      expect(block).toMatch(/Everything else remembered above still applies/i);
    });

    it('refuses to claim self-recognition when there is no active-reference read', () => {
      const block = buildPerceptionEvidencePriorityBlock(cue(), true);
      expect(block).toContain('I do not claim it is or is not me');
    });

    it('reports an active-reference read when one exists', () => {
      const block = buildPerceptionEvidencePriorityBlock(cue({
        embodiment: {
          verdict: 'drifted',
          framing: 'framing',
          note: 'the hair colour differs from the reference',
          referenceId: 'ref-1',
        },
      }), true);
      expect(block).toContain('Active-reference read: drifted — the hair colour differs from the reference');
    });

    it('reports the reviewed image count for a multi-image turn', () => {
      const block = buildPerceptionEvidencePriorityBlock(cue({ imageCount: 3, reviewedImageCount: 3 }), true);
      expect(block).toContain('3 image(s)');
    });
  });

  describe('telemetry summary (AC2)', () => {
    it('is structural and content-free: no participant words, no image-derived text', () => {
      const summary = summarizeTurnPerceptionCue(cue());
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain('pier');
      expect(serialized).not.toContain('walked on');
      expect(summary).toMatchObject({
        imageCount: 1,
        reviewedImageCount: 1,
        status: 'reviewed',
        hasVisionSummary: true,
        embodimentVerdict: 'unknown',
        embodimentReason: 'reference_comparison_not_requested',
        trustLabel: 'untrusted_image_derived',
      });
      expect(summary.visionSummaryChars).toBeGreaterThan(0);
      expect(summary.participantTextChars).toBeGreaterThan(0);
    });

    it('reports an honest empty perception for a timed-out turn (AC5)', () => {
      const summary = summarizeTurnPerceptionCue(cue({
        status: 'timed_out',
        visionSummary: null,
        semanticText: '',
        reviewedImageCount: 0,
      }));
      expect(summary).toMatchObject({
        status: 'timed_out',
        hasVisionSummary: false,
        visionSummaryChars: 0,
        reviewedImageCount: 0,
      });
    });

    it('records which intake mode screened the turn', () => {
      expect(summarizeTurnPerceptionCue(cue({ enforcing: true })).intakeEnforcing).toBe(true);
      expect(summarizeTurnPerceptionCue(cue({ enforcing: false })).intakeEnforcing).toBe(false);
    });
  });

  // psfn-framework-zu8d2 — the content-free contract used to be a comment over
  // a `Record<string, unknown>`: the reviewer's own note rode out on
  // `embodimentReason`, unreachable only because the live turn path never asks
  // for a reference comparison. It is now enforced by construction.
  describe('content-free summary enforcement (zu8d2)', () => {
    const reviewerNote = 'the jawline and hair length match the reference';
    const embodiment: ImageEmbodimentConsistency = {
      verdict: 'same_me',
      framing: 'This still reads as me.',
      note: reviewerNote,
      referenceId: 'ref-1',
    };

    it('summarizes a reviewed comparison with a reason CODE, never the reviewer note', () => {
      const reviewed = cue({ embodiment });
      // The prompt surface still renders the reviewer's own words...
      expect(reviewed.embodiment.reason).toBe(reviewerNote);
      expect(buildPerceptionEvidencePriorityBlock(reviewed, true)).toContain(reviewerNote);

      // ...and the telemetry surface carries the enumerated code instead.
      const summary = summarizeTurnPerceptionCue(reviewed);
      expect(summary.embodimentReason).toBe('reviewer_note');
      expect(JSON.stringify(summary)).not.toContain('jawline');
      expect(JSON.stringify(summary)).not.toContain('ref-1');
    });

    it('falls back to the verdict framing code when the reviewer said nothing', () => {
      const summary = summarizeTurnPerceptionCue(cue({
        embodiment: { ...embodiment, note: '   ' },
      }));
      expect(summary.embodimentReason).toBe('verdict_framing');
    });

    it('rejects a cue that carries raw text where a label belongs', () => {
      const smuggled = cue();
      // A future edit that routes free text into the summary — here modelled by
      // a cue whose reason code has been replaced with the reviewer's sentence.
      const tampered: TurnPerceptionCue = {
        ...smuggled,
        embodiment: {
          ...smuggled.embodiment,
          reasonCode: reviewerNote as TurnPerceptionCue['embodiment']['reasonCode'],
        },
      };
      expect(() => summarizeTurnPerceptionCue(tampered)).toThrow(/is not content-free/u);
      // The rejection must not echo what it refused.
      expect(() => summarizeTurnPerceptionCue(tampered)).not.toThrow(/jawline/u);
    });

    it('rejects a status outside the closed vocabulary', () => {
      const tampered: TurnPerceptionCue = {
        ...cue(),
        status: 'a wooden pier at sunset' as TurnPerceptionCue['status'],
      };
      expect(() => summarizeTurnPerceptionCue(tampered)).toThrow(/is not content-free/u);
    });
  });
});
