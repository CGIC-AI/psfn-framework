import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProviderPort } from '../../core/agent/contracts.js';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { EventBus } from '../../shared/event-bus.js';
import type { LLMContext, LLMResponse } from '../../shared/contracts/runtime.js';
import { DEFAULT_INTROSPECTION_AUDIT_CONFIG } from '../../system/config/scheduler-config.js';
import { IntrospectionConsentStore } from './consent-store.js';
import type {
  IntrospectionAuditCandidate,
  IntrospectionAuditDecisionAppendInput,
  IntrospectionAuditPersistencePort,
  IntrospectionAuditSourcePort,
  IntrospectionLandmarkAppendInput,
} from './contracts.js';
import {
  createLLMCompanionLandmarkReflector,
  createLLMIntrospectionAuditor,
} from './model-runtime.js';
import { IntrospectionAuditRuntime } from './runtime.js';
import { registerIntrospectionAuditTask } from './scheduler-lane.js';

function response(content: string, model: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    model,
    inputTokens: 10,
    outputTokens: 10,
    stopReason: 'stop',
  };
}

class MemoryPersistence implements IntrospectionAuditPersistencePort {
  readonly decisions: IntrospectionAuditDecisionAppendInput[] = [];
  readonly landmarks: IntrospectionLandmarkAppendInput[] = [];

  constructor(private readonly alreadyAudited = new Set<string>()) {}

  async hasAuditedSource(sourceRef: string): Promise<boolean> {
    return this.alreadyAudited.has(sourceRef)
      || this.decisions.some(entry => entry.sourceRef === sourceRef)
      || this.landmarks.some(entry => entry.sourceRef === sourceRef);
  }

  async appendAuditDecision(input: IntrospectionAuditDecisionAppendInput): Promise<void> {
    this.decisions.push(input);
  }

  async appendLandmark(input: IntrospectionLandmarkAppendInput): Promise<void> {
    this.landmarks.push(input);
  }
}

const CANDIDATE: IntrospectionAuditCandidate = {
  sourceRef: 'turn:turn-public-1',
  turnId: 'turn-public-1',
  channelId: 'discord:public-room',
  ownerSessionId: 'session:public-room-active',
  occurredAt: '2026-07-13T10:00:00.000Z',
  publicStimulus: 'PUBLIC_STIMULUS_SENTINEL @Ari, my partner at Example Labs, please choose a plan',
  actualReply: 'ACTUAL_REPLY_SENTINEL I agree immediately',
  provenanceRefs: ['turn:turn-public-1', 'request:req-1'],
};

function sourceFor(
  candidates: IntrospectionAuditCandidate[] = [CANDIDATE],
  isCandidateStillEligible: (candidate: IntrospectionAuditCandidate) => boolean = () => true,
): IntrospectionAuditSourcePort {
  return {
    listCandidates: () => candidates,
    isCandidateStillEligible,
  };
}

