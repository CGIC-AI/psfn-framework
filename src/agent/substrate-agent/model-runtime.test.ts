import { describe, expect, it } from 'vitest';
import { resolveTurnModelPurpose } from './model-runtime.js';

function makeMessage(channelId: string) {
  return {
    channelId,
  } as const;
}

describe('resolveTurnModelPurpose', () => {
  it('routes internal heartbeat and reflection turns through the memory model purpose', () => {
    expect(resolveTurnModelPurpose(makeMessage('internal:heartbeat'))).toBe('memory');
    expect(resolveTurnModelPurpose(makeMessage('internal:heartbeat:daily'))).toBe('memory');
    expect(resolveTurnModelPurpose(makeMessage('internal:reflection:whisper'))).toBe('memory');
  });

  it('keeps ordinary turns on the chat purpose', () => {
    expect(resolveTurnModelPurpose(makeMessage('discord:general'))).toBe('chat');
  });
});
