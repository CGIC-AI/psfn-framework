import type { AgentMessage } from '../../../../boundary/pi-agent/index.js';
import type { UserMessage } from '@mariozechner/pi-ai';
import { describe, expect, it } from 'vitest';
import { MESSAGE_CLASSES } from '../../message-classes.js';
import type { SystemNoteMessage } from '../../messages.js';
import { rebuildProviderWireMessagesForPrompt } from './prompt-invocation-history.js';

function userMessage(content: UserMessage['content'], timestamp: number): UserMessage {
  return { role: 'user', content, timestamp };
}

describe('rebuildProviderWireMessagesForPrompt', () => {
  it('records prior history and the separately supplied current input exactly once', () => {
    const history: AgentMessage[] = [userMessage('earlier input', 1)];

    expect(rebuildProviderWireMessagesForPrompt(
      [{ role: 'system', source: 'system_prompt', content: 'system prompt' }],
      history,
      userMessage('current input', 2),
    )).toEqual([
      { role: 'system', source: 'system_prompt', content: 'system prompt' },
      { role: 'user', source: 'message', content: 'earlier input' },
      { role: 'user', source: 'message', content: 'current input' },
    ]);
  });

  it('redacts inline image bytes from durable provider observability', () => {
    const rawImageBytes = 'sensitive-base64-image-payload';
    const messages = rebuildProviderWireMessagesForPrompt(
      [],
      [],
      userMessage([
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/png', data: rawImageBytes },
      ], 2),
    );

    expect(messages).toEqual([{
      role: 'user',
      source: 'message',
      content: JSON.stringify([
        { type: 'text', text: 'look at this' },
        { type: 'image', mimeType: 'image/png', data: '[omitted]' },
      ]),
    }]);
    expect(JSON.stringify(messages)).not.toContain(rawImageBytes);
  });

  it('shows the canonical assistant-side conversion of a current system note', () => {
    const currentSystemNote: SystemNoteMessage = {
      role: 'custom',
      type: 'systemNote',
      messageClass: MESSAGE_CLASSES.systemNote,
      content: '[SYSTEM: Scheduler] heartbeat run',
      timestamp: 2,
    };

    expect(rebuildProviderWireMessagesForPrompt([], [], currentSystemNote)).toEqual([
      {
        role: 'assistant',
        source: 'message',
        content: expect.stringContaining('[System note] [SYSTEM: Scheduler] heartbeat run'),
      },
    ]);
  });
});
