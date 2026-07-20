import { describe, expect, it, vi } from 'vitest';
import { DyadRelationshipAdvisoryUnavailableError } from '../../../shared/contracts/dyad-relationship-advisory.js';
import type { EmoSimAdapterRunResult } from './emosim-adapter.js';
import {
  EMOSIM_DIRECTED_RELATIONSHIP_FORMAT,
  createEmoSimDyadRelationshipAdvisoryProvider,
  normalizeEmoSimDirectedRelationshipReading,
  parseEmoSimDirectedRelationshipReading,
  renderDyadRelationshipAdvisory,
  type EmoSimDirectedRelationshipReading,
} from './dyad-relationship.js';

const AGENT = 'companion';
const ANCHOR = 'baseline-anchor';

function stateWithRelationships(relationships: unknown): Record<string, unknown> {
  return { t: 1, agents: {}, relationships };
}

describe('parseEmoSimDirectedRelationshipReading', () => {
  it('reads the companion outgoing directed relationship, excluding the anchor', () => {
    const reading = parseEmoSimDirectedRelationshipReading(
      stateWithRelationships({
        [AGENT]: {
          [ANCHOR]: { liking: 0.9, trust: 0.9, dominance: 0, familiarity: 0.9 },
          pierre: { liking: 0.6, trust: 0.4, dominance: -0.2, familiarity: 0.5, emotions: { Love: 0.3, Fear: -0.1 } },
        },
      }),
      { agentName: AGENT, excludeTargets: [ANCHOR] },
    );
    expect(reading).not.toBeNull();
    expect(reading?.sampleCount).toBe(1);
    expect(reading?.liking).toBeCloseTo(0.6);
    expect(reading?.trust).toBeCloseTo(0.4);
    expect(reading?.dominance).toBeCloseTo(-0.2);
    expect(reading?.familiarity).toBeCloseTo(0.5);
    expect(reading?.topEmotionShift).toEqual({ label: 'Love', delta: 0.3 });
  });

  it('averages over multiple real targets', () => {
    const reading = parseEmoSimDirectedRelationshipReading(
      stateWithRelationships({
        [AGENT]: {
          a: { liking: 0.2 },
          b: { liking: 0.8 },
        },
      }),
      { agentName: AGENT },
    );
    expect(reading?.sampleCount).toBe(2);
    expect(reading?.liking).toBeCloseTo(0.5);
    expect(reading?.trust).toBeNull();
  });

  it('returns null when only the excluded anchor has a relationship (HEAD reality)', () => {
    const reading = parseEmoSimDirectedRelationshipReading(
      stateWithRelationships({ [AGENT]: { [ANCHOR]: { liking: 0.9, trust: 0.9 } } }),
      { agentName: AGENT, excludeTargets: [ANCHOR] },
    );
    expect(reading).toBeNull();
  });

  it('returns null for empty, absent, or malformed relationships (fail-closed to omission)', () => {
    expect(parseEmoSimDirectedRelationshipReading(stateWithRelationships({}), { agentName: AGENT })).toBeNull();
    expect(parseEmoSimDirectedRelationshipReading({ t: 1 }, { agentName: AGENT })).toBeNull();
    expect(parseEmoSimDirectedRelationshipReading(stateWithRelationships('nope'), { agentName: AGENT })).toBeNull();
    expect(parseEmoSimDirectedRelationshipReading(stateWithRelationships({ [AGENT]: [1, 2] }), { agentName: AGENT })).toBeNull();
    // Present target but no numeric dimensions -> no contributing data.
    expect(parseEmoSimDirectedRelationshipReading(
      stateWithRelationships({ [AGENT]: { x: { note: 'hi' } } }),
      { agentName: AGENT },
    )).toBeNull();
  });

  it('never throws on hostile input', () => {
    expect(() => parseEmoSimDirectedRelationshipReading(null, { agentName: AGENT })).not.toThrow();
    expect(() => parseEmoSimDirectedRelationshipReading(
      stateWithRelationships({ [AGENT]: { x: { liking: Number.NaN } } }),
      { agentName: AGENT },
    )).not.toThrow();
  });
});

describe('normalizeEmoSimDirectedRelationshipReading (strict, fail-closed)', () => {
  const valid: EmoSimDirectedRelationshipReading = {
    format: EMOSIM_DIRECTED_RELATIONSHIP_FORMAT,
    agentName: AGENT,
    sampleCount: 1,
    liking: 0.5,
    trust: null,
    dominance: null,
    familiarity: null,
    topEmotionShift: null,
  };

  it('accepts a well-formed reading', () => {
    expect(normalizeEmoSimDirectedRelationshipReading(valid, 'r')).toEqual(valid);
  });

  it('throws on a bad format, missing sampleCount, or non-finite scalar', () => {
    expect(() => normalizeEmoSimDirectedRelationshipReading({ ...valid, format: 'x' }, 'r')).toThrow(/format/);
    expect(() => normalizeEmoSimDirectedRelationshipReading({ ...valid, sampleCount: 0 }, 'r')).toThrow(/sampleCount/);
    expect(() => normalizeEmoSimDirectedRelationshipReading({ ...valid, liking: 'hot' }, 'r')).toThrow(/liking/);
  });
});

