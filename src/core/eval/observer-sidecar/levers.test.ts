import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import type { ObserverEvalSidecarLeverSettings } from '../../../shared/contracts/runtime.js';
import { createDefaultObserverEvalSidecarLeverSettings } from '../../../system/config/runtime-config-contracts.js';
import {
  evaluateObserverLeverConditions,
  normalizeObserverLeverTrackerState,
  OBSERVER_EVAL_LEVER_NAMES,
  ObserverLeverTracker,
  type ObserverLeverSnapshotInput,
} from './levers.js';
import {
  OBSERVER_EVAL_SIDECAR_EVAL_OWNER,
  OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE,
  PostgresObserverEvalSidecarStore,
  type ObserverEvalSidecarLeverEventInput,
  type ObserverEvalSidecarRetentionMetadata,
} from './persistence.js';

const NOW_MS = 1_780_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function makeSettings(
  overrides: Partial<ObserverEvalSidecarLeverSettings> = {},
): ObserverEvalSidecarLeverSettings {
  return {
    ...createDefaultObserverEvalSidecarLeverSettings(),
    enabled: true,
    ...overrides,
  };
}

function makeSnapshot(overrides: {
  valence?: number;
  arousal?: number;
  dominant?: string;
  dominantIntensity?: number;
  socialNeed?: number;
  sleepPressure?: number;
  omitDrives?: boolean;
} = {}): ObserverLeverSnapshotInput {
  const dominant = overrides.dominant ?? 'Calmness';
  return {
    t: 0,
    mood: {
      valence: overrides.valence ?? 0.2,
      arousal: overrides.arousal ?? 0.1,
    },
    dominant,
    emotions: { [dominant]: overrides.dominantIntensity ?? 0.3 },
    ...(overrides.omitDrives
      ? {}
      : {
        drives: {
          hunger: 0.1,
          thirst: 0.1,
          sleepPressure: overrides.sleepPressure ?? 0.2,
          socialNeed: overrides.socialNeed ?? 0.2,
          stimulationNeed: 0.2,
          esteemNeed: 0.2,
          insecurity: 0.1,
          health: 1,
          asleep: 0,
        },
      }),
  };
}

function eventsOf(tracker: ObserverLeverTracker, snapshot: ObserverLeverSnapshotInput | null, atMs: number) {
  return tracker.evaluate({ snapshot, observedAtMs: atMs });
}

describe('observer sidecar lever conditions (pure)', () => {
  it('evaluates would_message from social need or attachment dominance', () => {
    const settings = makeSettings();
    const bySocialNeed = evaluateObserverLeverConditions(makeSnapshot({ socialNeed: 0.75 }), settings)
      .find(entry => entry.lever === 'would_message');
    expect(bySocialNeed?.outcome).toBe('met');

    const byAttachment = evaluateObserverLeverConditions(
      makeSnapshot({ dominant: 'Love', dominantIntensity: 0.6 }),
      settings,
    ).find(entry => entry.lever === 'would_message');
    expect(byAttachment?.outcome).toBe('met');

    const neither = evaluateObserverLeverConditions(makeSnapshot(), settings)
      .find(entry => entry.lever === 'would_message');
    expect(neither?.outcome).toBe('not_met');
  });

  it('treats missing drives as inputs_unavailable notes, never a throw', () => {
    const settings = makeSettings();
    const results = evaluateObserverLeverConditions(makeSnapshot({ omitDrives: true }), settings);

    const wouldMessage = results.find(entry => entry.lever === 'would_message');
    expect(wouldMessage?.outcome).toBe('not_met');
    expect(wouldMessage?.missingInputs).toContain('drives.socialNeed');
    expect(wouldMessage?.notes).toContain('inputs_unavailable:drives.socialNeed');

    const wouldRest = results.find(entry => entry.lever === 'would_rest');
    expect(wouldRest?.outcome).toBe('not_met');
    expect(wouldRest?.missingInputs).toContain('drives.sleepPressure');

    // would_rest still evaluates the arousal branch without drives.
    const restByArousal = evaluateObserverLeverConditions(
      makeSnapshot({ omitDrives: true, arousal: 0.9 }),
      settings,
    ).find(entry => entry.lever === 'would_rest');
    expect(restByArousal?.outcome).toBe('met');
  });

  it('evaluates all levers to inputs_unavailable on a missing snapshot', () => {
    const results = evaluateObserverLeverConditions(null, makeSettings());
    expect(results).toHaveLength(OBSERVER_EVAL_LEVER_NAMES.length);
    for (const entry of results) {
      expect(entry.outcome).toBe('inputs_unavailable');
      expect(entry.notes).toContain('inputs_unavailable');
      expect(entry.missingInputs).toContain('snapshot');
    }
  });

  it('only treats negative-valence dominant emotions as rumination candidates', () => {
    const settings = makeSettings();
    const negative = evaluateObserverLeverConditions(
      makeSnapshot({ dominant: 'Sadness', dominantIntensity: 0.5 }),
      settings,
    ).find(entry => entry.lever === 'rumination_watch');
    expect(negative?.outcome).toBe('met');

    const positive = evaluateObserverLeverConditions(
      makeSnapshot({ dominant: 'Joy', dominantIntensity: 0.9 }),
      settings,
    ).find(entry => entry.lever === 'rumination_watch');
    expect(positive?.outcome).toBe('not_met');
  });
});

