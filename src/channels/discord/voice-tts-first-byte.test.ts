import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';

// Regression coverage for psfn-framework-mmo9.6.4: the TTS first-byte budget is
// separated from the playback budget. Unlike voice.test.ts, this suite exercises
// the REAL reliability policy (no mock) so the short, retry-safe `tts_first_byte`
// stage and its cancel-prior-attempt guarantee are actually observed.

vi.mock('@discordjs/voice', () => ({
  createAudioPlayer: vi.fn(() => ({ play: vi.fn(), stop: vi.fn() })),
  createAudioResource: vi.fn((resource: unknown) => ({ resource })),
  EndBehaviorType: { AfterSilence: 'after-silence' },
  entersState: vi.fn(async () => undefined),
  joinVoiceChannel: vi.fn(),
  AudioPlayerStatus: { Playing: 'playing', Idle: 'idle' },
  VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected' },
}));

vi.mock('prism-media', () => ({
  default: { opus: { Decoder: class { on(): void {} once(): void {} off(): void {} destroy(): void {} } } },
}));

vi.mock('../../primitives/voice/policy/security.js', () => ({
  resolveVoiceSecurityLimits: vi.fn(() => ({
    maxPcmBytes: 10_000_000,
    maxTranscriptChars: 20_000,
    maxTtsChars: 20_000,
    maxTtsAudioBytes: 10_000_000,
  })),
  validatePcmAudio: vi.fn(),
  validatePcmAudioChunk: vi.fn((chunk: Uint8Array, total: number) => total + chunk.byteLength),
  validateTranscriptText: vi.fn((text: string) => text.trim()),
  validateTtsInputText: vi.fn((text: string) => text.trim()),
  validateTtsAudioChunk: vi.fn((chunk: Uint8Array, total: number) => total + chunk.byteLength),
}));

// Real reliability policy — the whole point of this suite.
import { resolveVoiceReliabilityBudgets } from '../../primitives/voice/policy/reliability.js';
import {
  acquireTtsFirstByte,
  playWithTtsConnector,
} from './voice-turn-runtime.js';

type Chunk = { audio: Uint8Array; sequence?: number };

async function* chunks(...values: number[][]): AsyncGenerator<Chunk> {
  for (let i = 0; i < values.length; i += 1) {
    yield { audio: new Uint8Array(values[i]!), sequence: i };
  }
}

function hangingAudio(): AsyncIterable<Chunk> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<Chunk>>(() => {}) };
    },
  };
}

function makeTurn(): any {
  const abortController = new AbortController();
  return {
    token: Symbol('turn'),
    turnId: 'voice-turn-test',
    channel: { id: 'channel-1' },
    connection: {},
    player: { play: vi.fn(), stop: vi.fn() },
    abortController,
    sttSession: null,
    ttsSession: null,
  };
}

function makeRuntime(
  eventBus: EventBus,
  budgets: ReturnType<typeof resolveVoiceReliabilityBudgets>,
  turn: any,
  overrides: Record<string, unknown> = {},
): any {
  return {
    reliabilityBudgets: budgets,
    securityLimits: {},
    eventBus,
    targetUserId: 'user-1',
    preferredTtsProviderId: 'elevenlabs',
    config: { companionId: 'companion-1' },
    player: turn.player,
    activeTurn: turn,
    activeTurnId: turn.turnId,
    ...overrides,
  };
}

