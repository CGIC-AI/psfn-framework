import type { EmoSimProactivityThresholdProfile } from '../../shared/contracts/runtime.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import {
  createEmoSimProactivityPort,
  normalizeEmoSimProactivityThresholdProfile,
  type EmoSimProactivityResult,
  type EmoSimProactivityState,
} from './emosim-proactivity-port.js';

const REPLAY_COMPANION_ID = '00000000-0000-4000-8000-000000000001';
const REPLAY_LANES = [
  'event_direction',
  'mood_trajectory',
  'outreach_timing',
] as const;

type EmoSimProactivityReplayLane = typeof REPLAY_LANES[number];
type EmoSimProactivityReplayExpectedOutcome = 'fire' | 'defer' | 'suppress';
type EmoSimProactivityReplayOutcome =
  | 'fire'
  | 'defer'
  | 'suppress'
  | 'duplicate'
  | 'fatigue';

interface EmoSimProactivityReplayEvent {
  scenarioId: string;
  lane: EmoSimProactivityReplayLane;
  eventId: string;
  observedAtMs: number;
  confidence: number;
  expected: EmoSimProactivityReplayExpectedOutcome;
  availability?: 'available' | 'unavailable';
  snapshot: {
    dominant: string;
    emotions: Readonly<Record<string, number>>;
    socialNeed: number | null;
  } | null;
}

export interface EmoSimProactivityReplayCorpus {
  schemaVersion: 1;
  corpusVersion: string;
  rawContentRedacted: true;
  events: readonly EmoSimProactivityReplayEvent[];
}

interface ReplayCounts {
  fire: number;
  defer: number;
  suppress: number;
  duplicate: number;
  fatigue: number;
  falsePositive: number;
}

interface ProfileReplayReport {
  profileId: string;
  revision: string;
  counts: ReplayCounts;
  rates: {
    fire: number;
    falsePositive: number;
    fatigue: number;
  };
  promotion: {
    criteriaVersion: string;
    passed: boolean;
    rollbackProfileId: string | null;
  };
}

export interface EmoSimProactivityReplayReport {
  schemaVersion: 1;
  reportVersion: 'emosim-proactivity.replay.v1';
  corpus: {
    corpusVersion: string;
    rawContentRedacted: true;
    eventCount: number;
    lanes: readonly EmoSimProactivityReplayLane[];
  };
  baseline: ProfileReplayReport;
  candidate: ProfileReplayReport;
  divergence: {
    count: number;
    scoredAsAutomaticFailure: false;
  };
}

export async function replayEmoSimProactivityProfiles(input: {
  baseline: unknown;
  candidate: unknown;
  corpus: unknown;
}): Promise<EmoSimProactivityReplayReport> {
  const baseline = normalizeEmoSimProactivityThresholdProfile(input.baseline);
  const candidate = normalizeEmoSimProactivityThresholdProfile(input.candidate);
  const corpus = normalizeCorpus(input.corpus);
  const [baselineRun, candidateRun] = await Promise.all([
    replayProfile(baseline, corpus.events),
    replayProfile(candidate, corpus.events),
  ]);
  return {
    schemaVersion: 1,
    reportVersion: 'emosim-proactivity.replay.v1',
    corpus: {
      corpusVersion: corpus.corpusVersion,
      rawContentRedacted: true,
      eventCount: corpus.events.length,
      lanes: REPLAY_LANES,
    },
    baseline: baselineRun.report,
    candidate: candidateRun.report,
    divergence: {
      count: baselineRun.outcomes.reduce(
        (count, outcome, index) => count + Number(outcome !== candidateRun.outcomes[index]),
        0,
      ),
      scoredAsAutomaticFailure: false,
    },
  };
}