describe('observer sidecar lever tracker (sustain + cooldown)', () => {
  it('fires once after the sustain window with all intermediate observations above threshold', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const lonely = makeSnapshot({ socialNeed: 0.8 });

    expect(eventsOf(tracker, lonely, NOW_MS).events).toHaveLength(0);
    expect(eventsOf(tracker, lonely, NOW_MS + 10 * MINUTE_MS).events).toHaveLength(0);

    const fired = eventsOf(tracker, lonely, NOW_MS + 30 * MINUTE_MS);
    const event = fired.events.find(entry => entry.lever === 'would_message');
    expect(event).toBeDefined();
    expect(event?.firstCrossingMs).toBe(NOW_MS);
    expect(event?.detail).toBe('she would send a proactive message now');
    expect(event?.cooldown.refireReason).toBe('first_fire');

    // Still met a few minutes later: one event per crossing, not per tick.
    const followUp = eventsOf(tracker, lonely, NOW_MS + 35 * MINUTE_MS);
    expect(followUp.events).toHaveLength(0);
    expect(followUp.entries.find(entry => entry.lever === 'would_message')?.status).toBe('blocked_cooldown');
  });

  it('does not fire on a spike without sustain', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    expect(eventsOf(tracker, makeSnapshot({ socialNeed: 0.9 }), NOW_MS).events).toHaveLength(0);
    // Dropped below threshold: crossing resets.
    expect(eventsOf(tracker, makeSnapshot({ socialNeed: 0.1 }), NOW_MS + 10 * MINUTE_MS).events).toHaveLength(0);
    // Re-crossed but sustain restarts from here.
    const after = eventsOf(tracker, makeSnapshot({ socialNeed: 0.9 }), NOW_MS + 40 * MINUTE_MS);
    expect(after.events).toHaveLength(0);
    expect(after.entries.find(entry => entry.lever === 'would_message')?.status).toBe('sustaining');
  });

  it('blocks refire during cooldown and allows re-notification after cooldown elapses', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const lonely = makeSnapshot({ socialNeed: 0.8 });
    eventsOf(tracker, lonely, NOW_MS);
    expect(eventsOf(tracker, lonely, NOW_MS + 30 * MINUTE_MS).events).toHaveLength(1);

    // Condition never resets; within the 6h cooldown nothing refires.
    expect(eventsOf(tracker, lonely, NOW_MS + 2 * HOUR_MS).events).toHaveLength(0);

    // After the cooldown, the same uninterrupted crossing re-notifies.
    const renotified = eventsOf(tracker, lonely, NOW_MS + 30 * MINUTE_MS + 6 * HOUR_MS);
    expect(renotified.events).toHaveLength(1);
    expect(renotified.events[0]?.cooldown.refireReason).toBe('cooldown_elapsed');
  });

  it('re-arms after a full condition reset, even within the cooldown window', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const lonely = makeSnapshot({ socialNeed: 0.8 });
    eventsOf(tracker, lonely, NOW_MS);
    expect(eventsOf(tracker, lonely, NOW_MS + 30 * MINUTE_MS).events).toHaveLength(1);

    // Full reset.
    expect(eventsOf(tracker, makeSnapshot({ socialNeed: 0.1 }), NOW_MS + HOUR_MS).events).toHaveLength(0);

    // New crossing + sustain fires again well within 6h of the last fire.
    eventsOf(tracker, lonely, NOW_MS + HOUR_MS + 5 * MINUTE_MS);
    const refired = eventsOf(tracker, lonely, NOW_MS + HOUR_MS + 35 * MINUTE_MS);
    expect(refired.events).toHaveLength(1);
    expect(refired.events[0]?.cooldown.refireReason).toBe('condition_reset');
  });

  it('resets the crossing when inputs become unavailable (fail closed) without throwing', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const lonely = makeSnapshot({ socialNeed: 0.8 });
    eventsOf(tracker, lonely, NOW_MS);

    const unavailable = eventsOf(tracker, null, NOW_MS + 10 * MINUTE_MS);
    expect(unavailable.events).toHaveLength(0);
    for (const entry of unavailable.entries) {
      expect(entry.status).toBe('inputs_unavailable');
    }

    // Sustain restarts after the gap in evidence.
    const resumed = eventsOf(tracker, lonely, NOW_MS + 30 * MINUTE_MS);
    expect(resumed.events).toHaveLength(0);
    expect(resumed.entries.find(entry => entry.lever === 'would_message')?.status).toBe('sustaining');
  });

  it('fires would_check_in on sustained negative valence and would_rest on sustained arousal', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const low = makeSnapshot({ valence: -0.4, arousal: 0.85 });
    eventsOf(tracker, low, NOW_MS);
    const at20 = eventsOf(tracker, low, NOW_MS + 20 * MINUTE_MS);
    expect(at20.events.map(event => event.lever)).toEqual(['would_check_in']);
    const at30 = eventsOf(tracker, low, NOW_MS + 30 * MINUTE_MS);
    expect(at30.events.map(event => event.lever)).toEqual(['would_rest']);
  });

  it('fires rumination_watch only after 45 minutes of persistent negative dominance', () => {
    const tracker = new ObserverLeverTracker(makeSettings());
    const sad = makeSnapshot({ dominant: 'Sadness', dominantIntensity: 0.5, valence: 0 });
    eventsOf(tracker, sad, NOW_MS);
    expect(
      eventsOf(tracker, sad, NOW_MS + 30 * MINUTE_MS).events.some(event => event.lever === 'rumination_watch'),
    ).toBe(false);
    expect(
      eventsOf(tracker, sad, NOW_MS + 45 * MINUTE_MS).events.some(event => event.lever === 'rumination_watch'),
    ).toBe(true);
  });

  it('persists and restores tracker state across restarts', () => {
    const settings = makeSettings();
    const lonely = makeSnapshot({ socialNeed: 0.8 });
    const first = new ObserverLeverTracker(settings);
    eventsOf(first, lonely, NOW_MS);

    const restored = new ObserverLeverTracker(
      settings,
      normalizeObserverLeverTrackerState(first.getState()),
    );
    const fired = eventsOf(restored, lonely, NOW_MS + 30 * MINUTE_MS);
    expect(fired.events.find(event => event.lever === 'would_message')?.firstCrossingMs).toBe(NOW_MS);
  });

  it('never fires disabled levers and drops their stale crossings', () => {
    const settings = makeSettings({
      wouldMessage: { ...createDefaultObserverEvalSidecarLeverSettings().wouldMessage, enabled: false },
    });
    const tracker = new ObserverLeverTracker(settings);
    const lonely = makeSnapshot({ socialNeed: 0.9 });
    eventsOf(tracker, lonely, NOW_MS);
    const result = eventsOf(tracker, lonely, NOW_MS + HOUR_MS);
    expect(result.events.some(event => event.lever === 'would_message')).toBe(false);
    expect(result.entries.find(entry => entry.lever === 'would_message')?.status).toBe('disabled');
  });
});