describe('TTS first-byte budget (mmo9.6.4)', () => {
  it('AC(b): a stalled first byte times out under the short budget and its retry cancels the prior session BEFORE re-synth', async () => {
    const events: string[] = [];
    const eventBus = new EventBus();
    const turn = makeTurn();
    const budgets = resolveVoiceReliabilityBudgets({
      tts_first_byte: { timeoutMs: 25, maxRetries: 1, baseDelayMs: 0 },
    });

    const firstSession = {
      audio: hangingAudio(),
      cancel: vi.fn(async () => { events.push('cancel-prior'); }),
    };
    const secondSession = {
      audio: chunks([1, 2, 3]),
      cancel: vi.fn(async () => {}),
    };

    let synthCall = 0;
    const connector = {
      id: 'elevenlabs',
      synthesizeStream: vi.fn(async () => {
        synthCall += 1;
        events.push(`synth-${synthCall}`);
        return synthCall === 1 ? firstSession : secondSession;
      }),
      synthesizeBuffer: vi.fn(),
    };

    const runtime = makeRuntime(eventBus, budgets, turn);

    const acquired = await acquireTtsFirstByte(runtime, connector, 'hello', turn);

    expect(connector.synthesizeStream).toHaveBeenCalledTimes(2);
    expect(firstSession.cancel).toHaveBeenCalledTimes(1);
    expect(firstSession.cancel).toHaveBeenCalledWith('tts-first-byte-retry');
    // Prior session was cancelled BEFORE the second synth request went out.
    expect(events).toEqual(['synth-1', 'cancel-prior', 'synth-2']);
    expect(acquired.firstChunk?.audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(turn.ttsSession).toBe(secondSession);
  });

  it('AC(a): a reply whose playback exceeds the old 25s does NOT trigger a second synth (no double-speak)', async () => {
    const eventBus = new EventBus();
    const turn = makeTurn();
    const budgets = resolveVoiceReliabilityBudgets({
      // Tiny first-byte budget: if playback were still wrapped by it, a long
      // playback would time out and re-synth. It must not.
      tts_first_byte: { timeoutMs: 30, maxRetries: 1, baseDelayMs: 0 },
    });

    const session = { audio: chunks([1, 2, 3]), cancel: vi.fn(async () => {}) };
    const connector = {
      id: 'elevenlabs',
      synthesizeStream: vi.fn(async () => session),
      synthesizeBuffer: vi.fn(),
    };

    // Playback takes far longer than the first-byte budget.
    const playReadableAudio = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    });
    const runtime = makeRuntime(eventBus, budgets, turn, { playReadableAudio });

    await playWithTtsConnector(runtime, connector, 'a very long reply', turn);

    expect(connector.synthesizeStream).toHaveBeenCalledTimes(1);
    expect(connector.synthesizeBuffer).not.toHaveBeenCalled();
    expect(playReadableAudio).toHaveBeenCalledTimes(1);
    // Prior-session cancel-on-retry never fired, so no overlapping playback.
    expect(session.cancel).toHaveBeenCalledTimes(1); // playback-finished cleanup only
    expect(session.cancel).toHaveBeenCalledWith('playback-finished');
  });

  it('AC(c): the TTFA telemetry boundary is the first AUDIBLE byte — emitted once, after any leading empty chunk', async () => {
    const eventBus = new EventBus();
    const turn = makeTurn();
    const budgets = resolveVoiceReliabilityBudgets();

    const firstByteEvents: number[] = [];
    const perfStages: string[] = [];
    eventBus.on('voice.tts.first-byte', (event) => { firstByteEvents.push(event.timestampMs); });
    eventBus.on('agent.turn.performance', (event) => { perfStages.push(event.stage); });

    // A leading empty chunk must NOT count as the first audible byte.
    const session = { audio: chunks([], [4, 5, 6]), cancel: vi.fn(async () => {}) };
    const connector = {
      id: 'elevenlabs',
      synthesizeStream: vi.fn(async () => session),
      synthesizeBuffer: vi.fn(),
    };
    const runtime = makeRuntime(eventBus, budgets, turn);

    const acquired = await acquireTtsFirstByte(runtime, connector, 'hi', turn);

    expect(acquired.firstChunk?.audio).toEqual(new Uint8Array([4, 5, 6]));
    expect(firstByteEvents).toHaveLength(1);
    await vi.waitFor(() => expect(perfStages).toContain('tts_first_byte'));
    expect(perfStages.filter((stage) => stage === 'tts_first_byte')).toHaveLength(1);
  });
});
