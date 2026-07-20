import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmotionState } from '../emotion/state.js';
import { EventBus } from '../../shared/event-bus.js';
import { ReflectionJournalStore } from '../../persistence/journals/reflection-journal.js';
import {
  buildConcernResolutionArcEntry,
  createConcernResolutionArcRecorder,
  reconcileConcernResolutionArcs,
  type ConcernArcConcernSource,
} from './concern-resolution-arc.js';
import { emitConcernResolutionAppraisal } from './concern-resolution-appraisal.js';
import type { ActiveConcern } from './concerns.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';
import { AdminConcernDataService } from '../../operator/garden/services/concern-service.js';

function concernFixture(overrides: Partial<ActiveConcern> = {}): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Follow up on the migration rollback',
    priority: 'medium',
    source: 'agent',
    status: 'resolved',
    createdAt: '2026-06-29T10:00:00.000Z',
    expiresAt: '2026-06-30T10:00:00.000Z',
    salience: 0.42,
    sensitivity: 'personal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    resolvedAt: '2026-06-29T12:00:00.000Z',
    formationVAD: { valence: -0.4, arousal: 0.6, dominance: -0.2 },
    resolutionVAD: { valence: 0.3, arousal: 0.1, dominance: 0.2 },
    resolutionGenerationId: 'generation-1',
    ...overrides,
  };
}

function fakeConcernStore(concern: ActiveConcern | null): ConcernArcConcernSource {
  return { getById: (id: string) => (concern && concern.id === id ? concern : null) };
}

describe('buildConcernResolutionArcEntry', () => {
  it('carries concern id, both VADs, relief delta, duration, and final salience with internal provenance', () => {
    const entry = buildConcernResolutionArcEntry({ concern: concernFixture(), source: 'decision' });
    expect(entry).not.toBeNull();
    expect(entry?.mode).toBe('agent');
    expect(entry?.templateId).toBe('concern_arc');
    expect(entry?.substrateBoundary).toBe('concern-resolution-arc');
    expect(entry?.substrateProvenanceRefs).toEqual(['concern:concern-1']);
    expect(entry?.reflection).toContain('When it formed this sat');
    expect(entry?.reflection).toContain('resolving it, that settled to');
    // Prose only — the raw machinery lives in structured telemetry, not the reflection.
    expect(entry?.reflection).not.toMatch(/-?0\.\d/);
    const arc = entry?.concernArc;
    expect(arc?.concernId).toBe('concern-1');
    expect(arc?.formationVAD).toEqual({ valence: -0.4, arousal: 0.6, dominance: -0.2 });
    expect(arc?.resolutionVAD).toEqual({ valence: 0.3, arousal: 0.1, dominance: 0.2 });
    expect(arc?.reliefDelta.valence).toBeCloseTo(0.7, 10);
    expect(arc?.reliefDelta.arousal).toBeCloseTo(-0.5, 10);
    expect(arc?.source).toBe('decision');
    expect(arc?.durationMs).toBe(2 * 60 * 60 * 1_000);
    expect(arc?.finalSalience).toBe(0.42);
  });

  it('returns null when the formation VAD is missing (no fabrication)', () => {
    const entry = buildConcernResolutionArcEntry({
      concern: concernFixture({ formationVAD: undefined }),
      source: 'decision',
    });
    expect(entry).toBeNull();
  });

  it('returns null when the resolution VAD is missing (no fabrication)', () => {
    const entry = buildConcernResolutionArcEntry({
      concern: concernFixture({ resolutionVAD: undefined }),
      source: 'grooming_stale',
    });
    expect(entry).toBeNull();
  });
});

