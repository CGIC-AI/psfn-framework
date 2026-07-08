import { describe, expect, it } from 'vitest';
import { extractExplicitPreferenceFactsFromEntries } from './preference.js';

describe('extractExplicitPreferenceFactsFromEntries', () => {
  it('extracts first-person favorite statements as durable preference facts', () => {
    const facts = extractExplicitPreferenceFactsFromEntries([
      {
        id: 42,
        channelId: 'api:test',
        role: 'user',
        content: 'Please remember that my favorite color is teal.',
        timestamp: 1,
        authorName: 'Vega',
      },
    ]);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      text: "Vega's favorite color is teal.",
      type: 'semantic',
      retentionClass: 'durable',
      tags: ['preference', 'favorite', 'preference:color'],
      attribution: {
        sourceMessageIds: [42],
        sourceSpanStartMessageId: 42,
        sourceSpanEndMessageId: 42,
        sourceSpeakerName: 'Vega',
        subjectName: 'Vega',
        addressMode: 'direct_to_companion',
      },
    });
  });

  it('ignores questions and non-user turns', () => {
    const facts = extractExplicitPreferenceFactsFromEntries([
      {
        id: 1,
        channelId: 'api:test',
        role: 'user',
        content: 'Do you remember my favorite color?',
        timestamp: 1,
      },
      {
        id: 2,
        channelId: 'api:test',
        role: 'assistant',
        content: 'My favorite color is green.',
        timestamp: 2,
      },
    ]);

    expect(facts).toEqual([]);
  });
});
