import { describe, expect, it } from 'vitest';
import { buildSituatedLocationPromptVariables } from './internal-state.js';
import type { InternalState, SituatedLocation } from '../../../self-model/state.js';

const NOW = new Date('2026-07-08T18:00:00.000Z');

function makeInternalState(location: SituatedLocation | null): InternalState {
  return {
    emotional: {
      vad: { valence: 0, arousal: 0, dominance: 0 },
      mood: { valence: 0, arousal: 0, dominance: 0 },
      discreteEmotions: {},
      confidence: 0,
      telemetry: {
        status: 'trusted',
        reasons: [],
        source: 'runtime_state',
        observedAtMs: 0,
        ageMs: 0,
        provenance: [],
      } as unknown as InternalState['emotional']['telemetry'],
    },
    cognitive: { certaintyLevel: 0.5, topicEngagement: 0.5, processingQuality: 'fluent' },
    attention: {
      activeConcerns: [],
      pendingFollowUps: [],
      careReminders: [],
      salientEntities: [],
      conversationTrajectory: 'casual',
    },
    relational: {
      contactId: null,
      trustLevel: 'trusted',
      baselineValence: 0,
      moodDrift: 0,
      recentInteractionFrequency: 0,
      lastSeenDeltaSeconds: null,
    },
    situated: { location },
  };
}

describe('buildSituatedLocationPromptVariables', () => {
  it('renders bare values for a freshly-confirmed location (not stale)', () => {
    const vars = buildSituatedLocationPromptVariables(
      makeInternalState({
        placeId: 'living-room',
        siteId: 'home',
        label: 'the living room',
        kind: 'physical',
        updatedAt: NOW.toISOString(),
      }),
      NOW,
    );

    expect(vars.runtime_situated_location_present).toBe('true');
    expect(vars.runtime_situated_location_label).toBe('the living room');
    expect(vars.runtime_situated_location_kind).toBe('physical');
    expect(vars.runtime_situated_location_place_id).toBe('living-room');
    expect(vars.runtime_situated_location_site_id).toBe('home');
    expect(vars.runtime_situated_location_updated_at).toBe(NOW.toISOString());
    expect(vars.runtime_situated_location_age_label).toBe('just now');
    expect(vars.runtime_situated_location_is_stale).toBe('');
  });

  it('carries honest age and marks a long-unconfirmed location stale', () => {
    const eightHoursAgo = new Date(NOW.getTime() - 8 * 60 * 60 * 1000).toISOString();
    const vars = buildSituatedLocationPromptVariables(
      makeInternalState({
        placeId: null,
        siteId: null,
        label: 'the kitchen satellite',
        kind: null,
        updatedAt: eightHoursAgo,
      }),
      NOW,
    );

    expect(vars.runtime_situated_location_present).toBe('true');
    expect(vars.runtime_situated_location_kind).toBe('');
    expect(vars.runtime_situated_location_place_id).toBe('');
    expect(vars.runtime_situated_location_age_label).toBe('about 8 hours ago');
    expect(vars.runtime_situated_location_is_stale).toBe('true');
    expect(vars.runtime_situated_location_updated_at).toBe(eightHoursAgo);
  });

  it('renders present=false (section prunes) for absent location', () => {
    const vars = buildSituatedLocationPromptVariables(makeInternalState(null), NOW);
    expect(vars.runtime_situated_location_present).toBe('false');
    expect(vars.runtime_situated_location_label).toBe('');
    expect(vars.runtime_situated_location_updated_at).toBe('');
    expect(vars.runtime_situated_location_age_label).toBe('');
    expect(vars.runtime_situated_location_is_stale).toBe('');
  });

  it('renders present=false when no internal state exists', () => {
    const vars = buildSituatedLocationPromptVariables(undefined, NOW);
    expect(vars.runtime_situated_location_present).toBe('false');
  });
});
