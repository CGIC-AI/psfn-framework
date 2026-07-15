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
import { exposeModelCallGateBlocks } from './methods/llm.js';
import type { NdjsonConnection, GatewayRpcSerializedTransportStats } from './transport.js';
import { ModelCallPreemptedError } from '../../primitives/llm/model-call-gate.js';
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
