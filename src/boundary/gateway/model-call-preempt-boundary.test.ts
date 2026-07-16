// mmo9.5.1 regression: preemption→defer mapping must survive the real
// gateway→agent JSON-RPC boundary.
//
// The model-call gate lives only on the gateway's LLMClient. Background
// memory-extraction reaches it as an `llm.complete` over JSON-RPC via the
// agent-side GatewayClient. When a foreground chat preempts an in-flight
// background call, the gateway raises a typed ModelCallPreemptedError — but
// json-rpc-2.0's default error mapping flattens any non-JSONRPCErrorException to
// a generic { code: -32603, data: undefined }, losing the error NAME. If that
// happens the agent's `error.name === 'ModelCallPreemptedError'` name-match
// fails, the preempt is charged as a provider failure, and after maxAttempts
// the background cognition job is permanently lost.
//
// These tests drive a REAL GatewayClient over a transport that performs the
// actual json-rpc-2.0 serialize→deserialize against a REAL gateway-side
// JSONRPCServer whose handler runs the production `exposeModelCallGateBlocks`
// mapping — no mock transport short-circuit. They assert the reconstructed
// agent-side error is a typed ModelCallPreemptedError, then feed that exact
// error through executePostTurnBackgroundWork to prove it defers
// (foreground_active) with no attempt consumed rather than failing.

import { EventEmitter } from 'node:events';
import { describe, it, expect, afterEach } from 'vitest';
import { JSONRPCServer } from 'json-rpc-2.0';
import { GatewayClient } from './client.js';
import { exposeModelCallGateBlocks, resolveRpcWorkSpec } from './methods/llm.js';
import type { GatewayMethodRuntime } from './methods/types.js';
import type { NdjsonConnection, GatewayRpcSerializedTransportStats } from './transport.js';
import { ModelCallGate, ModelCallPreemptedError } from '../../primitives/llm/model-call-gate.js';
import { buildLLMWorkSpec } from '../../primitives/llm/work-spec.js';
import type { LLMWorkSpecWireParams } from '../../primitives/llm/work-spec-wire.js';
import {
  executePostTurnBackgroundWork,
  type PostTurnBackgroundRuntimeDependencies,
} from '../../core/agent/background-work/post-turn-runtime.js';
import {
  BackgroundWorkDeferredError,
  type BackgroundWorkExecutionInput,
} from '../../core/agent/background-work/supervisor.js';

const EMPTY_STATS: GatewayRpcSerializedTransportStats = {
  frameCount: 0,
  serializedBytes: 0,
  rpcCallCount: 0,
  byMethod: {},
};

/**
 * Wire a real GatewayClient to a real gateway-side JSONRPCServer. Every frame
 * crosses `JSON.parse(JSON.stringify(...))` in both directions so the test
 * exercises genuine json-rpc-2.0 serialization + the server's default error
 * mapping (defaultMapErrorToJSONRPCErrorResponse), not an in-process shortcut.
 */
function createBoundaryHarness(
  methods: Record<string, (params: unknown) => Promise<unknown>>,
): { client: GatewayClient; destroy: () => void } {
  const server = new JSONRPCServer();
  for (const [name, handler] of Object.entries(methods)) {
    server.addMethod(name, handler);
  }
  const emitter = new EventEmitter();
  const conn = {
    send(data: unknown): boolean {
      const request = JSON.parse(JSON.stringify(data)) as { method?: unknown; id?: unknown };
      if (typeof request.method === 'string') {
        void server.receive(request as Parameters<typeof server.receive>[0]).then((response) => {
          if (response) {
            emitter.emit('message', JSON.parse(JSON.stringify(response)));
          }
        });
      }
      return true;
    },
    sendHeartbeat(): boolean {
      return true;
    },
    onHeartbeat(): void {},
    onMessage(handler: (message: unknown) => void): void {
      emitter.on('message', handler);
    },
    on(): void {},
    destroy(): void {
      emitter.removeAllListeners();
    },
    get destroyed(): boolean {
      return false;
    },
    get serializedTransportStats(): GatewayRpcSerializedTransportStats {
      return EMPTY_STATS;
    },
  };
  const client = new GatewayClient(conn as unknown as NdjsonConnection, 1024);
  return {
    client,
    destroy: () => {
      client.destroy();
      emitter.removeAllListeners();
    },
  };
}

function makePreemption(): ModelCallPreemptedError {
  // capacity=1 shared endpoint: a background continuation call is aborted by a
  // higher-priority foreground_chat acquire.
  return new ModelCallPreemptedError(
    'registered_model::local_endpoint',
    'background_continuation',
    'foreground_chat',
  );
}

