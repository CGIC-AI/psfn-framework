import { describe, expect, it } from 'vitest';
import {
  EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION,
  EMOSIM_ADAPTER_VERSION,
  EMOSIM_APPRAISAL_DIMS,
  EMOSIM_EMOTION_VECTOR,
  EMOSIM_KICKS_SEMANTICS,
  EMOSIM_SERVER_TICK_POLICY,
  EMOSIM_SNAPSHOT_FORMAT,
  EMOSIM_TIMESTEP_POLICY,
  runEmoSimProjectedStimulus,
  type EmoSimAdapterInput,
} from './emosim-adapter.js';
import {
  createEmoSimServerRunner,
  EMOSIM_SERVER_ANCHOR_NPC_NAME,
  EmoSimServerRunner,
} from './emosim-server-adapter.js';

const SESSION_LABEL = 'psfn-observer-eval-test';
const AGENT_NAME = 'observer';
const SESSION_ID = 'session-uuid-1';

describe('EmoSim server adapter', () => {
  it('verifies the model contract, bootstraps once, and produces schema-valid output', async () => {
    const server = new FakeEmoSimServer();
    const runner = makeRunner(server);

    const first = await runEmoSimProjectedStimulus(makeInput(), { runner });
    const second = await runEmoSimProjectedStimulus(makeInput(), { runner });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok) return;

    expect(first.output.schemaVersion).toBe(EMOSIM_ADAPTER_OUTPUT_SCHEMA_VERSION);
    expect(first.output.adapterVersion).toBe(EMOSIM_ADAPTER_VERSION);
    expect(first.output.runtime.timestepPolicy).toBe(EMOSIM_SERVER_TICK_POLICY);
    expect(first.output.runtime.kicksSemantics).toBe(EMOSIM_KICKS_SEMANTICS);
    expect(first.output.runtime.timeScale).toBe(120);
    expect(first.output.runtime.session).toEqual({
      sessionId: SESSION_ID,
      sessionLabel: SESSION_LABEL,
      agentName: AGENT_NAME,
    });

    // The persisted snapshot shape contract consumed by metrics/crosswalk.
    for (const name of ['before', 'afterStimulus', 'afterTick'] as const) {
      const snapshot = first.output.snapshots[name];
      expect(Object.keys(snapshot).sort()).toEqual(
        ['dominant', 'drives', 'emotions', 'format', 'mood', 't'].sort(),
      );
      expect(snapshot.format).toBe(EMOSIM_SNAPSHOT_FORMAT);
      expect(Object.keys(snapshot.emotions)).toEqual([...EMOSIM_EMOTION_VECTOR]);
    }

    // Contract check + bootstrap happen once, not once per observation.
    expect(server.calls.filter((call) => call.path === '/api/model')).toHaveLength(1);
    expect(server.calls.filter((call) => call.path === '/api/sessions' && call.method === 'GET')).toHaveLength(1);
    expect(server.createCount).toBe(1);
  });

  it('derives non-negative kicks from the before/afterStimulus delta', async () => {
    const server = new FakeEmoSimServer();
    // Use an existing session so state reads map 1:1 onto the observation
    // (bootstrap performs no state read in the reuse path).
    server.existingSessions = [
      {
        session: SESSION_ID,
        label: SESSION_LABEL,
        agents: [
          { uid: 'uid-observer', name: AGENT_NAME },
          { uid: 'uid-anchor', name: EMOSIM_SERVER_ANCHOR_NPC_NAME },
        ],
      },
    ];
    server.joySequence = [0.1, 0.4, 0.35];
    server.sadnessSequence = [0.3, 0.1, 0.1];
    const runner = makeRunner(server);

    const result = await runEmoSimProjectedStimulus(makeInput(), { runner });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output.kicks.Joy).toBeCloseTo(0.3, 6);
    // Sadness decayed; kicks are clamped at zero rather than going negative.
    expect(result.output.kicks.Sadness).toBe(0);
    expect(result.output.snapshots.afterTick.emotions.Joy).toBeCloseTo(0.35, 6);
  });

  it('reuses an existing session by label and never creates or deletes sessions for it', async () => {
    const server = new FakeEmoSimServer();
    server.existingSessions = [
      {
        session: SESSION_ID,
        label: SESSION_LABEL,
        agents: [
          { uid: 'uid-observer', name: AGENT_NAME },
          { uid: 'uid-anchor', name: EMOSIM_SERVER_ANCHOR_NPC_NAME },
        ],
      },
    ];
    const runner = makeRunner(server);

    const result = await runEmoSimProjectedStimulus(makeInput(), { runner });

    expect(result.ok).toBe(true);
    expect(server.createCount).toBe(0);
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(server.calls.some((call) => call.path.includes('/move'))).toBe(false);
  });

  it('refuses to touch an existing session that lacks the companion agent', async () => {
    const server = new FakeEmoSimServer();
    server.existingSessions = [
      {
        session: SESSION_ID,
        label: SESSION_LABEL,
        agents: [{ uid: 'uid-other', name: 'someone-else' }],
      },
    ];
    const runner = makeRunner(server);

    const result = await runEmoSimProjectedStimulus(makeInput(), { runner });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'sidecar-unavailable',
        reason: 'incompatible-runtime',
        recoverable: true,
      },
    });
    expect(server.createCount).toBe(0);
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('refusing to modify');
  });

  it('reports a contract mismatch in the emotion set as incompatible-runtime', async () => {
    const server = new FakeEmoSimServer();
    server.extraEmotion = 'Serenity';
    const runner = makeRunner(server);

    const result = await runEmoSimProjectedStimulus(makeInput(), { runner });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'sidecar-unavailable', reason: 'incompatible-runtime' },
    });
    if (result.ok) return;
    expect(result.error.message).toContain('49 entries');
    expect(server.createCount).toBe(0);
  });

  it('maps network failures to server-unreachable and HTTP errors to runtime-error', async () => {
    const failingRunner = new EmoSimServerRunner({
      serverUrl: 'http://emosim.test:17342',
      sessionLabel: SESSION_LABEL,
      agentName: AGENT_NAME,
      sleep: async () => {},
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const unreachable = await runEmoSimProjectedStimulus(makeInput(), { runner: failingRunner });
    expect(unreachable).toMatchObject({
      ok: false,
      error: { code: 'sidecar-unavailable', reason: 'server-unreachable' },
    });

    const errorRunner = new EmoSimServerRunner({
      serverUrl: 'http://emosim.test:17342',
      sessionLabel: SESSION_LABEL,
      agentName: AGENT_NAME,
      sleep: async () => {},
      fetchImpl: (async () => new Response('{"error":"boom"}', { status: 500 })) as typeof fetch,
    });
    const httpError = await runEmoSimProjectedStimulus(makeInput(), { runner: errorRunner });
    expect(httpError).toMatchObject({
      ok: false,
      error: { code: 'sidecar-unavailable', reason: 'runtime-error' },
    });
    if (httpError.ok) return;
    expect(httpError.error.message).toContain('HTTP 500');
  });

  it('maps request timeouts to the timeout reason', async () => {
    const timeoutRunner = new EmoSimServerRunner({
      serverUrl: 'http://emosim.test:17342',
      sessionLabel: SESSION_LABEL,
      agentName: AGENT_NAME,
      timeoutMs: 20,
      sleep: async () => {},
      fetchImpl: ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      })) as typeof fetch,
    });

    const result = await runEmoSimProjectedStimulus(makeInput(), { runner: timeoutRunner });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'sidecar-unavailable', reason: 'timeout' },
    });
  });

  it('retries bootstrap on the next observation after a transient failure', async () => {
    const server = new FakeEmoSimServer();
    server.failNextRequests = 1;
    const runner = makeRunner(server);

    const first = await runEmoSimProjectedStimulus(makeInput(), { runner });
    expect(first).toMatchObject({
      ok: false,
      error: { reason: 'server-unreachable' },
    });

    const second = await runEmoSimProjectedStimulus(makeInput(), { runner });
    expect(second.ok).toBe(true);
    expect(server.createCount).toBe(1);
  });

  it('creates the session with the fixed companion personality and a parked anchor NPC', async () => {
    const server = new FakeEmoSimServer();
    const runner = makeRunner(server);

    const result = await runEmoSimProjectedStimulus(makeInput(), { runner });

    expect(result.ok).toBe(true);
    expect(server.createBodies).toHaveLength(1);
    expect(server.createBodies[0]).toMatchObject({
      label: SESSION_LABEL,
      autonomy: false,
      human: {
        name: AGENT_NAME,
        personality: { A: 0.68, C: 0.62, E: 0.48, N: 0.34, O: 0.6 },
      },
      npcs: [{ name: EMOSIM_SERVER_ANCHOR_NPC_NAME }],
    });
    // Creation-time-only room separation for the anchor.
    expect(server.calls.filter((call) => call.path.includes('/move'))).toHaveLength(1);
  });

  it('posts the projected stimulus as an inline appraisal event targeting the companion', async () => {
    const server = new FakeEmoSimServer();
    const runner = makeRunner(server);
    const input = makeInput();

    await runEmoSimProjectedStimulus(input, { runner });

    expect(server.eventBodies).toHaveLength(1);
    const event = server.eventBodies[0] as Record<string, unknown>;
    expect(event.target).toBe(AGENT_NAME);
    expect(event.channel).toBe('direct');
    const stimulus = event.stimulus as Record<string, unknown>;
    expect(stimulus.label).toBe(input.stimulus.label);
    expect(stimulus.intensity).toBe(input.stimulus.intensity);
    expect(stimulus.importance).toBe(input.stimulus.importance);
    for (const dimension of EMOSIM_APPRAISAL_DIMS) {
      expect(stimulus[dimension]).toBe(input.stimulus.appraisal[dimension]);
    }
  });

  it('fails closed on malformed runner options', () => {
    expect(() => createEmoSimServerRunner({
      serverUrl: 'not-a-url',
      sessionLabel: SESSION_LABEL,
      agentName: AGENT_NAME,
    })).toThrow('must be an absolute http(s) URL');
    expect(() => createEmoSimServerRunner({
      serverUrl: 'ftp://emosim.test',
      sessionLabel: SESSION_LABEL,
      agentName: AGENT_NAME,
    })).toThrow('must use http or https');
    expect(() => createEmoSimServerRunner({
      serverUrl: 'http://emosim.test:17342',
      sessionLabel: '  ',
      agentName: AGENT_NAME,
    })).toThrow('sessionLabel must be a non-empty string');
    expect(() => createEmoSimServerRunner({
      serverUrl: 'http://emosim.test:17342',
      sessionLabel: SESSION_LABEL,
      agentName: AGENT_NAME,
      afterTickDelayMs: 1_500,
    })).toThrow('afterTickDelayMs must be an integer between 1 and 999');
  });
});

