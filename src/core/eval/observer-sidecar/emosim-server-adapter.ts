/**
 * Server-backed EmoSim runner for the observer eval sidecar.
 *
 * Talks to a long-lived emo_sim server (server.py HTTP JSON API) so temporal
 * state accumulates in ONE persistent session across observations, instead of
 * the removed spawn-per-call bridge that rebuilt a fresh engine every turn.
 *
 * Hard requirements honored here:
 * - Bootstrap is idempotent: the session is found by its stable label and
 *   created only when absent. An existing session is NEVER reset, recreated,
 *   or mutated structurally; if it exists but does not contain the configured
 *   companion agent, the runner fails with incompatible-runtime rather than
 *   touching it.
 * - The emo_sim HTTP API is unauthenticated by upstream design (it binds
 *   loopback by default and warns on wider binds). Deployment must keep the
 *   server cluster-internal (ClusterIP service, NetworkPolicy); there is no
 *   token to configure, so none is silently defaulted here.
 * - afterTick semantics: the server ticks continuously, so afterStimulus is
 *   the immediate post-event read and afterTick is a re-read taken after a
 *   short fixed delay (DEFAULT_EMOSIM_AFTER_TICK_DELAY_MS < 1s) so at least
 *   one server tick (default 2 Hz) can land between the two reads. The
 *   procedure is fixed and cheap; wall-clock decay between reads is expected
 *   signal in server mode, not noise.
 */
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  DEFAULT_EMOSIM_TIMEOUT_MS,
  EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_VERSION,
  EMOSIM_APPRAISAL_DIMS,
  EMOSIM_EMOTION_VECTOR,
  EMOSIM_INTEGRATION_SURFACE,
  EMOSIM_KICKS_SEMANTICS,
  EMOSIM_SERVER_TICK_POLICY,
  EMOSIM_SNAPSHOT_FORMAT,
  EMOSIM_WORLD_SNAPSHOT_FORMAT,
  EmoSimSidecarUnavailableError,
  type EmoSimAdapterInput,
  type EmoSimEmotionName,
  type EmoSimEmotionSpecMetadata,
  type EmoSimEngineSnapshot,
  type EmoSimRunner,
} from './emosim-adapter.js';

/** Neutral anchor NPC required because emo_sim sessions need >= 1 NPC. */
export const EMOSIM_SERVER_ANCHOR_NPC_NAME = 'baseline-anchor' as const;
export const EMOSIM_SERVER_ANCHOR_NPC_ARCHETYPE = 'serene_sage' as const;
export const DEFAULT_EMOSIM_AFTER_TICK_DELAY_MS = 750;

const SERVER_DRIVE_KEYS = Object.freeze([
  'hunger',
  'thirst',
  'sleep_pressure',
  'social_need',
  'stimulation_need',
  'esteem_need',
  'insecurity',
  'health',
] as const);

export interface EmoSimServerRunnerOptions {
  /** Base URL of the emo_sim HTTP API, e.g. http://psfn-emosim:17342 */
  serverUrl: string;
  /** Stable session label used to find-or-create the persistent session. */
  sessionLabel: string;
  /** Stable name of the human agent representing the companion. */
  agentName: string;
  /** Per-HTTP-request timeout. */
  timeoutMs?: number;
  /** Delay before the afterTick re-read; must stay below 1s. */
  afterTickDelayMs?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface EmoSimServerBootstrap {
  sessionId: string;
  timeScale: number;
  emotionSpecs: Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata>;
}

export function createEmoSimServerRunner(options: EmoSimServerRunnerOptions): EmoSimServerRunner {
  return new EmoSimServerRunner(options);
}

export class EmoSimServerRunner implements EmoSimRunner {
  private readonly serverUrl: string;
  private readonly sessionLabel: string;
  private readonly agentName: string;
  private readonly timeoutMs: number;
  private readonly afterTickDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private bootstrapPromise: Promise<EmoSimServerBootstrap> | null = null;

