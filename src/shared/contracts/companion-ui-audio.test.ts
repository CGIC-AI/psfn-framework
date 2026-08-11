import { describe, expect, it } from 'vitest';
import {
  CompanionUiAudioProtocolError,
  encodeCompanionUiAudioChunk,
  parseCompanionUiAudioChunk,
  parseCompanionUiAudioControlFrame,
  parseCompanionUiAudioServerFrame,
} from './companion-ui-audio.js';

describe('Companion UI audio wire contract', () => {
  it('round-trips ordered PCM16 chunks without carrying browser authority', () => {
    const pcm = Uint8Array.of(0x34, 0x12, 0xcc, 0xff);

    expect(parseCompanionUiAudioChunk(encodeCompanionUiAudioChunk(7, pcm))).toEqual({
      sequence: 7,
      pcm,
    });
  });

  it('accepts only exact start and stop control frames', () => {
    expect(parseCompanionUiAudioControlFrame(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-stream-1',
    }))).toEqual({ schemaVersion: 1, type: 'audio.start', requestId: 'z02-stream-1' });
    expect(parseCompanionUiAudioControlFrame(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.stop',
      requestId: 'z02-stream-1',
    }))).toEqual({ schemaVersion: 1, type: 'audio.stop', requestId: 'z02-stream-1' });

    for (const frame of [
      { schemaVersion: 1, type: 'audio.start', requestId: 'z02-stream-1', deviceId: 'browser-device' },
      { schemaVersion: 1, type: 'audio.start', requestId: 'z02-stream-1', sessionId: 'browser-session' },
      { schemaVersion: 1, type: 'audio.start', requestId: 'z02-stream-1', channelId: 'browser-channel' },
      { schemaVersion: 1, type: 'audio.start', requestId: '../other' },
      { schemaVersion: 1, type: 'audio.pause', requestId: 'z02-stream-1' },
    ]) {
      expect(() => parseCompanionUiAudioControlFrame(JSON.stringify(frame)))
        .toThrow(CompanionUiAudioProtocolError);
    }
  });

  it('rejects malformed, empty, and non-PCM16 binary chunks', () => {
    expect(() => encodeCompanionUiAudioChunk(0, Uint8Array.of(1)))
      .toThrow(CompanionUiAudioProtocolError);
    expect(() => parseCompanionUiAudioChunk(Uint8Array.of(0x50, 0x53, 0x5a, 0x41)))
      .toThrow(CompanionUiAudioProtocolError);
    const malformed = encodeCompanionUiAudioChunk(0, Uint8Array.of(0, 0));
    malformed[0] = 0;
    expect(() => parseCompanionUiAudioChunk(malformed)).toThrow(CompanionUiAudioProtocolError);
  });

  it('parses only correlated server acknowledgements', () => {
    expect(parseCompanionUiAudioServerFrame({
      schemaVersion: 1,
      type: 'audio.ready',
      requestId: 'z02-stream-1',
    })).toEqual({ schemaVersion: 1, type: 'audio.ready', requestId: 'z02-stream-1' });
    expect(parseCompanionUiAudioServerFrame({
      schemaVersion: 1,
      type: 'audio.ack',
      requestId: 'z02-stream-1',
      sequence: 9,
    })).toEqual({
      schemaVersion: 1,
      type: 'audio.ack',
      requestId: 'z02-stream-1',
      sequence: 9,
    });
    expect(parseCompanionUiAudioServerFrame({
      schemaVersion: 1,
      type: 'audio.stopped',
      requestId: 'z02-stream-1',
    })).toEqual({ schemaVersion: 1, type: 'audio.stopped', requestId: 'z02-stream-1' });
    expect(parseCompanionUiAudioServerFrame({
      schemaVersion: 1,
      type: 'audio.ready',
      requestId: 'z02-stream-1',
      deviceId: 'smuggled',
    })).toBeUndefined();
  });
});