function makeRunner(server: FakeEmoSimServer): EmoSimServerRunner {
  return new EmoSimServerRunner({
    serverUrl: 'http://emosim.test:17342',
    sessionLabel: SESSION_LABEL,
    agentName: AGENT_NAME,
    sleep: async () => {},
    fetchImpl: server.fetch,
  });
}

interface FakeSessionListing {
  session: string;
  label: string;
  agents: { uid: string; name: string }[];
}

class FakeEmoSimServer {
  calls: { method: string; path: string; body?: unknown }[] = [];
  createBodies: unknown[] = [];
  eventBodies: unknown[] = [];
  existingSessions: FakeSessionListing[] = [];
  createCount = 0;
  failNextRequests = 0;
  extraEmotion: string | null = null;
  joySequence: number[] | null = null;
  sadnessSequence: number[] | null = null;
  private stateReads = 0;
  private created: FakeSessionListing | null = null;
  private anchorRoom = 'chapel';

  readonly fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const path = `${parsed.pathname}${parsed.search}`;
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    this.calls.push({ method, path, ...(body !== undefined ? { body } : {}) });

    if (this.failNextRequests > 0) {
      this.failNextRequests -= 1;
      throw new TypeError('fetch failed');
    }

    if (method === 'GET' && parsed.pathname === '/api/model') {
      return json(this.modelPayload());
    }
    if (method === 'GET' && parsed.pathname === '/api/sessions') {
      return json([...this.existingSessions, ...(this.created ? [this.created] : [])]);
    }
    if (method === 'POST' && parsed.pathname === '/api/sessions') {
      this.createCount += 1;
      this.createBodies.push(body);
      this.created = {
        session: SESSION_ID,
        label: SESSION_LABEL,
        agents: [
          { uid: 'uid-observer', name: AGENT_NAME },
          { uid: 'uid-anchor', name: EMOSIM_SERVER_ANCHOR_NPC_NAME },
        ],
      };
      return json({ session: SESSION_ID, label: SESSION_LABEL, human: 'uid-observer', agents: this.created.agents });
    }
    if (method === 'GET' && parsed.pathname === `/api/session/${SESSION_ID}/model`) {
      return json({ ...this.modelPayload(), override: {}, time_scale: 120, drive_scale: 1 });
    }
    if (method === 'POST' && parsed.pathname === `/api/session/${SESSION_ID}/event`) {
      this.eventBodies.push(body);
      return json({ t: 12.5, actor: null, target: AGENT_NAME, stimulus: 'observer turn', intensity: 0.7 });
    }
    if (method === 'POST' && parsed.pathname === `/api/session/${SESSION_ID}/agent/${EMOSIM_SERVER_ANCHOR_NPC_NAME}/move`) {
      this.anchorRoom = (body as { room: string }).room;
      return json({ room: this.anchorRoom });
    }
    if (method === 'GET' && parsed.pathname === `/api/session/${SESSION_ID}`) {
      return json(this.statePayload());
    }
    return json({ error: `unknown route ${method} ${path}` }, 404);
  }) as typeof fetch;

  private modelPayload(): Record<string, unknown> {
    const names = this.extraEmotion
      ? [...EMOSIM_EMOTION_VECTOR, this.extraEmotion]
      : [...EMOSIM_EMOTION_VECTOR];
    const emotions: Record<string, unknown> = {};
    for (const name of names) {
      emotions[name] = { valence: 0.2, arousal: 0.4, half_life: 30, ocean: {}, appraisal: {} };
    }
    return {
      emotions,
      coupling: {},
      appraisal_dims: [...EMOSIM_APPRAISAL_DIMS],
      ocean: ['O', 'C', 'E', 'A', 'N'],
      metadata: {},
    };
  }

  private statePayload(): Record<string, unknown> {
    const readIndex = Math.min(this.stateReads, 2);
    this.stateReads += 1;
    const intensities: Record<string, number> = {};
    for (const emotion of EMOSIM_EMOTION_VECTOR) {
      intensities[emotion] = 0.01;
    }
    intensities.Joy = this.joySequence?.[readIndex] ?? 0.1 + (readIndex * 0.1);
    intensities.Sadness = this.sadnessSequence?.[readIndex] ?? 0.02;

    const agent = (name: string) => ({
      uid: `uid-${name}`,
      name,
      personality: { O: 0.6, C: 0.62, E: 0.48, A: 0.68, N: 0.34 },
      drives: {
        hunger: 0.2,
        thirst: 0.15,
        sleep_pressure: 0.3,
        social_need: 0.4,
        stimulation_need: 0.25,
        esteem_need: 0.2,
        insecurity: 0.1,
        health: 1,
      },
      room: name === AGENT_NAME ? 'chapel' : this.anchorRoom,
      home: name === AGENT_NAME ? 'cell_1' : 'cell_2',
      asleep: 0,
      activity: null,
      schedule: [],
      dominant: 'Calmness',
      mood: { valence: 0.05 + (readIndex * 0.02), arousal: 0.1 },
      intensities,
    });

    return {
      time: '2026-07-06T00:00:00Z',
      t: 100 + (readIndex * 0.5),
      clock: '08:00',
      speed: 1,
      timescale: 120,
      session: SESSION_ID,
      label: SESSION_LABEL,
      rooms: [],
      agents: {
        [AGENT_NAME]: agent(AGENT_NAME),
        [EMOSIM_SERVER_ANCHOR_NPC_NAME]: agent(EMOSIM_SERVER_ANCHOR_NPC_NAME),
      },
      relationships: {},
      events: [{ t: 12.5, stimulus: 'observer turn' }],
    };
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeInput(): EmoSimAdapterInput {
  return {
    schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
    runId: 'emosim-server-adapter-test-run',
    subject: {
      name: 'observer-sidecar',
      uid: 'observer-sidecar-projection',
      personality: {
        O: 0.6,
        C: 0.62,
        E: 0.48,
        A: 0.68,
        N: 0.34,
      },
    },
    stimulus: {
      label: 'observer user turn via api',
      intensity: 0.7,
      importance: 0.5,
      projection: {
        schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
        source: 'psfn.observer-sidecar.appraisal-projection.v1',
        traceId: 'turn-fixture-1',
      },
      appraisal: {
        valence: 0.7,
        novelty: 0.2,
        goal_congruence: 0.5,
        certainty: 0.4,
        control: 0.3,
        agency_self: 0,
        agency_other: 0.8,
        fairness: 0.6,
        self_norm: 0.1,
        threat: 0,
        loss: 0,
        gain: 0.55,
        other_suffering: 0,
        attachment: 0.7,
        beauty: 0.1,
        effort: 0.2,
        safety: 0.8,
      },
    },
    timestep: {
      policy: EMOSIM_TIMESTEP_POLICY,
      tickSeconds: 0.25,
      steps: 4,
    },
    deterministic: {
      seed: 'emosim-server-adapter-seed',
      clock0Seconds: 36_000,
      observedAt: '2026-07-06T00:00:00.000Z',
      disableDrives: true,
    },
    snapshot: {
      format: EMOSIM_SNAPSHOT_FORMAT,
      fullEmotionVector: true,
      includeWorldState: false,
      precision: 6,
    },
  };
}