  constructor(options: EmoSimServerRunnerOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.sessionLabel = requireNonEmpty(options.sessionLabel, 'sessionLabel');
    this.agentName = requireNonEmpty(options.agentName, 'agentName');
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_EMOSIM_TIMEOUT_MS, 'timeoutMs', 120_000);
    this.afterTickDelayMs = normalizeTimeout(
      options.afterTickDelayMs ?? DEFAULT_EMOSIM_AFTER_TICK_DELAY_MS,
      'afterTickDelayMs',
      999,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(input: EmoSimAdapterInput): Promise<unknown> {
    const bootstrap = await this.ensureBootstrap(input);

    const beforeState = await this.readSessionState(bootstrap.sessionId);
    const before = this.toEngineSnapshot(beforeState);

    await this.postStimulusEvent(bootstrap.sessionId, input);
    const afterStimulusState = await this.readSessionState(bootstrap.sessionId);
    const afterStimulus = this.toEngineSnapshot(afterStimulusState);

    await this.sleep(this.afterTickDelayMs);
    const afterTickState = await this.readSessionState(bootstrap.sessionId);
    const afterTick = this.toEngineSnapshot(afterTickState);

    const kicks: Record<string, number> = {};
    for (const emotion of EMOSIM_EMOTION_VECTOR) {
      kicks[emotion] = roundTo(Math.max(0, afterStimulus.emotions[emotion] - before.emotions[emotion]), 6);
    }

    const output: Record<string, unknown> = {
      schemaVersion: EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
      adapterVersion: EMOSIM_ADAPTER_VERSION,
      runtime: {
        integrationSurface: EMOSIM_INTEGRATION_SURFACE,
        appraisalDimensions: [...EMOSIM_APPRAISAL_DIMS],
        emotionVector: [...EMOSIM_EMOTION_VECTOR],
        timestepPolicy: EMOSIM_SERVER_TICK_POLICY,
        snapshotFormat: EMOSIM_SNAPSHOT_FORMAT,
        worldSnapshotFormat: EMOSIM_WORLD_SNAPSHOT_FORMAT,
        kicksSemantics: EMOSIM_KICKS_SEMANTICS,
        timeScale: bootstrap.timeScale,
        session: {
          sessionId: bootstrap.sessionId,
          sessionLabel: this.sessionLabel,
          agentName: this.agentName,
        },
        emotionSpecs: bootstrap.emotionSpecs,
      },
      input,
      stimulus: input.stimulus,
      kicks,
      snapshots: {
        before,
        afterStimulus,
        afterTick,
      },
    };

    if (input.snapshot.includeWorldState) {
      const worldState: Record<string, unknown> = { ...afterTickState };
      // Recent event labels add nothing the observation does not already
      // carry and would bloat every persisted row; drop them from the copy.
      delete worldState.events;
      output.world = {
        format: EMOSIM_WORLD_SNAPSHOT_FORMAT,
        fullEmotionVector: true,
        state: worldState,
      };
    }

    return output;
  }

  private ensureBootstrap(input: EmoSimAdapterInput): Promise<EmoSimServerBootstrap> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.bootstrap(input).catch((error: unknown) => {
        // Allow the next observation to retry bootstrap after transient
        // failures (server restarting, network blip). Session creation is
        // idempotent because it is guarded by the find-by-label lookup.
        this.bootstrapPromise = null;
        throw error;
      });
    }
    return this.bootstrapPromise;
  }

  private async bootstrap(input: EmoSimAdapterInput): Promise<EmoSimServerBootstrap> {
    const model = expectRecord(await this.request('GET', '/api/model'), '/api/model response');
    this.verifyModelContract(model);
    const emotionSpecs = extractEmotionSpecs(model);

    const sessions = await this.request('GET', '/api/sessions');
    if (!Array.isArray(sessions)) {
      throw incompatible('/api/sessions did not return an array');
    }

    const existing = sessions.find(
      (session): session is Record<string, unknown> =>
        isRecord(session) && session.label === this.sessionLabel,
    );

    let sessionId: string;
    if (existing) {
      sessionId = expectNonEmptyString(existing.session, '/api/sessions[].session');
      const roster = Array.isArray(existing.agents) ? existing.agents : [];
      const hasAgent = roster.some((agent) => isRecord(agent) && agent.name === this.agentName);
      if (!hasAgent) {
        throw incompatible(
          `emo_sim session "${this.sessionLabel}" (${sessionId}) exists but has no agent named `
          + `"${this.agentName}"; refusing to modify or recreate an existing session`,
        );
      }
    } else {
      sessionId = await this.createSession(input);
    }

    const sessionModel = expectRecord(
      await this.request('GET', `/api/session/${encodeURIComponent(sessionId)}/model`),
      'session model response',
    );
    const timeScale = expectFiniteNumber(sessionModel.time_scale, 'session model time_scale');
    if (timeScale <= 0) {
      throw incompatible(`session model time_scale must be > 0, got ${timeScale}`);
    }

    return { sessionId, timeScale, emotionSpecs };
  }

