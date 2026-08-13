import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import {
  rehydratePersistedInternalState,
  type PersistedInternalStateRecord,
} from '../../core/self-model/internal-state-persistence.js';
import {
  buildInternalStateSnapshotRef,
  type InternalState,
  type SituatedLocation,
} from '../../core/self-model/state.js';
import { resolveTurnSituatedFallbackPlaceId } from '../../core/agent/substrate-agent/runtime-context-sections/turn-presence-mode.js';
import { buildSituatedPresenceContextBlock } from '../../core/agent/substrate-agent/runtime-context-sections/situated-presence.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresInternalStateStore } from './internal-state-store.js';

const TEST_IMAGE = 'postgres:16.8-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function buildPersistedState(): PersistedInternalStateRecord {
  const state: InternalState = {
    emotional: {
      vad: { valence: 0.4, arousal: 0.1, dominance: 0 },
      mood: { valence: 0.3, arousal: 0, dominance: 0.1 },
      discreteEmotions: { joy: 0.6 },
      confidence: 0.8,
    },
    cognitive: {
      certaintyLevel: 0.7,
      topicEngagement: 0.5,
      processingQuality: 'fluent',
    },
    attention: {
      activeConcerns: [],
      pendingFollowUps: [],
      careReminders: [],
      salientEntities: ['garden'],
      conversationTrajectory: 'casual',
    },
    relational: {
      contactId: 'contact-1',
      trustLevel: 'primary',
      baselineValence: 0.2,
      moodDrift: 0,
      recentInteractionFrequency: 0.5,
      lastSeenDeltaSeconds: 120,
    },
    situated: {
      location: {
        placeId: 'place.living-room',
        siteId: 'site.home',
        label: 'Living Room',
        kind: 'physical',
        updatedAt: '2026-08-10T12:00:00.000Z',
      },
    },
  };
  return {
    state,
    snapshotRef: buildInternalStateSnapshotRef(state),
    metacognitiveFlags: [],
    savedAt: '2026-08-10T12:05:00.000Z',
  };
}

const PLACES: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [
    { siteId: 'site.home', displayName: 'Home', kind: 'physical' },
    { siteId: 'site.virtual', displayName: 'Shared Space', kind: 'virtual' },
  ],
  places: [
    {
      placeId: 'place.living-room',
      siteId: 'site.home',
      displayName: 'Living Room',
      kind: 'physical',
      affordances: [],
    },
    {
      placeId: 'place.living-room-twin',
      siteId: 'site.virtual',
      displayName: 'Shared Living Room',
      kind: 'virtual',
      mirrorsPlaceId: 'place.living-room',
      affordances: [],
    },
  ],
};

describe('PostgresInternalStateStore restart continuity', () => {
  it('round-trips durable location and restores its mindspace twin after a stale-state restart', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const writer = await PostgresInternalStateStore.connect(database.databaseUrl);
    const persisted = buildPersistedState();
    await writer.save(persisted);

    // A separate store instance models a new process reading the canonical row.
    const restartReader = await PostgresInternalStateStore.connect(database.databaseUrl);
    const restoreFullState = vi.fn();
    let restoredLocation: SituatedLocation | null = null;
    const result = await rehydratePersistedInternalState({
      store: restartReader,
      agent: {
        restorePersistedInternalState: restoreFullState,
        restorePersistedSituatedLocation: (location) => { restoredLocation = location; },
        noteInternalStateContinuityGap: vi.fn(),
      },
      now: new Date('2026-08-13T12:05:00.000Z'),
    });

    expect(result.outcome).toBe('gap_detected');
    expect(restoreFullState).not.toHaveBeenCalled();
    expect(restoredLocation).toEqual(persisted.state.situated.location);

    const message = {
      id: 'plain-turn-after-restart',
      channelId: 'api:plain-turn',
      channelType: 'api',
      authorId: 'partner',
      authorName: 'Partner',
      content: 'hello after restart',
      timestamp: new Date('2026-08-13T12:05:01.000Z'),
    } as SubstrateMessage;
    const fallback = resolveTurnSituatedFallbackPlaceId({
      message,
      placesRegistry: PLACES,
      durableLocation: restoredLocation,
    });
    const section = buildSituatedPresenceContextBlock({
      message,
      placesRegistry: PLACES,
      ...(fallback ? { situatedFallbackPlaceId: fallback } : {}),
    });

    expect(fallback).toBe('place.living-room-twin');
    expect(section).toContain('<runtime_situated_presence>');
    expect(section).toContain('Shared mindspace: Shared Living Room (virtual twin of Living Room)');
  }, INTEGRATION_TIMEOUT_MS);
});
