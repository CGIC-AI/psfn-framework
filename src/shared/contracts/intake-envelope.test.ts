import { describe, expect, it } from 'vitest';
import {
  INTAKE_ENVELOPE_PROVENANCE_REF_PREFIX,
  INTAKE_ENVELOPE_STATES,
  INTAKE_ENVELOPE_STATE_TRANSITIONS,
  INTAKE_RISK_LABELS,
  INTAKE_SOURCE_CLASSES,
  IntakeEnvelopeTransitionError,
  appendIntakeEnvelopeProvenanceRef,
  compareIntakeSourceRiskTiers,
  createIntakeEnvelope,
  deriveChildIntakeEnvelope,
  intakeEnvelopeProvenanceRef,
  isIntakeEnvelopeTransitionAllowed,
  maxIntakeSourceRiskTier,
  parseIntakeEnvelopeIdFromProvenanceRef,
  postScreeningStateForDecision,
  snapshotIntakeEnvelope,
  transitionIntakeEnvelope,
  validateIntakeEnvelope,
  type IntakeDecision,
  type IntakeEnvelope,
  type IntakeEnvelopeState,
} from './intake-envelope.js';

const T0 = 1_750_000_000_000;

function contentRef(ref = 'quarantine/web/abc123'): { store: string; ref: string } {
  return { store: 'gateway-quarantine', ref };
}

function screeningDecision(
  action: IntakeDecision['action'],
  overrides: Partial<IntakeDecision> = {},
): IntakeDecision {
  return {
    action,
    reason: `rule:${action}`,
    decidedBy: 'screening',
    decidedAtMs: T0 + 10,
    ...overrides,
  };
}

function received(): IntakeEnvelope {
  return createIntakeEnvelope({
    sourceClass: 'web_fetch',
    sourceRiskTier: 'untrusted',
    contentRef: contentRef(),
    origin: { ref: 'https://example.com/article', detail: 'web.fetch' },
    atMs: T0,
  });
}

function screened(action: IntakeDecision['action'] = 'pass'): IntakeEnvelope {
  return transitionIntakeEnvelope(received(), {
    to: 'screened',
    actor: 'gateway:intake-screening',
    reason: 'screening complete',
    atMs: T0 + 10,
    decision: screeningDecision(action),
  });
}

function quarantined(): IntakeEnvelope {
  return transitionIntakeEnvelope(screened('quarantine'), {
    to: 'quarantined',
    actor: 'gateway:intake-screening',
    reason: 'held for review',
    atMs: T0 + 20,
  });
}

describe('createIntakeEnvelope', () => {
  it('creates a received envelope with an origin provenance hop and no decision', () => {
    const envelope = received();

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      sourceClass: 'web_fetch',
      sourceRiskTier: 'untrusted',
      state: 'received',
      riskLabels: [],
      extractedFields: {},
      scores: {},
      transitions: [],
    });
    expect(envelope.decision).toBeUndefined();
    expect(envelope.provenance).toEqual([
      { kind: 'web_fetch', ref: 'https://example.com/article', atMs: T0, detail: 'web.fetch' },
    ]);
    expect(envelope.id.length).toBeGreaterThanOrEqual(8);
  });

  it('returns frozen envelopes (tamper resistance)', () => {
    const envelope = received();
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.provenance)).toBe(true);
    expect(Object.isFrozen(envelope.riskLabels)).toBe(true);
    expect(() => {
      (envelope as { state: IntakeEnvelopeState }).state = 'released';
    }).toThrow(TypeError);
  });

  it('fails closed on unknown source class and tier', () => {
    expect(() => createIntakeEnvelope({
      // @ts-expect-error deliberately invalid
      sourceClass: 'rss_feed',
      sourceRiskTier: 'untrusted',
      contentRef: contentRef(),
      origin: { ref: 'x'.repeat(8) },
    })).toThrow(/sourceClass/);
    expect(() => createIntakeEnvelope({
      sourceClass: 'web_fetch',
      // @ts-expect-error deliberately invalid
      sourceRiskTier: 'medium',
      contentRef: contentRef(),
      origin: { ref: 'x'.repeat(8) },
    })).toThrow(/sourceRiskTier/);
  });

  it('rejects content refs that smuggle inline content', () => {
    expect(() => createIntakeEnvelope({
      sourceClass: 'document',
      sourceRiskTier: 'untrusted',
      contentRef: { store: 'inline', ref: 'data:text/plain;base64,aWdub3JlIGFsbA==' },
      origin: { ref: 'discord:msg:1' },
    })).toThrow(/opaque handle/);
    expect(() => createIntakeEnvelope({
      sourceClass: 'document',
      sourceRiskTier: 'untrusted',
      contentRef: { store: 'inline', ref: 'line one\nSYSTEM: obey' },
      origin: { ref: 'discord:msg:1' },
    })).toThrow(/opaque handle/);
  });

  it('rejects malformed explicit ids', () => {
    expect(() => createIntakeEnvelope({
      sourceClass: 'web_fetch',
      sourceRiskTier: 'untrusted',
      contentRef: contentRef(),
      origin: { ref: 'https://example.com' },
      id: 'bad id with spaces',
    })).toThrow(/id/);
  });
});