describe('model-call preemption across the gateway→agent JSON-RPC boundary (mmo9.5.1)', () => {
  const harnesses: Array<{ destroy: () => void }> = [];
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.destroy();
  });

  it('reconstructs a typed ModelCallPreemptedError from llm.complete over real serialization', async () => {
    const harness = createBoundaryHarness({
      'llm.complete': async () =>
        await exposeModelCallGateBlocks(async () => {
          throw makePreemption();
        }),
    });
    harnesses.push(harness);

    const error = await harness.client
      .complete({ systemPrompt: 'x', messages: [] }, 'memory_extraction')
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    // The load-bearing assertion: the abort survives the wire as a typed error,
    // NOT a flattened generic Error (whose .name would be 'Error').
    expect(error).toBeInstanceOf(ModelCallPreemptedError);
    expect((error as Error).name).toBe('ModelCallPreemptedError');
    expect((error as ModelCallPreemptedError).resourceKey).toBe('registered_model::local_endpoint');
    expect((error as ModelCallPreemptedError).preemptedRuntimeClass).toBe('background_continuation');
    expect((error as ModelCallPreemptedError).preemptorRuntimeClass).toBe('foreground_chat');
  });

  it('reconstructs a typed ModelCallPreemptedError from llm.chat over real serialization', async () => {
    const harness = createBoundaryHarness({
      'llm.chat': async () =>
        await exposeModelCallGateBlocks(async () => {
          throw makePreemption();
        }),
    });
    harnesses.push(harness);

    const error = await harness.client
      .stream({ systemPrompt: 'x', messages: [] })
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ModelCallPreemptedError);
    expect((error as Error).name).toBe('ModelCallPreemptedError');
    expect((error as ModelCallPreemptedError).preemptorRuntimeClass).toBe('foreground_chat');
  });

  it('the boundary-reconstructed error defers the background job (no attempt consumed)', async () => {
    const harness = createBoundaryHarness({
      'llm.complete': async () =>
        await exposeModelCallGateBlocks(async () => {
          throw makePreemption();
        }),
    });
    harnesses.push(harness);

    // Reconstruct the error exactly as production does: gateway gate → real wire
    // → agent GatewayClient. This is the SAME error object post-turn-runtime
    // sees when the extractor's llm.complete is preempted.
    const reconstructed = await harness.client
      .complete({ systemPrompt: 'x', messages: [] }, 'memory_extraction')
      .then(() => null)
      .catch((thrown: unknown) => thrown);
    expect(reconstructed).toBeInstanceOf(ModelCallPreemptedError);

    const execution = {
      payload: {
        schemaVersion: 1,
        kind: 'memory_extraction',
        source: {
          schemaVersion: 1,
          logicalSessionId: 'session-1',
          channelId: 'channel-1',
          turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
          requestId: 'request-1',
          turnRecordFingerprint: 'fingerprint-1',
          createdAtMs: 1,
          assistantSessionEntryId: 1,
        },
      },
      job: {},
      effects: {},
    } as unknown as BackgroundWorkExecutionInput;
    const dependencies = {
      // Surface the boundary-reconstructed preemption from where the extractor
      // is resolved (its llm.complete would raise it in production). The
      // disposition executePostTurnBackgroundWork produces is what matters.
      getMemoryExtractor: () => {
        throw reconstructed;
      },
    } as unknown as PostTurnBackgroundRuntimeDependencies;

    const disposition = await executePostTurnBackgroundWork(execution, dependencies)
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    // Deferred, not failed: the preempt maps to foreground_active with no
    // attempt consumed — the guarantee the flattened-error path violated.
    expect(disposition).toBeInstanceOf(BackgroundWorkDeferredError);
    expect((disposition as BackgroundWorkDeferredError).reasonCode).toBe('foreground_active');
  });
});

// psfn-framework-fxt1: the gateway RPC boundary must re-verify a caller-asserted
// `preemptionProtected` against the welfare-grant authority (the background-work
// store) and STRIP it on any failure before the gate can honor it. These tests
// exercise the real `resolveRpcWorkSpec` boundary path plus a REAL ModelCallGate,
// and the strip decision over the real JSON-RPC wire.

const OWN_COMPANION = 'companion-a';
const OTHER_COMPANION = 'companion-b';

