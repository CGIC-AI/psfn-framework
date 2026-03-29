import { describe, expect, it } from 'vitest';
import { formatExtractionTranscript } from './chunk-compose.js';
import type { SessionEntry } from '../../session/types.js';

function makeEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    id: 1,
    channelId: 'api:test',
    role: 'user',
    content: 'default',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('formatExtractionTranscript', () => {
  it('keeps system and tool entries out of the user lane', () => {
    const transcript = formatExtractionTranscript([
      makeEntry({
        role: 'system',
        content: 'Agent performed self-check.',
      }),
      makeEntry({
        id: 2,
        role: 'tool',
        content: '[Tool result: search_logs] Found 3 matching log entries.',
      }),
      makeEntry({
        id: 3,
        role: 'assistant',
        content: 'I found the relevant logs.',
        authorName: 'Lyra',
      }),
    ], {
      userName: 'Alex',
    });

    expect(transcript).toContain('system: Agent performed self-check.');
    expect(transcript).toContain('tool: [Tool result: search_logs] Found 3 matching log entries.');
    expect(transcript).toContain('Lyra: I found the relevant logs.');
    expect(transcript).not.toContain('Alex: Agent performed self-check.');
    expect(transcript).not.toContain('Alex: [Tool result: search_logs]');
  });
});