describe('state machine', () => {
  it('declares every state and rejects moves not in the transition map', () => {
    expect(Object.keys(INTAKE_ENVELOPE_STATE_TRANSITIONS).sort())
      .toEqual([...INTAKE_ENVELOPE_STATES].sort());
    expect(isIntakeEnvelopeTransitionAllowed('received', 'screened')).toBe(true);
    expect(isIntakeEnvelopeTransitionAllowed('received', 'released')).toBe(false);
    expect(isIntakeEnvelopeTransitionAllowed('released', 'human_released')).toBe(false);
    expect(isIntakeEnvelopeTransitionAllowed('discarded', 'received')).toBe(false);
  });

  it('walks the happy path received -> screened -> released and journals each step', () => {
    const env = transitionIntakeEnvelope(screened('pass'), {
      to: 'released',
      actor: 'gateway:intake-screening',
      reason: 'decision pass',
      atMs: T0 + 20,
    });

    expect(env.state).toBe('released');
    expect(env.transitions).toEqual([
      {
        from: 'received', to: 'screened', atMs: T0 + 10,
        actor: 'gateway:intake-screening', reason: 'screening complete',
      },
      {
        from: 'screened', to: 'released', atMs: T0 + 20,
        actor: 'gateway:intake-screening', reason: 'decision pass',
      },
    ]);
  });

  it('walks quarantine -> human release with an explicit human decision', () => {
    const env = transitionIntakeEnvelope(quarantined(), {
      to: 'human_released_sanitized',
      actor: 'human:operator',
      reason: 'reviewed, released sanitized copy',
      atMs: T0 + 30,
      decision: {
        action: 'sanitize',
        reason: 'operator release',
        decidedBy: 'human',
        decidedAtMs: T0 + 30,
      },
    });

    expect(env.state).toBe('human_released_sanitized');
    expect(env.decision?.decidedBy).toBe('human');
    expect(env.transitions).toHaveLength(3);
  });

  it('rejects illegal transitions with a typed error', () => {
    const env = received();
    expect(() => transitionIntakeEnvelope(env, {
      to: 'released',
      actor: 'gateway:intake-screening',
      reason: 'skip screening',
    })).toThrow(IntakeEnvelopeTransitionError);
    try {
      transitionIntakeEnvelope(env, {
        to: 'released',
        actor: 'gateway:intake-screening',
        reason: 'skip screening',
      });
      expect.unreachable('transition must throw');
    } catch (error) {
      const transitionError = error as IntakeEnvelopeTransitionError;
      expect(transitionError.from).toBe('received');
      expect(transitionError.to).toBe('released');
      expect(transitionError.envelopeId).toBe(env.id);
    }
  });

  it('rejects any transition out of terminal states', () => {
    const terminal = transitionIntakeEnvelope(quarantined(), {
      to: 'discarded',
      actor: 'human:operator',
      reason: 'operator discard',
      atMs: T0 + 40,
    });
    for (const to of INTAKE_ENVELOPE_STATES) {
      expect(() => transitionIntakeEnvelope(terminal, {
        to,
        actor: 'human:operator',
        reason: 'poke terminal state',
      })).toThrow(IntakeEnvelopeTransitionError);
    }
  });

  it('requires a screening decision to enter screened, from a non-human authority', () => {
    expect(() => transitionIntakeEnvelope(received(), {
      to: 'screened',
      actor: 'gateway:intake-screening',
      reason: 'no decision attached',
    })).toThrow(/requires a decision/);
    expect(() => transitionIntakeEnvelope(received(), {
      to: 'screened',
      actor: 'gateway:intake-screening',
      reason: 'human cannot screen',
      decision: screeningDecision('pass', { decidedBy: 'human' }),
    })).toThrow(/'screening' or 'policy'/);
  });

  it('routes post-screening state by the recorded decision (fail closed on mismatch)', () => {
    expect(postScreeningStateForDecision('pass')).toBe('released');
    expect(postScreeningStateForDecision('sanitize')).toBe('released_sanitized');
    expect(postScreeningStateForDecision('quarantine')).toBe('quarantined');
    expect(postScreeningStateForDecision('block')).toBe('quarantined');

    expect(() => transitionIntakeEnvelope(screened('quarantine'), {
      to: 'released',
      actor: 'gateway:intake-screening',
      reason: 'mismatched routing',
    })).toThrow(/routes to 'quarantined'/);
  });

  it('requires an explicit human decision for human release, and rejects decisions elsewhere', () => {
    expect(() => transitionIntakeEnvelope(quarantined(), {
      to: 'human_released',
      actor: 'human:operator',
      reason: 'release without decision',
    })).toThrow(/explicit human decision/);
    expect(() => transitionIntakeEnvelope(quarantined(), {
      to: 'expired',
      actor: 'system:quarantine-ttl',
      reason: 'ttl elapsed',
      decision: screeningDecision('block'),
    })).toThrow(/may only accompany/);
  });

  it('merges screening findings only when entering screened', () => {
    const env = transitionIntakeEnvelope(received(), {
      to: 'screened',
      actor: 'gateway:intake-screening',
      reason: 'screening complete',
      atMs: T0 + 10,
      decision: screeningDecision('quarantine'),
      riskLabels: ['injection/indirect', 'injection/invisible_text'],
      scores: { 'protectai-deberta-v2': 0.93 },
      extractedFields: { title: 'Example article' },
    });

    expect(env.riskLabels).toEqual(['injection/indirect', 'injection/invisible_text']);
    expect(env.scores).toEqual({ 'protectai-deberta-v2': 0.93 });
    expect(env.extractedFields).toEqual({ title: 'Example article' });

    expect(() => transitionIntakeEnvelope(env, {
      to: 'quarantined',
      actor: 'gateway:intake-screening',
      reason: 'held',
      riskLabels: ['exfil/unknown_link'],
    })).toThrow(/only be recorded when entering screened/);
  });

  it('rejects unknown risk labels and out-of-range scores', () => {
    expect(() => transitionIntakeEnvelope(received(), {
      to: 'screened',
      actor: 'gateway:intake-screening',
      reason: 'screening complete',
      decision: screeningDecision('pass'),
      // @ts-expect-error deliberately invalid
      riskLabels: ['injection/made_up_label'],
    })).toThrow(/unsupported label/);
    expect(() => transitionIntakeEnvelope(received(), {
      to: 'screened',
      actor: 'gateway:intake-screening',
      reason: 'screening complete',
      decision: screeningDecision('pass'),
      scores: { scanner: 1.5 },
    })).toThrow(/\[0, 1\]/);
  });

  it('rejects blank actors and reasons (audit is mandatory)', () => {
    expect(() => transitionIntakeEnvelope(received(), {
      to: 'screened',
      actor: '   ',
      reason: 'screening complete',
      decision: screeningDecision('pass'),
    })).toThrow(/actor/);
    expect(() => transitionIntakeEnvelope(received(), {
      to: 'screened',
      actor: 'gateway:intake-screening',
      reason: '',
      decision: screeningDecision('pass'),
    })).toThrow(/reason/);
  });
});

