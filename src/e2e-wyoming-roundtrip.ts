// ── Wyoming MVP Round-Trip Smoke Harness ──
// Deterministic smoke checks for the Wyoming MVP contract:
// 1) describe -> info capability advertisement
// 2) transcript -> handle -> agent_text/tts_text round-trip
// 3) interruption behavior for an in-flight handle request
//
// Run: npx tsx src/e2e-wyoming-roundtrip.ts

import { setTimeout as delay } from 'node:timers/promises';
import { WyomingRuntime } from './channels/wyoming/runtime.js';
import { toErrorMessage } from './utils/errors.js';
import {
  WYOMING_EVENT_DESCRIBE,
  WYOMING_EVENT_INFO,
  WYOMING_EVENT_SESSION_END,
  WYOMING_EVENT_SESSION_START,
  type WyomingFrame,
  type WyomingTransportSession,
} from './channels/wyoming/protocol.js';

const HANDLE_EVENT = 'handle';
const HANDLE_RESULT_EVENT = 'handle.result';
const PROCESSING_DELAY_MS = 120;

interface HarnessState {
  cancelledHandleCount: number;
  closedSessions: Set<string>;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  PASS ${label}`);
    passed += 1;
  } else {
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
    failed += 1;
  }
}

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

function createTransportSession(connectionId: string): WyomingTransportSession {
  const now = Date.now();
  return {
    id: connectionId,
    connectionId,
    openedAtMs: now,
    lastSeenAtMs: now,
  };
}

function sessionKey(connectionId: string, sessionId: string): string {
  return `${connectionId}:${sessionId}`;
}

function readString(frame: WyomingFrame, key: string): string | undefined {
  const value = frame.data?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(frame: WyomingFrame, key: string): number | undefined {
  const value = frame.data?.[key];
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

async function runRoundTripScenario(params: {
  runtime: WyomingRuntime;
  transportSession: WyomingTransportSession;
  emitted: WyomingFrame[];
}): Promise<void> {
  const { runtime, transportSession, emitted } = params;
  const sessionId = 'voice-pe-roundtrip';
  const transcript = 'Status check alpha for Voice PE kitchen satellite.';

  section('Round-Trip');
  emitted.length = 0;

  await runtime.handleFrame(transportSession, { type: WYOMING_EVENT_DESCRIBE });
  const infoFrame = emitted.find((frame) => frame.type === WYOMING_EVENT_INFO);
  const services = Array.isArray(infoFrame?.data?.services) ? infoFrame.data.services : [];
  const hasHandle = services.some((service) => (
    typeof service === 'object'
    && service !== null
    && (service as Record<string, unknown>).name === 'handle'
  ));

  assert(Boolean(infoFrame), 'describe emits info frame');
  assert(hasHandle, 'info advertises handle service');

  emitted.length = 0;
  await runtime.handleFrame(transportSession, {
    type: WYOMING_EVENT_SESSION_START,
    data: { session_id: sessionId },
  });
  await runtime.handleFrame(transportSession, {
    type: HANDLE_EVENT,
    data: {
      session_id: sessionId,
      site_id: 'ha-main',
      satellite_id: 'voice-pe-kitchen',
      ha_user_id: 'owner',
      transcript,
    },
  });
  await runtime.handleFrame(transportSession, {
    type: WYOMING_EVENT_SESSION_END,
    data: { session_id: sessionId },
  });

  const startAck = emitted.find((frame) => (
    frame.type === 'ack'
    && readString(frame, 'event') === WYOMING_EVENT_SESSION_START
    && readString(frame, 'session_id') === sessionId
  ));
  const endAck = emitted.find((frame) => (
    frame.type === 'ack'
    && readString(frame, 'event') === WYOMING_EVENT_SESSION_END
    && readString(frame, 'session_id') === sessionId
  ));
  const resultFrame = emitted.find((frame) => (
    frame.type === HANDLE_RESULT_EVENT
    && readString(frame, 'session_id') === sessionId
  ));

  const returnedTranscript = resultFrame ? readString(resultFrame, 'transcript') : undefined;
  const agentText = resultFrame ? readString(resultFrame, 'agent_text') : undefined;
  const ttsText = resultFrame ? readString(resultFrame, 'tts_text') : undefined;

  assert(Boolean(startAck), 'session.start ack emitted');
  assert(Boolean(resultFrame), 'handle response frame emitted');
  assert(returnedTranscript === transcript, 'response contains original transcript');
  assert(Boolean(agentText && agentText.length > 0), 'response contains non-empty agent text');
  assert(agentText === ttsText, 'agent text and tts text are aligned');
  assert(Boolean(endAck), 'session.end ack emitted');
}

async function runInterruptionScenario(params: {
  runtime: WyomingRuntime;
  transportSession: WyomingTransportSession;
  emitted: WyomingFrame[];
  state: HarnessState;
}): Promise<void> {
  const {
    runtime,
    transportSession,
    emitted,
    state,
  } = params;
  const sessionId = 'voice-pe-interruption';
  const cancelledBefore = state.cancelledHandleCount;

  section('Interruption');
  emitted.length = 0;

  await runtime.handleFrame(transportSession, {
    type: WYOMING_EVENT_SESSION_START,
    data: { session_id: sessionId },
  });

  const inFlightHandle = runtime.handleFrame(transportSession, {
    type: HANDLE_EVENT,
    data: {
      session_id: sessionId,
      site_id: 'ha-main',
      satellite_id: 'voice-pe-kitchen',
      ha_user_id: 'owner',
      transcript: 'Read a long response so I can interrupt.',
      simulate_ms: PROCESSING_DELAY_MS,
    },
  });

  await delay(20);
  await runtime.handleFrame(transportSession, {
    type: WYOMING_EVENT_SESSION_END,
    data: { session_id: sessionId },
  });
  await inFlightHandle;

  const resultAfterEnd = emitted.find((frame) => (
    frame.type === HANDLE_RESULT_EVENT
    && readString(frame, 'session_id') === sessionId
  ));
  const endAck = emitted.find((frame) => (
    frame.type === 'ack'
    && readString(frame, 'event') === WYOMING_EVENT_SESSION_END
    && readString(frame, 'session_id') === sessionId
  ));

  assert(Boolean(endAck), 'session.end ack emitted for interruption case');
  assert(!resultAfterEnd, 'no handle.result emitted after interruption');
  assert(
    state.cancelledHandleCount === cancelledBefore + 1,
    'in-flight handle request is marked cancelled',
    `cancelled before=${cancelledBefore} after=${state.cancelledHandleCount}`,
  );
}

async function main(): Promise<void> {
  console.log('=== Wyoming MVP Smoke Harness ===');

  const emitted: WyomingFrame[] = [];
  const state: HarnessState = {
    cancelledHandleCount: 0,
    closedSessions: new Set<string>(),
  };

  const runtime = new WyomingRuntime({
    info: {
      name: 'psfn-wyoming-smoke',
      version: '0.1.0',
      description: 'Wyoming MVP smoke runtime',
      services: [
        {
          name: 'handle',
          version: '1.0.0',
          supports: [HANDLE_EVENT, HANDLE_RESULT_EVENT],
        },
      ],
    },
    emitFrame: async (_transportSession, frame) => {
      emitted.push(frame);
    },
    onSessionEnd: async (session) => {
      state.closedSessions.add(sessionKey(session.connectionId, session.sessionId));
    },
    onUnhandledEvent: async ({ frame, session, sessionId }) => {
      if (frame.type !== HANDLE_EVENT) {
        throw new Error(`Unsupported event in smoke harness: ${frame.type}`);
      }
      if (!session || !sessionId) {
        throw new Error('handle requires an active session');
      }

      const transcript = readString(frame, 'transcript');
      if (!transcript) {
        throw new Error('handle requires non-empty transcript');
      }

      const processingDelay = readNumber(frame, 'simulate_ms') ?? PROCESSING_DELAY_MS;
      await delay(processingDelay);

      if (state.closedSessions.has(sessionKey(session.connectionId, sessionId))) {
        state.cancelledHandleCount += 1;
        return;
      }

      const agentText = `Agent response for ${readString(frame, 'satellite_id') ?? 'unknown-satellite'}: ${transcript}`;
      return {
        type: HANDLE_RESULT_EVENT,
        data: {
          session_id: sessionId,
          transcript,
          agent_text: agentText,
          tts_text: agentText,
          site_id: readString(frame, 'site_id') ?? 'unknown-site',
          satellite_id: readString(frame, 'satellite_id') ?? 'unknown-satellite',
          ha_user_id: readString(frame, 'ha_user_id') ?? 'unknown-user',
        },
      };
    },
  });

  const transportSession = createTransportSession('wyoming-smoke-conn-1');

  try {
    await runRoundTripScenario({
      runtime,
      transportSession,
      emitted,
    });
    await runInterruptionScenario({
      runtime,
      transportSession,
      emitted,
      state,
    });
  } finally {
    await runtime.stop();
  }

  section('Summary');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Cancelled handle requests: ${state.cancelledHandleCount}`);

  if (failed > 0) {
    throw new Error(`Wyoming MVP smoke harness failed with ${failed} failed checks`);
  }

  console.log('\nPASS: Wyoming MVP round-trip and interruption smoke checks passed.');
}

main().catch((error) => {
  console.error('\nFAIL: Wyoming MVP smoke harness failed.');
  console.error(toErrorMessage(error));
  process.exit(1);
});