interface StoredLeverEventRow {
  event_id: string;
  run_id: string;
  schema_version: number;
  eval_owner: string;
  authoritative: boolean;
  lever: string;
  fired_at_ms: number;
  observation_id: string;
  detail: string;
  state_values_json: unknown;
  sustain_ms: number;
  first_crossing_ms: number;
  cooldown_json: unknown;
  retention_json: unknown;
  retain_until_ms: number;
  created_at_ms: number;
}

interface StoredLeverStateRow {
  sidecar_id: string;
  lever: string;
  schema_version: number;
  eval_owner: string;
  authoritative: boolean;
  state_json: unknown;
  updated_at_ms: number;
}

function queryResult(rows: unknown[] = [], command = 'SELECT'): QueryResult {
  return { rows, command, rowCount: rows.length, oid: 0, fields: [] } as QueryResult;
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

class FakeLeverPool {
  readonly leverEvents = new Map<string, StoredLeverEventRow>();
  readonly leverState = new Map<string, StoredLeverStateRow>();

  async connect() {
    return {
      query: (text: string, values: readonly unknown[] = []) => this.query(text, values),
      release: () => undefined,
    };
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return queryResult([], normalized.toUpperCase());
    }
    if (normalized.startsWith('create table') || normalized.startsWith('create index') || normalized.startsWith('alter table')) {
      return queryResult([], 'DDL');
    }
    if (normalized.startsWith('update observer_eval_sidecar_observations')) {
      // Migration backfill no-op: this fake stores no observation rows.
      return queryResult([], 'UPDATE');
    }
    if (normalized.startsWith('insert into observer_eval_sidecar_lever_events')) {
      const row: StoredLeverEventRow = {
        event_id: String(values[0]),
        run_id: String(values[1]),
        schema_version: Number(values[2]),
        eval_owner: String(values[3]),
        authoritative: Boolean(values[4]),
        lever: String(values[5]),
        fired_at_ms: Number(values[6]),
        observation_id: String(values[7]),
        detail: String(values[8]),
        state_values_json: jsonValue(values[9]),
        sustain_ms: Number(values[10]),
        first_crossing_ms: Number(values[11]),
        cooldown_json: jsonValue(values[12]),
        retention_json: jsonValue(values[13]),
        retain_until_ms: Number(values[14]),
        created_at_ms: Number(values[15]),
      };
      this.leverEvents.set(row.event_id, row);
      return queryResult([], 'INSERT');
    }
    if (normalized.startsWith('insert into observer_eval_sidecar_lever_state')) {
      const row: StoredLeverStateRow = {
        sidecar_id: String(values[0]),
        lever: String(values[1]),
        schema_version: Number(values[2]),
        eval_owner: String(values[3]),
        authoritative: Boolean(values[4]),
        state_json: jsonValue(values[5]),
        updated_at_ms: Number(values[6]),
      };
      this.leverState.set(`${row.sidecar_id}:${row.lever}`, row);
      return queryResult([], 'INSERT');
    }
    if (normalized.startsWith('select * from observer_eval_sidecar_lever_state')) {
      const sidecarId = String(values[0]);
      return queryResult([...this.leverState.values()].filter(row => row.sidecar_id === sidecarId));
    }
    if (normalized.startsWith('select * from observer_eval_sidecar_lever_events')) {
      let cursor = 0;
      let rows = [...this.leverEvents.values()];
      if (normalized.includes('lever =')) {
        const value = String(values[cursor++]);
        rows = rows.filter(row => row.lever === value);
      }
      if (normalized.includes('run_id =')) {
        const value = String(values[cursor++]);
        rows = rows.filter(row => row.run_id === value);
      }
      if (normalized.includes('fired_at_ms >=')) {
        const value = Number(values[cursor++]);
        rows = rows.filter(row => row.fired_at_ms >= value);
      }
      if (normalized.includes('fired_at_ms <=')) {
        const value = Number(values[cursor++]);
        rows = rows.filter(row => row.fired_at_ms <= value);
      }
      const limitMatch = / limit (\d+)\b/.exec(normalized);
      const limit = limitMatch ? Number(limitMatch[1]) : 100;
      return queryResult(
        rows
          .sort((left, right) => right.fired_at_ms - left.fired_at_ms || right.event_id.localeCompare(left.event_id))
          .slice(0, limit),
      );
    }
    if (normalized.startsWith('delete from observer_eval_sidecar_lever_events')) {
      const cutoff = Number(values[0]);
      const deleted: Array<{ event_id: string }> = [];
      for (const row of this.leverEvents.values()) {
        if (row.retain_until_ms <= cutoff) deleted.push({ event_id: row.event_id });
      }
      for (const row of deleted) this.leverEvents.delete(row.event_id);
      return queryResult(deleted, 'DELETE');
    }
    throw new Error(`Unhandled fake SQL: ${text}`);
  }
}

