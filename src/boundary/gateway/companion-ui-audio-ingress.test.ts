import { describe, expect, it, vi } from 'vitest';
import type {
  SttStreamConfig,
  SttStreamSession,
  SttTranscriptChunk,
  StreamingSttConnector,
} from '../../primitives/voice/connectors/stt/types.js';
import { GatewayCompanionUiAudioIngress } from './companion-ui-audio-ingress.js';

describe('GatewayCompanionUiAudioIngress', () => {
  it('streams PCM16 mono 16 kHz and emits one bounded final utterance', async () => {
    const harness = createSttHarness();
    const partial = vi.fn();
    const utterance = vi.fn(async () => undefined);
    const ingress = new GatewayCompanionUiAudioIngress({
      createConnector: () => harness.connector,
      maxFrameBytes: 32,
      maxPendingUtterances: 2,
      maxTranscriptBytes: 128,
    });

    const session = await ingress.start({
      companionId: '11111111-1111-4111-8111-111111111111',
      onPartial: partial,
      onUtterance: utterance,
      onError: vi.fn(),
    });
    await session.writePcm(Uint8Array.of(0x01, 0x00, 0xff, 0xff));
    harness.emit({ type: 'final', text: 'hello' });
    harness.emit({ type: 'partial', text: 'world' });
    harness.emit({ type: 'final', text: 'world', utteranceFinal: true });
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledWith('hello world'));

    expect(harness.startConfig).toEqual({
      sampleRateHz: 16_000,
      channels: 1,
      encoding: 'pcm_s16le',
      interimResults: true,
    });
    expect(harness.writes).toEqual([Uint8Array.of(0x01, 0x00, 0xff, 0xff)]);
    expect(partial).toHaveBeenCalledWith('hello world');
    await session.stop('badge disconnected');
    expect(harness.endInput).toHaveBeenCalledOnce();
  });

  it('rejects malformed or oversized PCM before it reaches STT', async () => {
    const harness = createSttHarness();
    const ingress = new GatewayCompanionUiAudioIngress({
      createConnector: () => harness.connector,
      maxFrameBytes: 4,
      maxPendingUtterances: 1,
      maxTranscriptBytes: 128,
    });
    const session = await ingress.start({
      companionId: '11111111-1111-4111-8111-111111111111',
      onPartial: vi.fn(),
      onUtterance: vi.fn(async () => undefined),
      onError: vi.fn(),
    });

    await expect(session.writePcm(Uint8Array.of(1))).rejects.toThrow('PCM16');
    await expect(session.writePcm(Uint8Array.of(0, 0, 0, 0, 0, 0))).rejects.toThrow('frame limit');
    expect(harness.writes).toHaveLength(0);
    await session.cancel('test complete');
  });

  it('fails visibly instead of buffering unbounded completed utterances', async () => {
    const harness = createSttHarness();
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const onError = vi.fn();
    const onUtterance = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined);
    const ingress = new GatewayCompanionUiAudioIngress({
      createConnector: () => harness.connector,
      maxFrameBytes: 32,
      maxPendingUtterances: 1,
      maxTranscriptBytes: 128,
    });
    const session = await ingress.start({
      companionId: '11111111-1111-4111-8111-111111111111',
      onPartial: vi.fn(),
      onUtterance,
      onError,
    });

    harness.emit({ type: 'final', text: 'one', utteranceFinal: true });
    await flushPromises();
    harness.emit({ type: 'final', text: 'two', utteranceFinal: true });
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Companion audio utterance backlog exceeded 1',
    }));
    releaseFirst?.();
    await session.cancel('test complete');
  });
});

function createSttHarness() {
  const values: SttTranscriptChunk[] = [];
  const waiters: Array<(value: IteratorResult<SttTranscriptChunk>) => void> = [];
  let closed = false;
  const writes: Uint8Array[] = [];
  let startConfig: SttStreamConfig | undefined;
  const endInput = vi.fn(async () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
  });
  const cancel = vi.fn(async () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
  });
  const stream: SttStreamSession = {
    transcripts: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<SttTranscriptChunk>> => {
            const value = values.shift();
            if (value) return { done: false, value };
            if (closed) return { done: true, value: undefined };
            return await new Promise(resolve => waiters.push(resolve));
          },
        };
      },
    },
    writeAudio: async pcm => { writes.push(pcm.slice()); },
    endInput,
    cancel,
  };
  const connector: StreamingSttConnector = {
    id: 'fake',
    startStream: async config => {
      startConfig = config;
      return stream;
    },
  };
  return {
    connector,
    writes,
    endInput,
    get startConfig() { return startConfig; },
    emit(chunk: SttTranscriptChunk) {
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value: chunk });
      else values.push(chunk);
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
