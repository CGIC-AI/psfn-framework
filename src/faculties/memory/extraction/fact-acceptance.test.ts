import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { IntakeSinkGate } from '../../../core/cogsec/intake/sink-gates.js';
import type { ExtractedFact } from '../types.js';
import {
  buildAcceptedFactCandidates,
  type FactAcceptanceStageInput,
} from './fact-acceptance.js';
import { buildSpeakerRoutingContext } from './speaker-routing.js';
import { computeFactValueScore } from './signals.js';

function fact(text: string, overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    text,
    type: 'semantic',
    importance: 0.8,
    emotionalValence: 0,
    confidence: 0.9,
    tags: [],
    ...overrides,
  };
}

function entry(id: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'api:test',
    role: 'user',
    content: `line ${id}`,
    authorName: 'Alex',
    timestamp: id,
    ...overrides,
  };
}

const screenedEnvelope = {
  envelopeId: 'env-1',
  sourceClass: 'regular_contact',
  sourceRiskTier: 'standard',
  state: 'screened',
  riskLabels: [],
  subject: { kind: 'body' },
};

function screeningMetadata(): string {
  return JSON.stringify({
    intakeScreening: {
      schemaVersion: 1,
      mode: 'enforce',
      withheld: false,
      envelopes: [screenedEnvelope],
    },
  });
}

function fakeGate(overrides: Partial<IntakeSinkGate> = {}): IntakeSinkGate {
  return {
    mode: 'enforce',
    evaluate: vi.fn().mockReturnValue({
      sink: 'memory_write',
      allowed: true,
      verdict: 'allow',
      mode: 'enforce',
      reason: 'allow',
      unscreened: false,
      deniedEnvelopeIds: [],
    }),
    assessEgressTrifecta: vi.fn(),
    ...overrides,
  } as IntakeSinkGate;
}

async function buildInput(
  overrides: Partial<FactAcceptanceStageInput> = {},
): Promise<FactAcceptanceStageInput> {
  const recentEntries = overrides.recentEntries ?? [entry(1)];
  return {
    facts: [],
    recentEntries,
    existingMemoryTexts: [],
    gateConfig: { minImportance: 0.5, minConfidence: 0.5, minNovelty: 0.3 },
    intakeSinkGate: null,
    experientialCompanionName: undefined,
    speakerRouting: await buildSpeakerRoutingContext(recentEntries),
    canonicalContactId: 'contact-alex',
    companionNames: ['Lyra'],
    companionAuthorIds: [],
    channelId: 'api:test',
    attemptRef: 'memory-extraction-request-1',
    triggerReason: 'manual',
    telemetryEnabled: false,
    ...overrides,
  };
}

