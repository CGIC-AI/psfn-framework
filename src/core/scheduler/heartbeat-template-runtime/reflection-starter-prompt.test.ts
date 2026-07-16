import { describe, expect, it } from 'vitest';
import { InternalStateComputer, buildInternalStateSnapshotRef } from '../../self-model/state.js';
import {
  buildReflectionStarterPromptBundle,
  REFLECTION_STARTER_PROMPT_VERSION,
} from './reflection-starter-prompt.js';
import type { ReflectionInternalStateContext } from './prompt-formatting.js';

function buildInternalStateContext(): ReflectionInternalStateContext {
  const internalState = new InternalStateComputer().computeState({
    emotionState: {
      vad: { valence: 0.2, arousal: 0.15, dominance: 0.1 },
      mood: { valence: 0.25, arousal: 0.2, dominance: 0.15 },
      discrete: { curiosity: 0.5, calm: 0.4 },
      confidence: 0.75,
    },
    activeConcerns: [{
      id: 'concern-1',
      text: 'Clarify the recovery timeline',
      priority: 'high',
      source: 'appraisal',
      status: 'active',
      createdAt: '2026-07-15T08:00:00.000Z',
      expiresAt: '2026-07-18T08:00:00.000Z',
      salience: 0.92,
      sensitivity: 'personal',
      owner: 'companion',
      evidenceRefs: [],
      resolutionEvidenceRefs: [],
    }],
    trustLevel: 'trusted',
    contactId: 'contact-1',
    sessionMetrics: {
      userMessageText: 'Recent conversations matter.',
      responseText: 'Keep continuity with the primary contact.',
      toolCallCount: 0,
      recentTurnCount: 3,
      lastSeenDeltaSeconds: 120,
    },
  });

  return {
    internalState,
    internalStateSnapshotRef: buildInternalStateSnapshotRef(internalState),
    metacognitiveFlags: [{
      flag: 'uncertainty',
      confidence: 0.8,
      evidence: 'METACOGNITIVE_FLAG_SENTINEL',
    }],
    snapshotSource: 'runtime',
  };
}

const CUT_BLOCKS = [
  '[Reflection Self Evidence]',
  '[What this evidence is]',
  '[Wellbeing and Affect Clues]',
  '[Cognitive and Attention Clues]',
  '[Salient Entities]',
  '[Relational Clues]',
  '[Recent Metacognitive Flags]',
  '[Active Concerns]',
  '[Pending Follow-Ups]',
  '[Care Reminders]',
  '[Reflection Contact Evidence]',
  '[Recent Contact Session]',
  '[Reflection Memory Retrieval]',
  '[Retrieved Memory]',
  '[Recent Session Tail]',
  '[Reflection Affect Evidence]',
  '[Recent Reflection Journal]',
  '[Recent Lived-Day Journal]',
  '[Recent Long-Process Trace]',
  '[Reflection Self Substrate]',
  '[Reflection Relational Substrate]',
  '[Reflection Affect Substrate]',
];

describe('buildReflectionStarterPromptBundle', () => {
  it('builds a compact daily starter from event evidence and at most two high-signal clues', () => {
    const bundle = buildReflectionStarterPromptBundle({
      templateId: 'daily-review',
      internalStateContext: buildInternalStateContext(),
      retrievedMemoryBlock: [
        '[Reflection Memory Retrieval]',
        '- Baseline tone: lifted (0.20)',
        '- Current mood drift: steady (0.01)',
        '- [episodic] Day event one',
        '- [semantic] Day event two',
        '- [reflection] Day event three',
        '- [episodic] Day event four should be cut',
      ].join('\n'),
      recentSessionMessages: [
        { role: 'user', authorName: 'Ari', content: 'Session fallback should not replace retrieved events.' },
      ],
      recentDailyJournalEntries: [],
      provenanceRefs: ['memory:event-1', 'internal_state_snapshot:snapshot-1'],
    });

    expect(REFLECTION_STARTER_PROMPT_VERSION).toBe(1);
    expect(bundle.self).toContain('[Day Events Starter]');
    expect(bundle.self).toContain('Day event one');
    expect(bundle.self).toContain('Day event three');
    expect(bundle.self).not.toContain('Day event four should be cut');
    expect(bundle.self).not.toContain('Baseline tone');
    expect(bundle.self).not.toContain('[episodic]');
    expect(bundle.self).toContain('[High-Signal Starter Clues]');
    expect(bundle.self).toContain('Clarify the recovery timeline');
    expect(bundle.self).not.toContain('METACOGNITIVE_FLAG_SENTINEL');
    expect(bundle.self.match(/^-/gm)).toHaveLength(5);
    for (const cutBlock of CUT_BLOCKS) {
      expect(bundle.self).not.toContain(cutBlock);
    }
    expect(bundle.provenanceRefs).toEqual([
      'memory:event-1',
      'internal_state_snapshot:snapshot-1',
    ]);
  });

  it('builds a compact weekly starter from recent lived-day summaries without enumerating reflection categories', () => {
    const bundle = buildReflectionStarterPromptBundle({
      templateId: 'weekly-review',
      internalStateContext: buildInternalStateContext(),
      retrievedMemoryBlock: '- Memory fallback should not replace lived-day summaries',
      recentSessionMessages: [],
      recentDailyJournalEntries: [
        { date: '2026-07-15', reflection: 'The handoff settled and the repair held.' },
        { date: '2026-07-14', reflection: 'A long conversation reopened a useful question.' },
        { date: '2026-07-13', reflection: 'Quiet work made the next step clearer.' },
        { date: '2026-07-12', reflection: 'This fourth summary should be cut.' },
      ],
      provenanceRefs: ['reflection_daily:day-1'],
    });

    expect(bundle.self).toContain('[Week Events Starter]');
    expect(bundle.self).toContain('2026-07-15: The handoff settled and the repair held.');
    expect(bundle.self).toContain('2026-07-13: Quiet work made the next step clearer.');
    expect(bundle.self).not.toContain('This fourth summary should be cut.');
    expect(bundle.self).not.toContain('agency');
    expect(bundle.self).not.toContain('connection');
    expect(bundle.self).not.toContain('authenticity');
    expect(bundle.self).not.toContain('curiosity');
    expect(bundle.self).not.toContain('silence or absence framing');
    for (const cutBlock of CUT_BLOCKS) {
      expect(bundle.self).not.toContain(cutBlock);
    }
  });
});