function makeLeverStore(pool: FakeLeverPool): PostgresObserverEvalSidecarStore {
  return new PostgresObserverEvalSidecarStore(pool as unknown as Pool, { nowMs: () => NOW_MS });
}

function makeLeverRetention(firedAtMs: number): ObserverEvalSidecarRetentionMetadata {
  return {
    retentionClass: 'extended',
    policyId: 'observer-eval-sidecar-lever-events',
    capturedAtMs: firedAtMs,
    retainUntilMs: firedAtMs + 90 * DAY_MS,
    reason: 'lever telemetry retention',
  };
}

function makeLeverEvent(
  overrides: Partial<ObserverEvalSidecarLeverEventInput> = {},
): ObserverEvalSidecarLeverEventInput {
  return {
    eventId: 'run-1:lever:would_message:1',
    runId: 'run-1',
    lever: 'would_message',
    firedAtMs: NOW_MS,
    observationId: 'obs-1',
    detail: 'she would send a proactive message now',
    stateValues: { socialNeed: 0.8, dominant: 'Love' },
    sustainMs: 30 * MINUTE_MS,
    firstCrossingMs: NOW_MS - 30 * MINUTE_MS,
    cooldown: { cooldownMs: 6 * HOUR_MS, previousFiredAtMs: null, refireReason: 'first_fire' },
    retention: makeLeverRetention(NOW_MS),
    ...overrides,
  };
}