describe('renderDyadRelationshipAdvisory', () => {
  it('renders prose (no raw scores) with classifier-inferred provenance', () => {
    const advisory = renderDyadRelationshipAdvisory(
      {
        format: EMOSIM_DIRECTED_RELATIONSHIP_FORMAT,
        agentName: AGENT,
        sampleCount: 1,
        liking: 0.7,
        trust: 0.2,
        dominance: -0.4,
        familiarity: 0.6,
        topEmotionShift: { label: 'Love', delta: 0.3 },
      },
      1_000,
    );
    expect(advisory).not.toBeNull();
    expect(advisory?.provenance.source).toBe('classifier_inferred');
    expect(advisory?.provenance.classifier).toBe('emo_sim');
    expect(advisory?.observedAtMs).toBe(1_000);
    // Charter 8.6: prose, no numeric scores leaked.
    expect(advisory?.prose).toMatch(/warmth reads/);
    expect(advisory?.prose).not.toMatch(/0\.\d/);
  });

  it('returns null when no dimension is present', () => {
    expect(renderDyadRelationshipAdvisory(
      {
        format: EMOSIM_DIRECTED_RELATIONSHIP_FORMAT,
        agentName: AGENT,
        sampleCount: 1,
        liking: null,
        trust: null,
        dominance: null,
        familiarity: null,
        topEmotionShift: null,
      },
      null,
    )).toBeNull();
  });
});

function okResult(relationship: unknown): EmoSimAdapterRunResult {
  return {
    ok: true,
    schemaVersion: 2,
    adapterVersion: 'psfn.observer-sidecar.emosim-adapter.v2',
    // Only the fields the provider reads are exercised here.
    output: {
      relationship,
      input: { deterministic: { observedAt: '2026-07-06T00:00:00.000Z' } },
    },
  } as unknown as EmoSimAdapterRunResult;
}

describe('createEmoSimDyadRelationshipAdvisoryProvider', () => {
  const reading: EmoSimDirectedRelationshipReading = {
    format: EMOSIM_DIRECTED_RELATIONSHIP_FORMAT,
    agentName: AGENT,
    sampleCount: 1,
    liking: 0.7,
    trust: null,
    dominance: null,
    familiarity: 0.5,
    topEmotionShift: null,
  };

  it('renders the advisory from the latest persisted reading', async () => {
    const provider = createEmoSimDyadRelationshipAdvisoryProvider({
      getLatestObservation: async () => ({ emosim: okResult(reading) }),
    });
    const advisory = await provider.describeLatestDirectedRelationship();
    expect(advisory?.prose).toMatch(/warmth reads/);
  });

  it('returns null (omit) when there is no observation, no emosim, or no relationship', async () => {
    for (const emosim of [undefined, { ok: false } as unknown as EmoSimAdapterRunResult]) {
      const provider = createEmoSimDyadRelationshipAdvisoryProvider({
        getLatestObservation: async () => (emosim ? { emosim } : null),
      });
      expect(await provider.describeLatestDirectedRelationship()).toBeNull();
    }
    const noRel = createEmoSimDyadRelationshipAdvisoryProvider({
      getLatestObservation: async () => ({ emosim: okResult(undefined) }),
    });
    expect(await noRel.describeLatestDirectedRelationship()).toBeNull();
  });

  it('omits (null) on a malformed persisted reading — logged, not thrown', async () => {
    const provider = createEmoSimDyadRelationshipAdvisoryProvider({
      getLatestObservation: async () => ({ emosim: okResult({ format: 'wrong' }) }),
    });
    expect(await provider.describeLatestDirectedRelationship()).toBeNull();
  });

  it('fails closed at the infrastructure boundary: store errors throw unavailable', async () => {
    const provider = createEmoSimDyadRelationshipAdvisoryProvider({
      getLatestObservation: () => Promise.reject(new Error('db down')),
    });
    await expect(provider.describeLatestDirectedRelationship()).rejects.toBeInstanceOf(
      DyadRelationshipAdvisoryUnavailableError,
    );
  });

  it('does not swallow: the store is read exactly once per call', async () => {
    const getLatestObservation = vi.fn(async () => ({ emosim: okResult(reading) }));
    const provider = createEmoSimDyadRelationshipAdvisoryProvider({ getLatestObservation });
    await provider.describeLatestDirectedRelationship();
    expect(getLatestObservation).toHaveBeenCalledTimes(1);
  });
});