  private async createSession(input: EmoSimAdapterInput): Promise<string> {
    const created = expectRecord(
      await this.request('POST', '/api/sessions', {
        label: this.sessionLabel,
        human: {
          name: this.agentName,
          personality: input.subject.personality,
        },
        // emo_sim requires at least one NPC per session. The anchor is a
        // calm archetype in a world with autonomy disabled, so it never
        // self-acts; it exists purely to satisfy the session shape.
        npcs: [
          {
            name: EMOSIM_SERVER_ANCHOR_NPC_NAME,
            archetype: EMOSIM_SERVER_ANCHOR_NPC_ARCHETYPE,
          },
        ],
        autonomy: false,
      }),
      'session create response',
    );
    const sessionId = expectNonEmptyString(created.session, 'session create response session');

    // Creation-time only: park the anchor NPC in its own home room so it does
    // not witness the companion's direct stimuli (event routing is room
    // scoped). Existing sessions are never touched.
    const state = await this.readSessionState(sessionId);
    const agents = expectRecord(state.agents, 'session state agents');
    const anchor = agents[EMOSIM_SERVER_ANCHOR_NPC_NAME];
    if (isRecord(anchor) && typeof anchor.home === 'string' && anchor.home && anchor.room !== anchor.home) {
      await this.request(
        'POST',
        `/api/session/${encodeURIComponent(sessionId)}/agent/${encodeURIComponent(EMOSIM_SERVER_ANCHOR_NPC_NAME)}/move`,
        { room: anchor.home },
      );
    }
    return sessionId;
  }

  private verifyModelContract(model: Record<string, unknown>): void {
    const dims = model.appraisal_dims;
    if (!Array.isArray(dims)) {
      throw incompatible('/api/model appraisal_dims is not an array');
    }
    assertOrderedEquality(dims, EMOSIM_APPRAISAL_DIMS, 'appraisal_dims');

    const emotions = model.emotions;
    if (!isRecord(emotions)) {
      throw incompatible('/api/model emotions is not an object');
    }
    assertOrderedEquality(Object.keys(emotions), EMOSIM_EMOTION_VECTOR, 'emotions');
  }

  private async postStimulusEvent(sessionId: string, input: EmoSimAdapterInput): Promise<void> {
    const { stimulus } = input;
    await this.request('POST', `/api/session/${encodeURIComponent(sessionId)}/event`, {
      target: this.agentName,
      channel: 'direct',
      stimulus: {
        label: stimulus.label,
        intensity: stimulus.intensity,
        importance: stimulus.importance,
        ...stimulus.appraisal,
      },
    });
  }

  private async readSessionState(sessionId: string): Promise<Record<string, unknown>> {
    return expectRecord(
      await this.request('GET', `/api/session/${encodeURIComponent(sessionId)}?full=1`),
      'session state response',
    );
  }