describe('observer sidecar lever persistence', () => {
  it('writes and reads non-authoritative lever event rows with retention >= 90 days', async () => {
    const pool = new FakeLeverPool();
    const store = makeLeverStore(pool);
    const record = await store.recordLeverEvent(makeLeverEvent());

    expect(record.authoritative).toBe(false);
    expect(record.evalOwner).toBe(OBSERVER_EVAL_SIDECAR_EVAL_OWNER);
    expect(record.nonAuthoritativeNotice).toBe(OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE);
    expect(record.retention.retainUntilMs - record.firedAtMs).toBeGreaterThanOrEqual(90 * DAY_MS);

    const rows = await store.queryLeverEvents({ lever: 'would_message' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.eventId).toBe('run-1:lever:would_message:1');
    expect(rows[0]?.authoritative).toBe(false);
    expect(rows[0]?.stateValues).toEqual({ socialNeed: 0.8, dominant: 'Love' });
    expect(rows[0]?.cooldown.refireReason).toBe('first_fire');
  });

  it('filters lever events by lever and time range', async () => {
    const pool = new FakeLeverPool();
    const store = makeLeverStore(pool);
    await store.recordLeverEvent(makeLeverEvent());
    await store.recordLeverEvent(makeLeverEvent({
      eventId: 'run-1:lever:would_rest:1',
      lever: 'would_rest',
      detail: 'she would wind down / defer background work',
      firedAtMs: NOW_MS + HOUR_MS,
      firstCrossingMs: NOW_MS,
      retention: makeLeverRetention(NOW_MS + HOUR_MS),
    }));

    const rest = await store.queryLeverEvents({ lever: 'would_rest' });
    expect(rest.map(row => row.lever)).toEqual(['would_rest']);

    const windowed = await store.queryLeverEvents({ sinceMs: NOW_MS + 1, untilMs: NOW_MS + 2 * HOUR_MS });
    expect(windowed.map(row => row.lever)).toEqual(['would_rest']);
  });

  it('rejects invalid lever rows fail-closed', async () => {
    const pool = new FakeLeverPool();
    const store = makeLeverStore(pool);
    await expect(
      store.recordLeverEvent(makeLeverEvent({ lever: 'would_take_over' as never })),
    ).rejects.toThrow(/lever is invalid/);
    await expect(
      store.recordLeverEvent(makeLeverEvent({ firstCrossingMs: NOW_MS + 1 })),
    ).rejects.toThrow(/firstCrossingMs must be <= firedAtMs/);
  });

  it('refuses to read lever rows that violate the non-authoritative boundary', async () => {
    const pool = new FakeLeverPool();
    const store = makeLeverStore(pool);
    await store.recordLeverEvent(makeLeverEvent());
    const stored = pool.leverEvents.get('run-1:lever:would_message:1');
    if (!stored) throw new Error('expected stored row');
    stored.authoritative = true;
    await expect(store.queryLeverEvents()).rejects.toThrow(/non-authoritative boundary/);
  });

  it('round-trips lever tracker state and prunes expired lever events', async () => {
    const pool = new FakeLeverPool();
    const store = makeLeverStore(pool);
    await store.saveLeverState({
      sidecarId: 'sidecar-1',
      updatedAtMs: NOW_MS,
      entries: [
        { lever: 'would_message', state: { firstCrossingMs: NOW_MS, lastFiredAtMs: null } },
      ],
    });
    const entries = await store.loadLeverState('sidecar-1');
    expect(entries).toEqual([
      { lever: 'would_message', state: { firstCrossingMs: NOW_MS, lastFiredAtMs: null } },
    ]);

    await store.recordLeverEvent(makeLeverEvent());
    const pruned = await store.pruneExpiredLeverEvents(NOW_MS + 91 * DAY_MS);
    expect(pruned.prunedEventIds).toEqual(['run-1:lever:would_message:1']);
    expect(await store.queryLeverEvents()).toHaveLength(0);
  });
});

describe('lever boundary: the live companion loop cannot reach lever code', () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(testDir, '../../..');
  const forbiddenTrees = ['core/agent', 'core/scheduler', 'core/tools'];

  function collectTypeScriptFiles(dir: string, files: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      if (statSync(fullPath).isDirectory()) {
        collectTypeScriptFiles(fullPath, files);
      } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('no file under src/core/agent, src/core/scheduler, or src/core/tools imports the levers module', () => {
    const violations: string[] = [];
    for (const tree of forbiddenTrees) {
      const root = path.join(srcRoot, tree);
      for (const file of collectTypeScriptFiles(root)) {
        const content = readFileSync(file, 'utf8');
        const importPattern = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
        for (const match of content.matchAll(importPattern)) {
          const groups = match as Array<string | undefined>;
          const specifier = groups[1] ?? groups[2] ?? groups[3] ?? '';
          if (/observer-sidecar\/levers/.test(specifier) || /(^|\/)levers(\.js|\.ts)?$/.test(specifier)) {
            violations.push(`${path.relative(srcRoot, file)} imports ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