/**
 * A stub gateway method runtime exposing only what `resolveRpcWorkSpec` reads:
 * the authenticated companion and the welfare-grant verifier. The verifier here
 * stands in for the store's schema-scoped `welfare_claimed AND running` check.
 */
function stubRuntime(options: {
  companionId?: string;
  verify?: (jobId: string, companionId: string) => Promise<boolean>;
}): GatewayMethodRuntime {
  return {
    authenticatedCompanionId: () => options.companionId,
    ...(options.verify ? { verifyWelfareGrant: options.verify } : {}),
  } as unknown as GatewayMethodRuntime;
}

/** A forged wire spec on a preemptable lane asserting protection. */
function forgedProtectedSpec(overrides: Partial<LLMWorkSpecWireParams> = {}): LLMWorkSpecWireParams {
  return {
    purpose: 'extraction',
    lane: 'background_continuation',
    durable: true,
    preemptionProtected: true,
    ...overrides,
  };
}

/**
 * Drive a REAL ModelCallGate at capacity 1: a background_continuation call takes
 * the only slot, then a higher-priority foreground_chat acquires. Returns
 * whether the background call was preempted (aborted) — i.e. whether its slot
 * was granted preemptable.
 */
async function backgroundIsPreemptedByForeground(preemptionProtected: boolean): Promise<boolean> {
  const gate = new ModelCallGate();
  const resourceKey = 'registered_model::local_endpoint';
  const capacity = { capacity: 1, reservedForegroundSlots: 0 };

  let releaseBackground!: () => void;
  const backgroundBarrier = new Promise<void>((resolve) => { releaseBackground = resolve; });
  let markBackgroundStarted!: () => void;
  const backgroundStarted = new Promise<void>((resolve) => { markBackgroundStarted = resolve; });

  const backgroundRun = gate.run(
    { resourceKey, runtimeClass: 'background_continuation', capacity, preemptionProtected },
    async (signal) => {
      markBackgroundStarted();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void backgroundBarrier.then(resolve);
      });
      return 'background-done';
    },
  );
  const backgroundOutcome = backgroundRun
    .then(() => ({ preempted: false }))
    .catch((error: unknown) => ({ preempted: error instanceof ModelCallPreemptedError }));

  await backgroundStarted;

  const foregroundRun = gate.run(
    { resourceKey, runtimeClass: 'foreground_chat', capacity },
    async () => 'foreground-done',
  );

  // Let the gate process the contended acquire (preempt or enqueue).
  await new Promise((resolve) => setTimeout(resolve, 15));
  // A protected background is not aborted; release it so the queued foreground
  // can proceed and the test terminates.
  if (preemptionProtected) releaseBackground();

  const outcome = await backgroundOutcome;
  await foregroundRun;
  return outcome.preempted;
}