  private toEngineSnapshot(state: Record<string, unknown>): EmoSimEngineSnapshot {
    const t = expectFiniteNumber(state.t, 'session state t');
    const agents = expectRecord(state.agents, 'session state agents');
    const agent = agents[this.agentName];
    if (!isRecord(agent)) {
      throw incompatible(
        `session state has no agent named "${this.agentName}"; refusing to modify the session`,
      );
    }

    const mood = expectRecord(agent.mood, `agent ${this.agentName} mood`);
    const intensities = expectRecord(agent.intensities, `agent ${this.agentName} intensities`);
    const drives = expectRecord(agent.drives, `agent ${this.agentName} drives`);

    const emotions = {} as Record<EmoSimEmotionName, number>;
    for (const emotion of EMOSIM_EMOTION_VECTOR) {
      emotions[emotion] = expectFiniteNumber(
        intensities[emotion],
        `agent ${this.agentName} intensities.${emotion} (full=1 read expected the complete 48-emotion vector)`,
      );
    }

    const driveValues: Record<string, number> = {};
    for (const key of SERVER_DRIVE_KEYS) {
      driveValues[key] = expectFiniteNumber(drives[key], `agent ${this.agentName} drives.${key}`);
    }

    return {
      format: EMOSIM_SNAPSHOT_FORMAT,
      t,
      dominant: expectNonEmptyString(agent.dominant, `agent ${this.agentName} dominant`) as EmoSimEmotionName,
      mood: {
        valence: expectFiniteNumber(mood.valence, `agent ${this.agentName} mood.valence`),
        arousal: expectFiniteNumber(mood.arousal, `agent ${this.agentName} mood.arousal`),
      },
      emotions,
      drives: {
        hunger: driveValues.hunger,
        thirst: driveValues.thirst,
        sleepPressure: driveValues.sleep_pressure,
        socialNeed: driveValues.social_need,
        stimulationNeed: driveValues.stimulation_need,
        esteemNeed: driveValues.esteem_need,
        insecurity: driveValues.insecurity,
        health: driveValues.health,
        asleep: expectFiniteNumber(agent.asleep, `agent ${this.agentName} asleep`),
      },
    };
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const url = `${this.serverUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal: controller.signal,
        ...(body !== undefined
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new EmoSimSidecarUnavailableError(
          'timeout',
          `EmoSim server request ${method} ${path} timed out after ${this.timeoutMs}ms`,
          { timeoutMs: this.timeoutMs },
        );
      }
      throw new EmoSimSidecarUnavailableError(
        'server-unreachable',
        `EmoSim server request ${method} ${path} failed: ${toErrorMessage(error)}`,
        { serverUrl: this.serverUrl },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new EmoSimSidecarUnavailableError(
        'runtime-error',
        `EmoSim server ${method} ${path} returned HTTP ${response.status}: ${compactBody(text)}`,
        { status: response.status },
      );
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw incompatible(
        `EmoSim server ${method} ${path} returned non-JSON body: ${toErrorMessage(error)}`,
      );
    }
  }
}

function incompatible(message: string): EmoSimSidecarUnavailableError {
  return new EmoSimSidecarUnavailableError('incompatible-runtime', message);
}

function assertOrderedEquality(
  actual: readonly unknown[],
  expected: readonly string[],
  label: string,
): void {
  if (actual.length !== expected.length) {
    throw incompatible(
      `EmoSim server ${label} has ${actual.length} entries; the adapter contract expects ${expected.length}`,
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw incompatible(
        `EmoSim server ${label}[${index}] is ${JSON.stringify(actual[index])}; `
        + `the adapter contract expects ${JSON.stringify(expected[index])}`,
      );
    }
  }
}

function extractEmotionSpecs(
  model: Record<string, unknown>,
): Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata> {
  const emotions = expectRecord(model.emotions, '/api/model emotions');
  const specs = {} as Record<EmoSimEmotionName, EmoSimEmotionSpecMetadata>;
  for (const emotion of EMOSIM_EMOTION_VECTOR) {
    const spec = expectRecord(emotions[emotion], `/api/model emotions.${emotion}`);
    const halfLifeSeconds = expectFiniteNumber(spec.half_life, `/api/model emotions.${emotion}.half_life`);
    if (halfLifeSeconds <= 0) {
      throw incompatible(`/api/model emotions.${emotion}.half_life must be > 0`);
    }
    specs[emotion] = {
      valence: expectFiniteNumber(spec.valence, `/api/model emotions.${emotion}.valence`),
      arousal: expectFiniteNumber(spec.arousal, `/api/model emotions.${emotion}.arousal`),
      halfLifeSeconds,
    };
  }
  return specs;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw incompatible(`${label} is not an object`);
  }
  return value;
}

function expectFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw incompatible(`${label} is not a finite number`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw incompatible(`${label} is not a non-empty string`);
  }
  return value.trim();
}

function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`EmoSim server runner serverUrl (${value}) must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`EmoSim server runner serverUrl (${value}) must use http or https`);
  }
  return trimmed.replace(/\/+$/, '');
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`EmoSim server runner ${label} must be a non-empty string`);
  }
  return trimmed;
}

function normalizeTimeout(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`EmoSim server runner ${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compactBody(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized || '<empty>';
}