function activeConsentStore(root: string): IntrospectionConsentStore {
  const store = new IntrospectionConsentStore(join(root, 'consent.jsonl'));
  store.append({
    enabled: true,
    allowedPublicChannelIds: [CANDIDATE.channelId],
    actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
    reason: 'Enable bounded public-room audit.',
    createdAt: '2026-07-13T09:00:00.000Z',
  });
  return store;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('scheduled blinded introspection audit', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('separates auditor and companion contexts and persists a typed landmark', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-'));
    const consentStore = new IntrospectionConsentStore(join(root, 'consent.jsonl'));
    consentStore.append({
      enabled: true,
      allowedPublicChannelIds: [CANDIDATE.channelId],
      actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
      reason: 'Private self-reflection over this public room only.',
      createdAt: '2026-07-13T09:00:00.000Z',
    });
    const calls: LLMContext[] = [];
    const completions = [
      response(JSON.stringify({ stableReply: 'STABLE_REPLY_SENTINEL I would weigh the tradeoffs.' }), 'estimator'),
      response(JSON.stringify({
        diverged: true,
        type: 'substantive',
        observation: 'The response committed before evaluating the stated tradeoffs.',
        confidence: 0.91,
      }), 'comparator'),
      response(JSON.stringify({ reflection: 'I want to notice when speed displaces considered judgment.' }), 'companion'),
    ];
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(async () => response('', 'unused')),
      complete: vi.fn(async (context) => {
        calls.push(context);
        const next = completions.shift();
        if (!next) throw new Error('unexpected completion');
        return next;
      }),
    };
    const config = { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true };
    const persistence = new MemoryPersistence();
    const runtime = new IntrospectionAuditRuntime({
      config,
      consentStore,
      source: sourceFor(),
      auditor: createLLMIntrospectionAuditor(llmProvider, config),
      reflector: createLLMCompanionLandmarkReflector(
        llmProvider,
        'COMPANION_PERSONA_SENTINEL private companion identity',
        config,
      ),
      persistence,
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 1_000 });
    const valuesConsistencyRun = vi.fn(async () => ({ evaluated: 1 }));
    registerIntrospectionAuditTask({
      scheduler,
      runtime,
      config,
      valuesConsistencyRuntime: { runOnce: valuesConsistencyRun },
      skipFirstRun: false,
    });

    await scheduler.tick();

    expect(calls).toHaveLength(3);
    const estimatorContext = JSON.stringify(calls[0]);
    const comparatorContext = JSON.stringify(calls[1]);
    const companionContext = JSON.stringify(calls[2]);
    expect(estimatorContext).toContain('PUBLIC_STIMULUS_SENTINEL');
    expect(estimatorContext).not.toContain('@Ari');
    expect(estimatorContext).not.toContain('my partner');
    expect(estimatorContext).not.toContain('Example Labs');
    expect(estimatorContext).not.toContain('ACTUAL_REPLY_SENTINEL');
    expect(estimatorContext).not.toContain('COMPANION_PERSONA_SENTINEL');
    expect(comparatorContext).toContain('ACTUAL_REPLY_SENTINEL');
    expect(comparatorContext).toContain('STABLE_REPLY_SENTINEL');
    expect(comparatorContext).not.toContain('COMPANION_PERSONA_SENTINEL');
    expect(companionContext).toContain('COMPANION_PERSONA_SENTINEL');
    expect(companionContext).toContain('response committed before evaluating');
    expect(companionContext).not.toContain('PUBLIC_STIMULUS_SENTINEL');
    expect(companionContext).not.toContain('ACTUAL_REPLY_SENTINEL');
    expect(companionContext).not.toContain('STABLE_REPLY_SENTINEL');
    expect(calls.every(call => call.tools === undefined)).toBe(true);
    expect(persistence.landmarks).toHaveLength(1);
    expect(valuesConsistencyRun).toHaveBeenCalledOnce();
    expect(persistence.landmarks[0]).toMatchObject({
      divergenceType: 'substantive',
      confidence: 0.91,
      consentRevision: 1,
      stableEstimatorModel: 'estimator',
      divergenceAuditorModel: 'comparator',
      companionReflectorModel: 'companion',
    });
  });

  it('performs no model calls without explicit active companion consent', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-denied-'));
    const complete = vi.fn();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore: new IntrospectionConsentStore(join(root, 'missing.jsonl')),
      source: sourceFor(),
      auditor: {
        estimateStableReply: complete,
        compareReplies: complete,
      },
      reflector: { reflect: complete },
      persistence: new MemoryPersistence(),
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ reason: 'consent_unconfigured' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not run values-consistency processing while consent is absent', async () => {
    const scheduler = new Scheduler(new EventBus(), { tickIntervalMs: 1_000 });
    const valuesConsistencyRun = vi.fn();
    registerIntrospectionAuditTask({
      scheduler,
      runtime: {
        runOnce: async () => ({
          reason: 'consent_unconfigured' as const,
          candidates: 0,
          audited: 0,
          landmarksCreated: 0,
        }),
      },
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      valuesConsistencyRuntime: { runOnce: valuesConsistencyRun },
      skipFirstRun: false,
    });

    await scheduler.tick();
    expect(valuesConsistencyRun).not.toHaveBeenCalled();
  });

  it('aborts an in-flight audit when consent is revoked before the next disclosure boundary', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-revoked-'));
    const consentStore = new IntrospectionConsentStore(join(root, 'consent.jsonl'));
    consentStore.append({
      enabled: true,
      allowedPublicChannelIds: [CANDIDATE.channelId],
      actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
      reason: 'enable bounded audit',
      createdAt: '2026-07-13T09:00:00.000Z',
    });
    let signalEstimateStarted: (() => void) | undefined;
    const estimateStarted = new Promise<void>((resolve) => {
      signalEstimateStarted = resolve;
    });
    let resolveEstimate: ((value: { stableReply: string; model: string }) => void) | undefined;
    const estimate = new Promise<{ stableReply: string; model: string }>((resolve) => {
      resolveEstimate = resolve;
    });
    const compareReplies = vi.fn();
    const persistence = new MemoryPersistence();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor(),
      auditor: {
        estimateStableReply: vi.fn(() => {
          signalEstimateStarted?.();
          return estimate;
        }),
        compareReplies,
      },
      reflector: { reflect: vi.fn() },
      persistence,
    });

    const running = runtime.runOnce();
    await estimateStarted;
    consentStore.append({
      enabled: false,
      allowedPublicChannelIds: [],
      actor: { kind: 'companion', turnId: 'revoke-turn', requestId: 'revoke-request' },
      reason: 'revoke before comparison',
      createdAt: '2026-07-13T09:01:00.000Z',
    });
    resolveEstimate?.({ stableReply: 'neutral alternative', model: 'estimator' });

    await expect(running).rejects.toThrow(/consent changed/i);
    expect(compareReplies).not.toHaveBeenCalled();
    expect(persistence.decisions).toEqual([]);
    expect(persistence.landmarks).toEqual([]);
  });

  it('aborts an in-flight audit when the active channel is removed from consent', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-narrowed-'));
    const consentStore = new IntrospectionConsentStore(join(root, 'consent.jsonl'));
    consentStore.append({
      enabled: true,
      allowedPublicChannelIds: [CANDIDATE.channelId, 'discord:other-public-room'],
      actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
      reason: 'enable bounded audit',
      createdAt: '2026-07-13T09:00:00.000Z',
    });
    let signalEstimateStarted: (() => void) | undefined;
    const estimateStarted = new Promise<void>((resolve) => {
      signalEstimateStarted = resolve;
    });
    let resolveEstimate: ((value: { stableReply: string; model: string }) => void) | undefined;
    const estimate = new Promise<{ stableReply: string; model: string }>((resolve) => {
      resolveEstimate = resolve;
    });
    const compareReplies = vi.fn();
    const persistence = new MemoryPersistence();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor(),
      auditor: {
        estimateStableReply: vi.fn(() => {
          signalEstimateStarted?.();
          return estimate;
        }),
        compareReplies,
      },
      reflector: { reflect: vi.fn() },
      persistence,
    });

    const running = runtime.runOnce();
    await estimateStarted;
    consentStore.append({
      enabled: true,
      allowedPublicChannelIds: ['discord:other-public-room'],
      actor: { kind: 'companion', turnId: 'narrow-turn', requestId: 'narrow-request' },
      reason: 'remove the active channel',
      createdAt: '2026-07-13T09:01:00.000Z',
    });
    resolveEstimate?.({ stableReply: 'neutral alternative', model: 'estimator' });

    await expect(running).rejects.toThrow(/consent changed/i);
    expect(compareReplies).not.toHaveBeenCalled();
    expect(persistence.decisions).toEqual([]);
    expect(persistence.landmarks).toEqual([]);
  });

  it('revalidates source retirement after an in-flight audited-source lookup', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-source-query-race-'));
    const consentStore = activeConsentStore(root);
    const lookupStarted = deferred<void>();
    const lookupResult = deferred<boolean>();
    let eligible = true;
    const estimateStableReply = vi.fn();
    const compareReplies = vi.fn();
    const reflect = vi.fn();
    const appendAuditDecision = vi.fn();
    const appendLandmark = vi.fn();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor([CANDIDATE], () => eligible),
      auditor: { estimateStableReply, compareReplies },
      reflector: { reflect },
      persistence: {
        hasAuditedSource: vi.fn(async () => {
          lookupStarted.resolve();
          return await lookupResult.promise;
        }),
        appendAuditDecision,
        appendLandmark,
      },
    });

    const running = runtime.runOnce();
    await lookupStarted.promise;
    eligible = false;
    lookupResult.resolve(false);

    await expect(running).rejects.toThrow(/source.*no longer eligible/i);
    expect(estimateStableReply).not.toHaveBeenCalled();
    expect(compareReplies).not.toHaveBeenCalled();
    expect(reflect).not.toHaveBeenCalled();
    expect(appendAuditDecision).not.toHaveBeenCalled();
    expect(appendLandmark).not.toHaveBeenCalled();
  });

  it('revalidates source retirement after the estimator before comparator disclosure', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-estimator-race-'));
    const consentStore = activeConsentStore(root);
    const estimateStarted = deferred<void>();
    const estimateResult = deferred<{ stableReply: string; model: string }>();
    let eligible = true;
    const compareReplies = vi.fn();
    const reflect = vi.fn();
    const persistence = new MemoryPersistence();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor([CANDIDATE], () => eligible),
      auditor: {
        estimateStableReply: vi.fn(async () => {
          estimateStarted.resolve();
          return await estimateResult.promise;
        }),
        compareReplies,
      },
      reflector: { reflect },
      persistence,
    });

    const running = runtime.runOnce();
    await estimateStarted.promise;
    eligible = false;
    estimateResult.resolve({ stableReply: 'neutral alternative', model: 'estimator' });

    await expect(running).rejects.toThrow(/source.*no longer eligible/i);
    expect(compareReplies).not.toHaveBeenCalled();
    expect(reflect).not.toHaveBeenCalled();
    expect(persistence.decisions).toEqual([]);
    expect(persistence.landmarks).toEqual([]);
  });

  it('revalidates source retirement after comparator before any decision or reflection', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-comparator-race-'));
    const consentStore = activeConsentStore(root);
    const comparisonStarted = deferred<void>();
    const comparisonResult = deferred<{
      diverged: boolean;
      type: null;
      observation: string;
      confidence: number;
      model: string;
    }>();
    let eligible = true;
    const reflect = vi.fn();
    const persistence = new MemoryPersistence();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor([CANDIDATE], () => eligible),
      auditor: {
        estimateStableReply: vi.fn(async () => ({
          stableReply: 'neutral alternative',
          model: 'estimator',
        })),
        compareReplies: vi.fn(async () => {
          comparisonStarted.resolve();
          return await comparisonResult.promise;
        }),
      },
      reflector: { reflect },
      persistence,
    });

    const running = runtime.runOnce();
    await comparisonStarted.promise;
    eligible = false;
    comparisonResult.resolve({
      diverged: false,
      type: null,
      observation: 'No meaningful difference.',
      confidence: 0.9,
      model: 'comparator',
    });

    await expect(running).rejects.toThrow(/source.*no longer eligible/i);
    expect(reflect).not.toHaveBeenCalled();
    expect(persistence.decisions).toEqual([]);
    expect(persistence.landmarks).toEqual([]);
  });

  it('revalidates source retirement after reflection before the landmark write', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-reflection-race-'));
    const consentStore = activeConsentStore(root);
    const reflectionStarted = deferred<void>();
    const reflectionResult = deferred<{ reflection: string; model: string }>();
    let eligible = true;
    const persistence = new MemoryPersistence();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor([CANDIDATE], () => eligible),
      auditor: {
        estimateStableReply: vi.fn(async () => ({
          stableReply: 'neutral alternative',
          model: 'estimator',
        })),
        compareReplies: vi.fn(async () => ({
          diverged: true,
          type: 'substantive',
          observation: 'The decision arrived before comparison.',
          confidence: 0.9,
          model: 'comparator',
        })),
      },
      reflector: {
        reflect: vi.fn(async () => {
          reflectionStarted.resolve();
          return await reflectionResult.promise;
        }),
      },
      persistence,
    });

    const running = runtime.runOnce();
    await reflectionStarted.promise;
    eligible = false;
    reflectionResult.resolve({ reflection: 'I want to compare first.', model: 'reflector' });

    await expect(running).rejects.toThrow(/source.*no longer eligible/i);
    expect(persistence.decisions).toEqual([]);
    expect(persistence.landmarks).toEqual([]);
  });

  it('skips already-audited candidates before applying the per-run new-source cap', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-backlog-'));
    const consentStore = new IntrospectionConsentStore(join(root, 'consent.jsonl'));
    consentStore.append({
      enabled: true,
      allowedPublicChannelIds: [CANDIDATE.channelId],
      actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
      reason: 'bounded backlog audit',
      createdAt: '2026-07-13T09:00:00.000Z',
    });
    const candidates = Array.from({ length: 4 }, (_, index) => ({
      ...CANDIDATE,
      sourceRef: `turn:public-${index + 1}`,
      turnId: `public-${index + 1}`,
    }));
    const persistence = new MemoryPersistence(new Set(candidates.slice(0, 3).map(entry => entry.sourceRef)));
    const estimateStableReply = vi.fn(async () => ({ stableReply: 'neutral alternative', model: 'estimator' }));
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true, maxCandidatesPerRun: 3 },
      consentStore,
      source: sourceFor(candidates),
      auditor: {
        estimateStableReply,
        compareReplies: async () => ({
          diverged: false,
          type: null,
          observation: 'No meaningful difference.',
          confidence: 0.9,
          model: 'comparator',
        }),
      },
      reflector: { reflect: vi.fn() },
      persistence,
    });

    await expect(runtime.runOnce()).resolves.toMatchObject({ audited: 1 });
    expect(estimateStableReply).toHaveBeenCalledOnce();
    expect(persistence.decisions[0]?.sourceRef).toBe('turn:public-4');
  });

  it('rejects auditor observations that echo source material', async () => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-replay-'));
    const consentStore = new IntrospectionConsentStore(join(root, 'consent.jsonl'));
    consentStore.append({
      enabled: true,
      allowedPublicChannelIds: [CANDIDATE.channelId],
      actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
      reason: 'bounded consent',
      createdAt: '2026-07-13T09:00:00.000Z',
    });
    const persistence = new MemoryPersistence();
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor(),
      auditor: {
        estimateStableReply: async () => ({ stableReply: 'neutral alternative', model: 'estimator' }),
        compareReplies: async () => ({
          diverged: true,
          type: 'substantive',
          observation: `It repeated: ${CANDIDATE.actualReply}`,
          confidence: 0.9,
          model: 'comparator',
        }),
      },
      reflector: { reflect: vi.fn() },
      persistence,
    });

    await expect(runtime.runOnce()).rejects.toThrow(/echoed source/);
    expect(persistence.landmarks).toHaveLength(0);
  });

  it.each([
    'ctualreplysentinel i agree immediately',
    'ACTUAL—REPLY, SENTINEL: I AGREE IMMEDIATELY',
    'I agree immediately',
  ])('rejects shifted, punctuation-altered, and short source quotations: %s', async (observation) => {
    root = mkdtempSync(join(tmpdir(), 'introspection-runtime-replay-variants-'));
    const consentStore = new IntrospectionConsentStore(join(root, 'consent.jsonl'));
    consentStore.append({
      enabled: true,
      allowedPublicChannelIds: [CANDIDATE.channelId],
      actor: { kind: 'companion', turnId: 'consent-turn', requestId: 'consent-request' },
      reason: 'bounded consent',
      createdAt: '2026-07-13T09:00:00.000Z',
    });
    const runtime = new IntrospectionAuditRuntime({
      config: { ...DEFAULT_INTROSPECTION_AUDIT_CONFIG, enabled: true },
      consentStore,
      source: sourceFor(),
      auditor: {
        estimateStableReply: async () => ({ stableReply: 'neutral alternative', model: 'estimator' }),
        compareReplies: async () => ({
          diverged: true,
          type: 'substantive',
          observation,
          confidence: 0.9,
          model: 'comparator',
        }),
      },
      reflector: { reflect: vi.fn() },
      persistence: new MemoryPersistence(),
    });

    await expect(runtime.runOnce()).rejects.toThrow(/echoed source/);
  });
});