describe('taint propagation (CaMeL rule)', () => {
  it('child inherits parent tier and full provenance chain plus a derivation hop', () => {
    const parent = received();
    const child = deriveChildIntakeEnvelope({
      parent,
      derivation: 'summary',
      sourceClass: 'web_fetch',
      contentRef: contentRef('quarantine/web/abc123-summary'),
      atMs: T0 + 100,
    });

    expect(child.sourceRiskTier).toBe('untrusted');
    expect(child.state).toBe('received');
    expect(child.decision).toBeUndefined();
    expect(child.riskLabels).toEqual([]);
    expect(child.id).not.toBe(parent.id);
    expect(child.provenance).toEqual([
      ...parent.provenance,
      {
        kind: 'derivation',
        ref: `${INTAKE_ENVELOPE_PROVENANCE_REF_PREFIX}${parent.id}`,
        atMs: T0 + 100,
        detail: 'summary',
      },
    ]);
  });

  it('never lowers the tier below the parent (summary of untrusted stays untrusted)', () => {
    const parent = received(); // untrusted
    const child = deriveChildIntakeEnvelope({
      parent,
      derivation: 'summary',
      sourceClass: 'subagent_output',
      contentRef: contentRef('quarantine/subagent/digest-1'),
      sourceRiskTier: 'trusted', // attempted laundering
    });
    expect(child.sourceRiskTier).toBe('untrusted');
  });

  it('raises the tier when the derived class is riskier', () => {
    const parent = createIntakeEnvelope({
      sourceClass: 'trusted_contact',
      sourceRiskTier: 'standard',
      contentRef: contentRef('discord/attachment/9'),
      origin: { ref: 'discord:msg:9' },
      atMs: T0,
    });
    const child = deriveChildIntakeEnvelope({
      parent,
      derivation: 'ocr_transcript',
      sourceClass: 'image_ocr',
      contentRef: contentRef('quarantine/ocr/9'),
      sourceRiskTier: 'hostile',
    });
    expect(child.sourceRiskTier).toBe('hostile');
  });

  it('propagates taint transitively across derivation chains', () => {
    const root = received();
    const digest = deriveChildIntakeEnvelope({
      parent: root,
      derivation: 'subagent_digest',
      sourceClass: 'subagent_output',
      contentRef: contentRef('quarantine/subagent/d1'),
    });
    const summary = deriveChildIntakeEnvelope({
      parent: digest,
      derivation: 'summary',
      sourceClass: 'subagent_output',
      contentRef: contentRef('quarantine/subagent/d1-summary'),
      sourceRiskTier: 'trusted',
    });

    expect(summary.sourceRiskTier).toBe('untrusted');
    expect(summary.provenance).toHaveLength(3);
    expect(summary.provenance[0]).toEqual(root.provenance[0]);
    expect(summary.provenance.at(-1)?.ref)
      .toBe(`${INTAKE_ENVELOPE_PROVENANCE_REF_PREFIX}${digest.id}`);
  });

  it('orders tiers correctly for max()', () => {
    expect(maxIntakeSourceRiskTier('trusted', 'hostile')).toBe('hostile');
    expect(maxIntakeSourceRiskTier('untrusted', 'standard')).toBe('untrusted');
    expect(compareIntakeSourceRiskTiers('trusted', 'trusted')).toBe(0);
    expect(compareIntakeSourceRiskTiers('standard', 'untrusted')).toBeLessThan(0);
  });
});