describe('buildAcceptedFactCandidates', () => {
  it('accepts a passing fact with routing, novelty, value score, and source index', async () => {
    const facts = [fact('Alex enjoys strategic board games with friends')];
    const result = buildAcceptedFactCandidates(await buildInput({ facts }));
    expect(result.acceptedCandidates).toHaveLength(1);
    const candidate = result.acceptedCandidates[0];
    expect(candidate.fact).toBe(facts[0]);
    expect(candidate.index).toBe(0);
    expect(candidate.novelty).toBe(1);
    expect(candidate.valueScore).toBe(computeFactValueScore(facts[0], 1));
    expect(candidate.routing.status).toBe('route');
    expect(candidate.routing.contactId).toBe('contact-alex');
    expect(candidate.routing.reason).toBe('single_speaker_transcript');
    expect(result.rejectionBreakdown).toEqual({
      low_importance: 0,
      low_confidence: 0,
      low_novelty: 0,
      low_signal: 0,
      cogsec_risk: 0,
      ambiguous_speaker: 0,
      write_cap: 0,
    });
    expect(result.ambiguousSpeakerSkippedCount).toBe(0);
    expect(result.ambiguousSpeakerSkipReasons).toEqual({});
  });

  it('rejects facts under the importance and confidence gates', async () => {
    const result = buildAcceptedFactCandidates(await buildInput({
      facts: [
        fact('Alex enjoys strategic board games', { importance: 0.4 }),
        fact('Alex collects vintage synthesizers', { confidence: 0.4 }),
      ],
    }));
    expect(result.acceptedCandidates).toEqual([]);
    expect(result.rejectionBreakdown.low_importance).toBe(1);
    expect(result.rejectionBreakdown.low_confidence).toBe(1);
  });

  it('rejects facts that duplicate the existing memory corpus as low novelty', async () => {
    const result = buildAcceptedFactCandidates(await buildInput({
      facts: [fact('Alex enjoys strategic board games with friends')],
      existingMemoryTexts: ['Alex enjoys strategic board games with friends'],
    }));
    expect(result.acceptedCandidates).toEqual([]);
    expect(result.rejectionBreakdown.low_novelty).toBe(1);
  });

  it('extends the novelty corpus with accepted facts within the same run', async () => {
    const existingMemoryTexts: string[] = [];
    const result = buildAcceptedFactCandidates(await buildInput({
      facts: [
        fact('Alex enjoys strategic board games with friends'),
        fact('Alex enjoys strategic board games with friends'),
      ],
      existingMemoryTexts,
    }));
    expect(result.acceptedCandidates).toHaveLength(1);
    expect(result.rejectionBreakdown.low_novelty).toBe(1);
    // The seed corpus handed in by the caller is never mutated.
    expect(existingMemoryTexts).toEqual([]);
  });

  it('throws when conversational extraction has no speaker routing context', async () => {
    const input = await buildInput({
      facts: [fact('Alex enjoys strategic board games')],
      speakerRouting: undefined,
    });
    expect(() => buildAcceptedFactCandidates(input))
      .toThrow('Speaker routing context is required for conversational extraction');
  });

  it('skips unattributable group-room facts and counts the ambiguity', async () => {
    const recentEntries = [
      entry(1, { authorName: 'Alex', authorId: 'alex' }),
      entry(2, { authorName: 'Sam', authorId: 'sam' }),
    ];
    const result = buildAcceptedFactCandidates(await buildInput({
      facts: [fact('Someone here collects vintage synthesizers')],
      recentEntries,
      speakerRouting: await buildSpeakerRoutingContext(recentEntries),
    }));
    expect(result.acceptedCandidates).toEqual([]);
    expect(result.ambiguousSpeakerSkippedCount).toBe(1);
    expect(result.ambiguousSpeakerSkipReasons).toEqual({ ambiguous_group_speaker: 1 });
    expect(result.rejectionBreakdown.ambiguous_speaker).toBe(1);
  });

  it('rejects facts whose source envelopes are denied by the enforce-mode intake gate', async () => {
    const gate = fakeGate({
      evaluate: vi.fn().mockReturnValue({
        sink: 'memory_write',
        allowed: false,
        verdict: 'deny',
        mode: 'enforce',
        reason: 'quarantined source',
        unscreened: false,
        deniedEnvelopeIds: ['env-1'],
      }),
    });
    const result = buildAcceptedFactCandidates(await buildInput({
      facts: [fact('Alex enjoys strategic board games')],
      recentEntries: [entry(1, { metadata: screeningMetadata() })],
      intakeSinkGate: gate,
    }));
    expect(result.acceptedCandidates).toEqual([]);
    expect(result.rejectionBreakdown.cogsec_risk).toBe(1);
  });

  it('gates an attributed fact against the envelopes of its source entries only', async () => {
    const gate = fakeGate();
    const recentEntries = [
      entry(1, { metadata: screeningMetadata() }),
      entry(2),
    ];
    buildAcceptedFactCandidates(await buildInput({
      facts: [fact('Alex enjoys strategic board games', {
        attribution: { sourceMessageIds: [2] },
      })],
      recentEntries,
      intakeSinkGate: gate,
    }));
    expect(gate.evaluate).toHaveBeenCalledWith('memory_write', [], {
      channelId: 'api:test',
      triggerReason: 'manual',
      factIndex: 0,
      factType: 'semantic',
    }, {
      attemptRef: 'memory-extraction-request-1',
      correlationRef: 'fact:0',
      sourceChannelId: 'api:test',
    });
  });

  it('gates an unattributed fact against every envelope in the window', async () => {
    const gate = fakeGate();
    buildAcceptedFactCandidates(await buildInput({
      facts: [fact('Alex enjoys strategic board games')],
      recentEntries: [entry(1, { metadata: screeningMetadata() }), entry(2)],
      intakeSinkGate: gate,
    }));
    const [, envelopes] = (gate.evaluate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].envelopeId).toBe('env-1');
  });

  it('fails closed on malformed intake screening metadata in enforce mode', async () => {
    const gate = fakeGate();
    const result = buildAcceptedFactCandidates(await buildInput({
      facts: [fact('Alex enjoys strategic board games')],
      recentEntries: [entry(1, {
        metadata: JSON.stringify({ intakeScreening: { schemaVersion: 99 } }),
      })],
      intakeSinkGate: gate,
    }));
    expect(result.acceptedCandidates).toEqual([]);
    expect(result.rejectionBreakdown.cogsec_risk).toBe(1);
    expect(gate.evaluate).not.toHaveBeenCalled();
  });

  it('still evaluates malformed-metadata facts through the gate in shadow mode', async () => {
    const gate = fakeGate({ mode: 'shadow' });
    const result = buildAcceptedFactCandidates(await buildInput({
      facts: [fact('Alex enjoys strategic board games')],
      recentEntries: [entry(1, {
        metadata: JSON.stringify({ intakeScreening: { schemaVersion: 99 } }),
      })],
      intakeSinkGate: gate,
    }));
    expect(gate.evaluate).toHaveBeenCalledTimes(1);
    expect(result.acceptedCandidates).toHaveLength(1);
  });

  describe('experiential self-directed routing', () => {
    const groundedText = 'I felt proud of the sketch I made tonight.';
    const assistantEntry = entry(5, {
      role: 'assistant',
      content: groundedText,
      authorId: 'companion-1',
      authorName: 'Lyra',
    });

    it('routes grounded self-directed facts to the companion self scope', async () => {
      const result = buildAcceptedFactCandidates(await buildInput({
        facts: [fact(groundedText, {
          type: 'emotional',
          emotionalValence: 0.6,
          attribution: { sourceMessageIds: [5] },
        })],
        recentEntries: [assistantEntry],
        experientialCompanionName: 'Lyra',
        speakerRouting: undefined,
      }));
      expect(result.acceptedCandidates).toHaveLength(1);
      const routing = result.acceptedCandidates[0].routing;
      expect(routing.reason).toBe('self_directed_companion');
      expect(routing.scopeRef?.id).toBe('companion:self');
      expect(routing.contactId).toBeUndefined();
    });

    it('rejects ungrounded self-directed facts as low signal', async () => {
      const result = buildAcceptedFactCandidates(await buildInput({
        facts: [fact('I felt proud of a thing that never happened.', {
          type: 'emotional',
          emotionalValence: 0.6,
          attribution: { sourceMessageIds: [5] },
        })],
        recentEntries: [assistantEntry],
        experientialCompanionName: 'Lyra',
        speakerRouting: undefined,
      }));
      expect(result.acceptedCandidates).toEqual([]);
      expect(result.rejectionBreakdown.low_signal).toBe(1);
    });
  });
});