describe('createConcernResolutionArcRecorder', () => {
  let tempDir: string;
  let journal: ReflectionJournalStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'concern-arc-'));
    journal = new ReflectionJournalStore(join(tempDir, 'concern-arcs.jsonl'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a queryable arc when the resolution appraisal event fires', async () => {
    const eventBus = new EventBus();
    const recorder = createConcernResolutionArcRecorder({
      concernStore: fakeConcernStore(concernFixture()),
      journal,
    });
    eventBus.on('intention.concern.resolution_appraisal', recorder);

    const emitted = await emitConcernResolutionAppraisal(eventBus, {
      concern: concernFixture(),
      source: 'decision',
      now: () => 42,
    });
    expect(emitted).toBe(true);
    // Handlers run async under emit; give the microtask queue a tick.
    await new Promise(resolve => setImmediate(resolve));

    const entries = journal.listRecent({ limit: 5 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.templateId).toBe('concern_arc');
    expect(entries[0]?.substrateProvenanceRefs).toEqual(['concern:concern-1']);
    expect(entries[0]?.telemetry?.concernArc?.concernId).toBe('concern-1');
    expect(entries[0]?.telemetry?.concernArc?.formationVAD).toEqual({ valence: -0.4, arousal: 0.6, dominance: -0.2 });
    expect(entries[0]?.telemetry?.concernArc?.resolutionVAD).toEqual({ valence: 0.3, arousal: 0.1, dominance: 0.2 });
  });

  it('writes nothing when the resolved concern lacks a VAD snapshot', async () => {
    const recorder = createConcernResolutionArcRecorder({
      concernStore: fakeConcernStore(concernFixture({ resolutionVAD: undefined })),
      journal,
    });
    await recorder({
      concernId: 'concern-1',
      resolutionGenerationId: 'generation-1',
      source: 'grooming_cap',
      formationVad: { valence: -0.4, arousal: 0.6, dominance: -0.2 },
      resolutionVad: { valence: 0.3, arousal: 0.1, dominance: 0.2 },
      reliefDelta: { valence: 0.7, arousal: -0.5, dominance: 0.4 },
      timestamp: 1,
    });
    expect(journal.listRecent({ limit: 5 })).toHaveLength(0);
  });

  it('skips (without throwing) when the resolved concern cannot be found', async () => {
    const recorder = createConcernResolutionArcRecorder({
      concernStore: fakeConcernStore(null),
      journal,
    });
    await expect(recorder({
      concernId: 'missing',
      resolutionGenerationId: 'generation-missing',
      source: 'decision',
      formationVad: { valence: -0.4, arousal: 0.6, dominance: -0.2 },
      resolutionVad: { valence: 0.3, arousal: 0.1, dominance: 0.2 },
      reliefDelta: { valence: 0.7, arousal: -0.5, dominance: 0.4 },
      timestamp: 1,
    })).resolves.toBeUndefined();
    expect(journal.listRecent({ limit: 5 })).toHaveLength(0);
  });

  it('records and applies each immutable resolution generation exactly once', async () => {
    const emotionState = new EmotionState();
    let concern = concernFixture();
    const recorder = createConcernResolutionArcRecorder({
      concernStore: { getById: () => concern },
      journal,
      emotionSink: {
        applyConcernResolutionDelta: (_concern, generationId, delta) => (
          emotionState.applyConcernResolutionDelta(generationId, delta) ? 'applied' : 'duplicate'
        ),
      },
    });
    const eventBus = new EventBus();
    eventBus.on('intention.concern.resolution_appraisal', recorder);

    await emitConcernResolutionAppraisal(eventBus, { concern, source: 'decision' });
    await emitConcernResolutionAppraisal(eventBus, { concern, source: 'decision' });
    expect(journal.listRecent({ limit: 10 })).toHaveLength(1);
    expect(emotionState.getState().vad).toEqual({ valence: 0.7, arousal: -0.5, dominance: 0.4 });

    concern = concernFixture({ resolutionGenerationId: 'generation-2' });
    await emitConcernResolutionAppraisal(eventBus, { concern, source: 'decision' });
    expect(journal.listRecent({ limit: 10 })).toHaveLength(2);
    expect(emotionState.getState().vad).toEqual({ valence: 1, arousal: -1, dominance: 0.8 });
  });

  it('makes a failed required journal write visible and recoverable without double-applying emotion', async () => {
    const emotionState = new EmotionState();
    const appendOnce = journal.appendOnce.bind(journal);
    let attempts = 0;
    const failingJournal = {
      hasEntry: (id: string) => journal.hasEntry(id),
      appendOnce: (id: string, input: Parameters<typeof journal.append>[0]) => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk unavailable');
        return appendOnce(id, input);
      },
    };
    const recorder = createConcernResolutionArcRecorder({
      concernStore: fakeConcernStore(concernFixture()),
      journal: failingJournal,
      emotionSink: {
        applyConcernResolutionDelta: (_concern, generationId, delta) => (
          emotionState.applyConcernResolutionDelta(generationId, delta) ? 'applied' : 'duplicate'
        ),
      },
    });
    const eventBus = new EventBus();
    eventBus.on('intention.concern.resolution_appraisal', recorder);

    await expect(emitConcernResolutionAppraisal(eventBus, {
      concern: concernFixture(),
      source: 'decision',
    })).rejects.toThrow(/disk unavailable/);
    await expect(emitConcernResolutionAppraisal(eventBus, {
      concern: concernFixture(),
      source: 'decision',
    })).resolves.toBe(true);

    expect(journal.listRecent({ limit: 10 })).toHaveLength(1);
    expect(emotionState.getState().vad).toEqual({ valence: 0.7, arousal: -0.5, dominance: 0.4 });
  });

  it('runs the production lifecycle from Postgres resolution through event, arc query, and emotion input', async () => {
    const intention = createTestPostgresIntentionPorts({
      now: () => new Date('2026-06-29T12:00:00.000Z'),
      idFactory: () => 'concern-production-path',
    });
    const concernStore = intention.ports.concernStore;
    const emotionState = new EmotionState();
    const eventBus = new EventBus();
    const observedEvents: string[] = [];
    const recorder = createConcernResolutionArcRecorder({
      concernStore,
      journal,
      emotionSink: {
        applyConcernResolutionDelta: (_concern, generationId, delta) => (
          emotionState.applyConcernResolutionDelta(generationId, delta) ? 'applied' : 'duplicate'
        ),
      },
    });
    eventBus.on('intention.concern.resolution_appraisal', recorder);
    eventBus.on('intention.concern.resolution_appraisal', event => {
      observedEvents.push(event.resolutionGenerationId);
    });

    const created = await concernStore.create({
      text: 'Production resolution path',
      contactId: 'contact-a',
      formationVAD: { valence: -0.3, arousal: 0.4, dominance: -0.2 },
    });
    const resolved = await concernStore.resolveConcern(created.id, {
      outcome: 'Completed end to end',
      resolutionVAD: { valence: 0.2, arousal: 0.1, dominance: 0.3 },
    });
    expect(resolved?.resolutionGenerationId).toEqual(expect.any(String));
    await emitConcernResolutionAppraisal(eventBus, {
      concern: resolved!,
      source: 'decision',
    });

    const query = new AdminConcernDataService(concernStore, journal);
    const result = await query.listConcernArcs(created.id, {
      provenanceRef: `concern:${created.id}`,
    });
    expect(observedEvents).toEqual([resolved!.resolutionGenerationId]);
    expect(result.arcs).toEqual([
      expect.objectContaining({
        arc: expect.objectContaining({
          concernId: created.id,
          resolutionGenerationId: resolved!.resolutionGenerationId,
        }),
      }),
    ]);
    expect(emotionState.getState().vad).toEqual({
      valence: expect.closeTo(0.5, 10),
      arousal: expect.closeTo(-0.3, 10),
      dominance: expect.closeTo(0.5, 10),
    });
  });

  it('reconciles a persisted resolution that missed delivery without duplicating it on restart', async () => {
    const concern = concernFixture();
    const emotionState = new EmotionState();
    const concernStore = {
      getById: () => concern,
      list: async () => [concern],
    };
    const recorder = createConcernResolutionArcRecorder({
      concernStore,
      journal,
      emotionSink: {
        applyConcernResolutionDelta: (_concern, generationId, delta) => (
          emotionState.applyConcernResolutionDelta(generationId, delta) ? 'applied' : 'duplicate'
        ),
      },
    });

    await reconcileConcernResolutionArcs({ concernStore, recorder, now: () => 42 });
    await reconcileConcernResolutionArcs({ concernStore, recorder, now: () => 43 });

    expect(journal.listRecent({ limit: 10 })).toHaveLength(1);
    expect(emotionState.getState().vad).toEqual({
      valence: 0.7,
      arousal: -0.5,
      dominance: 0.4,
    });
  });
});
