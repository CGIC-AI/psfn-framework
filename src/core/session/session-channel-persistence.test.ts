import { describe, expect, it } from 'vitest';
import { shouldPersistSessionChannel } from './session-channel-persistence.js';

describe('shouldPersistSessionChannel', () => {
  it('never persists reflection or per-contact social-outreach channels', () => {
    expect(shouldPersistSessionChannel('internal:reflection:evening')).toBe(false);
    expect(shouldPersistSessionChannel('internal:social-outreach:contact-1')).toBe(false);
    expect(shouldPersistSessionChannel('internal:heartbeat')).toBe(true);
    expect(shouldPersistSessionChannel('123456789012345678')).toBe(true);
  });
});