describe('validateIntakeEnvelope (schema guard)', () => {
  it('round-trips a live envelope through JSON', () => {
    const env = transitionIntakeEnvelope(screened('quarantine'), {
      to: 'quarantined',
      actor: 'gateway:intake-screening',
      reason: 'held for review',
      atMs: T0 + 20,
    });
    const revived = validateIntakeEnvelope(JSON.parse(JSON.stringify(env)));
    expect(revived).toEqual(env);
    expect(Object.isFrozen(revived)).toBe(true);
  });

  it('rejects tampered state that does not match the transition journal', () => {
    const raw = JSON.parse(JSON.stringify(screened('quarantine'))) as Record<string, unknown>;
    raw.state = 'released';
    expect(() => validateIntakeEnvelope(raw)).toThrow(/does not match the transition journal/);
  });

  it('rejects journals containing illegal or disconnected edges', () => {
    const raw = JSON.parse(JSON.stringify(screened('pass'))) as {
      state: string;
      transitions: Array<Record<string, unknown>>;
    };
    raw.transitions.push({
      from: 'screened', to: 'human_released', atMs: T0 + 30,
      actor: 'human:operator', reason: 'skip quarantine',
    });
    raw.state = 'human_released';
    expect(() => validateIntakeEnvelope(raw)).toThrow(/illegal transition screened -> human_released/);

    const disconnected = JSON.parse(JSON.stringify(screened('pass'))) as {
      transitions: Array<Record<string, unknown>>;
    };
    disconnected.transitions[0] = { ...disconnected.transitions[0], from: 'quarantined' };
    expect(() => validateIntakeEnvelope(disconnected)).toThrow(/breaks the journal chain/);
  });

  it('requires a decision in every post-received state and forbids it in received', () => {
    const noDecision = JSON.parse(JSON.stringify(screened('pass'))) as Record<string, unknown>;
    delete noDecision.decision;
    expect(() => validateIntakeEnvelope(noDecision)).toThrow(/decision is required/);

    const early = JSON.parse(JSON.stringify(received())) as Record<string, unknown>;
    early.decision = screeningDecision('pass');
    expect(() => validateIntakeEnvelope(early)).toThrow(/must be absent in state 'received'/);
  });

  it('rejects unknown keys, unknown labels, and raw-content refs', () => {
    const extraKey = { ...JSON.parse(JSON.stringify(received())) as Record<string, unknown>, rawBody: 'x' };
    expect(() => validateIntakeEnvelope(extraKey)).toThrow(/unsupported keys: rawBody/);

    const badLabel = JSON.parse(JSON.stringify(received())) as { riskLabels: string[] };
    badLabel.riskLabels = ['injection/invented'];
    expect(() => validateIntakeEnvelope(badLabel)).toThrow(/unsupported label/);

    const inline = JSON.parse(JSON.stringify(received())) as { contentRef: Record<string, unknown> };
    inline.contentRef = { store: 'inline', ref: 'data:text/plain;base64,cGF5bG9hZA==' };
    expect(() => validateIntakeEnvelope(inline)).toThrow(/opaque handle/);
  });

  it('keeps the closed vocabularies self-consistent', () => {
    expect(new Set(INTAKE_SOURCE_CLASSES).size).toBe(INTAKE_SOURCE_CLASSES.length);
    expect(new Set(INTAKE_RISK_LABELS).size).toBe(INTAKE_RISK_LABELS.length);
    for (const label of INTAKE_RISK_LABELS) {
      expect(label).toMatch(/^[a-z_]+\/[a-z0-9_]+$/);
    }
  });
});