describe('welfare grant verification at the gateway RPC boundary (fxt1)', () => {
  const harnesses: Array<{ destroy: () => void }> = [];
  afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.destroy();
  });

  it('strips a forged preemptionProtected with no welfareGrantJobId', async () => {
    const runtime = stubRuntime({
      companionId: OWN_COMPANION,
      verify: async () => true, // never consulted: no grant id to verify
    });
    const resolved = await resolveRpcWorkSpec(forgedProtectedSpec(), runtime);
    expect(resolved?.preemptionProtected).toBeUndefined();
    // The stripped call is preemptable: a foreground acquire aborts it.
    expect(await backgroundIsPreemptedByForeground(false)).toBe(true);
  });

  it('strips when the grant row is not welfare-claimed (verify returns false)', async () => {
    const runtime = stubRuntime({
      companionId: OWN_COMPANION,
      verify: async () => false,
    });
    const resolved = await resolveRpcWorkSpec(
      forgedProtectedSpec({ welfareGrantJobId: 'job-not-welfare' }),
      runtime,
    );
    expect(resolved?.preemptionProtected).toBeUndefined();
    expect(resolved).not.toHaveProperty('welfareGrantJobId');
  });

  it("strips a valid welfare job id owned by a different companion", async () => {
    // The verifier is companion-scoped: companion A presents a job id that only
    // verifies under companion B's schema → false under A → strip.
    const verify = async (jobId: string, companionId: string): Promise<boolean> =>
      jobId === 'b-welfare-job' && companionId === OTHER_COMPANION;
    const runtime = stubRuntime({ companionId: OWN_COMPANION, verify });
    const resolved = await resolveRpcWorkSpec(
      forgedProtectedSpec({ welfareGrantJobId: 'b-welfare-job' }),
      runtime,
    );
    expect(resolved?.preemptionProtected).toBeUndefined();
  });

  it('retains protection for a legit welfare-claimed job (own companion) and never forwards the token', async () => {
    const verify = async (jobId: string, companionId: string): Promise<boolean> =>
      jobId === 'a-welfare-job' && companionId === OWN_COMPANION;
    const runtime = stubRuntime({ companionId: OWN_COMPANION, verify });
    const resolved = await resolveRpcWorkSpec(
      forgedProtectedSpec({ welfareGrantJobId: 'a-welfare-job' }),
      runtime,
    );
    expect(resolved?.preemptionProtected).toBe(true);
    // welfareGrantJobId is a gateway-only token — stripped before forwarding.
    expect(resolved).not.toHaveProperty('welfareGrantJobId');
    // The protected call is NOT preemptable: a foreground acquire does not abort it.
    expect(await backgroundIsPreemptedByForeground(true)).toBe(false);
  });

  it('fails closed when verifyWelfareGrant throws (DB error), no exception propagates', async () => {
    const runtime = stubRuntime({
      companionId: OWN_COMPANION,
      verify: async () => { throw new Error('connection reset'); },
    });
    const resolved = await resolveRpcWorkSpec(
      forgedProtectedSpec({ welfareGrantJobId: 'a-welfare-job' }),
      runtime,
    );
    expect(resolved?.preemptionProtected).toBeUndefined();
  });

  it('strips when the gateway has no welfare verifier configured', async () => {
    const runtime = stubRuntime({ companionId: OWN_COMPANION }); // no verifier
    const resolved = await resolveRpcWorkSpec(
      forgedProtectedSpec({ welfareGrantJobId: 'a-welfare-job' }),
      runtime,
    );
    expect(resolved?.preemptionProtected).toBeUndefined();
  });

  it('is a no-op on an inert lane: a non-protected spec is forwarded unchanged', async () => {
    // On foreground_chat / post_turn_appraisal the flag is inert at the gate.
    // A spec that does not assert protection is verified against nothing and
    // forwarded as-is (the welfare token, if present, is still dropped).
    const runtime = stubRuntime({ companionId: OWN_COMPANION, verify: async () => false });
    const resolved = await resolveRpcWorkSpec(
      { purpose: 'chat', lane: 'foreground_chat', durable: false },
      runtime,
    );
    expect(resolved).toEqual({ purpose: 'chat', lane: 'foreground_chat', durable: false });
  });

  it('a malformed spec still rejects at the boundary before verification', async () => {
    const runtime = stubRuntime({ companionId: OWN_COMPANION, verify: async () => true });
    await expect(
      resolveRpcWorkSpec({ purpose: 'chat', lane: 'not_a_lane', durable: true }, runtime),
    ).rejects.toThrow();
  });

  it('the welfare token survives the real JSON-RPC wire and is verified gateway-side', async () => {
    // Full agent→wire→gateway path: a real GatewayClient serializes the work
    // spec through toWorkSpecWireParams over genuine JSON, the gateway handler
    // parses it and runs the production resolveRpcWorkSpec. We capture what the
    // boundary decided.
    let seenWorkSpec: unknown;
    let resolvedAtBoundary: LLMWorkSpecWireParams | undefined;
    const runtime = stubRuntime({
      companionId: OWN_COMPANION,
      verify: async (jobId, companionId) => jobId === 'a-welfare-job' && companionId === OWN_COMPANION,
    });
    const harness = createBoundaryHarness({
      'llm.complete': async (params) => {
        seenWorkSpec = (params as { workSpec?: unknown }).workSpec;
        resolvedAtBoundary = await resolveRpcWorkSpec(seenWorkSpec, runtime);
        return {
          content: '',
          model: 'test-model',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        };
      },
    });
    harnesses.push(harness);

    await harness.client.complete(
      { systemPrompt: 'x', messages: [] },
      'extraction',
      {
        workSpec: buildLLMWorkSpec({
          purpose: 'extraction',
          durable: true,
          preemptionProtected: true,
          welfareGrantJobId: 'a-welfare-job',
        }),
      },
    );

    // The grant token crossed the wire intact...
    expect((seenWorkSpec as { welfareGrantJobId?: unknown }).welfareGrantJobId).toBe('a-welfare-job');
    // ...and the boundary honored it (own companion, verifies), dropping the token.
    expect(resolvedAtBoundary?.preemptionProtected).toBe(true);
    expect(resolvedAtBoundary).not.toHaveProperty('welfareGrantJobId');
  });
});