async function replayProfile(
  profile: EmoSimProactivityThresholdProfile,
  events: readonly EmoSimProactivityReplayEvent[],
): Promise<{ report: ProfileReplayReport; outcomes: EmoSimProactivityReplayOutcome[] }> {
  const ports = new Map<string, ReturnType<typeof createEmoSimProactivityPort>>();
  const lastObservedAt = new Map<string, number>();
  const counts = emptyCounts();
  const outcomes: EmoSimProactivityReplayOutcome[] = [];

  for (const event of events) {
    const priorObservedAt = lastObservedAt.get(event.scenarioId);
    if (priorObservedAt !== undefined && event.observedAtMs < priorObservedAt) {
      throw new Error(`EmoSim replay scenario ${event.scenarioId} is not chronological`);
    }
    lastObservedAt.set(event.scenarioId, event.observedAtMs);
    let port = ports.get(event.scenarioId);
    if (!port) {
      port = createReplayPort(profile);
      ports.set(event.scenarioId, port);
    }
    const result = await port.observe({
      companionId: REPLAY_COMPANION_ID,
      observedAtMs: event.observedAtMs,
      source: {
        ...profile.applicableSource,
        availability: event.availability ?? 'available',
        confidence: event.confidence,
      },
      lineage: {
        schemaVersion: 1,
        inputId: `${event.scenarioId}:${event.eventId}`,
        projectionVersion: 'emosim-proactivity.replay-projection.v1',
        privacyClass: 'content_redacted',
        rawContentRedacted: true,
      },
      snapshot: event.snapshot
        ? {
            dominant: event.snapshot.dominant,
            emotions: event.snapshot.emotions,
            drives: event.snapshot.socialNeed === null
              ? null
              : { socialNeed: event.snapshot.socialNeed },
          }
        : null,
    });
    const outcome = classifyResult(result);
    outcomes.push(outcome);
    counts[outcome] += 1;
    if (outcome === 'fire' && event.expected === 'suppress') counts.falsePositive += 1;
  }

  const total = events.length;
  const falsePositiveRate = ratio(counts.falsePositive, counts.fire);
  const fatigueRate = ratio(counts.fatigue, total);
  return {
    outcomes,
    report: {
      profileId: profile.profileId,
      revision: profile.revision,
      counts,
      rates: {
        fire: ratio(counts.fire, total),
        falsePositive: falsePositiveRate,
        fatigue: fatigueRate,
      },
      promotion: {
        criteriaVersion: profile.promotionCriteria.criteriaVersion,
        passed: falsePositiveRate <= profile.promotionCriteria.maximumFalsePositiveRate
          && fatigueRate <= profile.promotionCriteria.maximumFatigueRate,
        rollbackProfileId: profile.rollbackProfileId,
      },
    },
  };
}

function createReplayPort(profile: EmoSimProactivityThresholdProfile) {
  let state: EmoSimProactivityState = {
    firstCrossingMs: null,
    lastFiredAtMs: null,
    lastSampledAtMs: null,
    lastInputId: null,
  };
  return createEmoSimProactivityPort({
    enabled: true,
    companionId: REPLAY_COMPANION_ID,
    thresholdProfile: profile,
    stateStore: {
      load: async () => structuredClone(state),
      save: async next => { state = structuredClone(next); },
    },
    emitImpulse: async () => undefined,
  });
}

function classifyResult(result: EmoSimProactivityResult): EmoSimProactivityReplayOutcome {
  if (result.kind === 'emitted') return 'fire';
  if (result.reason === 'sustain_pending' || result.reason === 'sampling_deferred') return 'defer';
  if (result.reason === 'duplicate_input') return 'duplicate';
  if (result.reason === 'cooldown_active') return 'fatigue';
  return 'suppress';
}

