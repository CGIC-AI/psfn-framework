import { describe, expect, it } from 'vitest';

import { MESSAGE_CLASSES } from './message-classes.js';
import { convertToLlm, sessionEntryToMessage } from './messages.js';

describe('letter message ontology', () => {
  it.each([
    ['assistant', 'companion'],
    ['user', 'partner'],
  ] as const)('classifies %s-authored letter L0 entries without treating them as outward speech', (role, author) => {
    const message = sessionEntryToMessage({
      id: 1,
      channelId: 'letters:bin',
      role,
      content: 'An unhurried letter.',
      timestamp: 100,
      metadata: JSON.stringify({
        type: 'letter', schemaVersion: 1, event: 'composed',
        letterId: '11111111-1111-4111-8111-111111111111',
        author, recipient: author === 'companion' ? 'partner' : 'companion', subject: 'Hello',
      }),
    });

    expect(message).toMatchObject({ role, messageClass: MESSAGE_CLASSES.letter });
    expect(convertToLlm([message])[0]).toMatchObject({ messageClass: MESSAGE_CLASSES.letter });
  });
});