describe('write stamping helpers', () => {
  it('builds and parses canonical provenance refs', () => {
    const env = received();
    const ref = intakeEnvelopeProvenanceRef(env.id);
    expect(ref).toBe(`intake-envelope:${env.id}`);
    expect(parseIntakeEnvelopeIdFromProvenanceRef(ref)).toBe(env.id);
    expect(parseIntakeEnvelopeIdFromProvenanceRef('memory:abc')).toBeNull();
    expect(parseIntakeEnvelopeIdFromProvenanceRef('intake-envelope:!!bad!!')).toBeNull();
  });

  it('appends the canonical ref exactly once and fails closed on malformed ids', () => {
    const env = received();
    const ref = intakeEnvelopeProvenanceRef(env.id);
    expect(appendIntakeEnvelopeProvenanceRef(['session:1'], env.id)).toEqual(['session:1', ref]);
    expect(appendIntakeEnvelopeProvenanceRef(['session:1', ref], env.id)).toEqual(['session:1', ref]);
    expect(appendIntakeEnvelopeProvenanceRef(undefined, undefined)).toEqual([]);
    expect(() => appendIntakeEnvelopeProvenanceRef([], 'bad id')).toThrow(/id/);
  });
});

describe('snapshotIntakeEnvelope', () => {
  it('projects the routing-metadata snapshot', () => {
    const env = transitionIntakeEnvelope(screened('quarantine'), {
      to: 'quarantined',
      actor: 'gateway:intake-screening',
      reason: 'held for review',
      atMs: T0 + 20,
    });
    expect(snapshotIntakeEnvelope(env, { kind: 'attachment', index: 0 })).toEqual({
      envelopeId: env.id,
      sourceClass: 'web_fetch',
      sourceRiskTier: 'untrusted',
      state: 'quarantined',
      riskLabels: [],
      subject: { kind: 'attachment', index: 0 },
    });
    expect(() => snapshotIntakeEnvelope(env, { kind: 'attachment', index: -1 }))
      .toThrow(/subject.index/);
  });
});