function emptyCounts(): ReplayCounts {
  return { fire: 0, defer: 0, suppress: 0, duplicate: 0, fatigue: 0, falsePositive: 0 };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function normalizeCorpus(input: unknown): EmoSimProactivityReplayCorpus {
  if (!isRecord(input)) throw new Error('EmoSim replay corpus must be an object');
  assertNoUnknownKeys(
    input,
    ['schemaVersion', 'corpusVersion', 'rawContentRedacted', 'events'],
    'EmoSim replay corpus',
  );
  if (input.schemaVersion !== 1) throw new Error('EmoSim replay corpus schemaVersion must be 1');
  if (input.rawContentRedacted !== true) {
    throw new Error('EmoSim replay corpus requires raw-content redaction');
  }
  const corpusVersion = requireReplayString(input.corpusVersion, 'corpusVersion');
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw new Error('EmoSim replay corpus events are required');
  }
  const events = input.events.map((event, index) => normalizeEvent(event, index));
  const presentLanes = new Set(events.map(event => event.lane));
  for (const lane of REPLAY_LANES) {
    if (!presentLanes.has(lane)) throw new Error(`EmoSim replay corpus is missing ${lane}`);
  }
  return { schemaVersion: 1, corpusVersion, rawContentRedacted: true, events };
}

function normalizeEvent(input: unknown, index: number): EmoSimProactivityReplayEvent {
  if (!isRecord(input)) throw new Error(`EmoSim replay event ${index} must be an object`);
  assertNoUnknownKeys(input, [
    'scenarioId',
    'lane',
    'eventId',
    'observedAtMs',
    'confidence',
    'expected',
    'availability',
    'snapshot',
  ], `EmoSim replay event ${index}`);
  const lane = input.lane;
  if (!REPLAY_LANES.includes(lane as EmoSimProactivityReplayLane)) {
    throw new Error(`EmoSim replay event ${index} has an unknown lane`);
  }
  const expected = input.expected;
  if (expected !== 'fire' && expected !== 'defer' && expected !== 'suppress') {
    throw new Error(`EmoSim replay event ${index} has an invalid expected outcome`);
  }
  const availability = input.availability;
  if (availability !== undefined && availability !== 'available' && availability !== 'unavailable') {
    throw new Error(`EmoSim replay event ${index} has invalid availability`);
  }
  const observedAtMs = requireReplayNonNegativeInteger(input.observedAtMs, `${index}.observedAtMs`);
  const confidence = requireReplayUnit(input.confidence, `${index}.confidence`);
  return {
    scenarioId: requireReplayString(input.scenarioId, `${index}.scenarioId`),
    lane: lane as EmoSimProactivityReplayLane,
    eventId: requireReplayString(input.eventId, `${index}.eventId`),
    observedAtMs,
    confidence,
    expected,
    ...(availability ? { availability } : {}),
    snapshot: normalizeReplaySnapshot(input.snapshot, index),
  };
}

function normalizeReplaySnapshot(
  input: unknown,
  index: number,
): EmoSimProactivityReplayEvent['snapshot'] {
  if (input === null) return null;
  if (!isRecord(input)) throw new Error(`EmoSim replay event ${index} snapshot must be an object`);
  assertNoUnknownKeys(
    input,
    ['dominant', 'emotions', 'socialNeed'],
    `EmoSim replay event ${index} snapshot`,
  );
  if (!isRecord(input.emotions)) {
    throw new Error(`EmoSim replay event ${index} emotions must be an object`);
  }
  const emotions = Object.fromEntries(Object.entries(input.emotions).map(([name, value]) => (
    [requireReplayString(name, `${index}.emotionName`), requireReplayUnit(value, `${index}.emotions.${name}`)]
  )));
  return {
    dominant: requireReplayString(input.dominant, `${index}.dominant`),
    emotions,
    socialNeed: input.socialNeed === null
      ? null
      : requireReplayUnit(input.socialNeed, `${index}.socialNeed`),
  };
}

function requireReplayString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`EmoSim replay ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireReplayNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`EmoSim replay ${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireReplayUnit(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`EmoSim replay ${field} must be within 0..1`);
  }
  return value;
}
