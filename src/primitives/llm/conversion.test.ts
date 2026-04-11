import { describe, expect, it, vi } from 'vitest';
import {
  extractReasoningContent,
  extractTextContent,
  toPiContext,
  toPiMessages,
  toPiTools,
} from './conversion.js';

describe('llm conversion helpers', () => {
  it('extracts text and reasoning blocks', () => {
    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: ' world' },
    ];

    expect(extractTextContent(blocks)).toBe('hello world');
    expect(extractReasoningContent(blocks)).toBe('hmm');
  });

  it('converts context to pi context with tools', () => {
    const context = toPiContext({
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
      ],
      tools: [
        {
          name: 'tool_a',
          description: 'Tool A',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(context.systemPrompt).toBe('system');
    expect(context.messages).toHaveLength(2);
    expect(context.tools).toHaveLength(1);
    expect((context.messages[0] as any).role).toBe('user');
    expect((context.messages[1] as any).role).toBe('assistant');
  });

  it('toPiMessages keeps order and toPiTools maps schema fields', () => {
    const messages = toPiMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);
    const tools = toPiTools([
      { name: 'x', description: 'desc', inputSchema: { type: 'object' } },
    ]);

    expect((messages[0] as any).content).toBe('first');
    expect((messages[1] as any).content[0].text).toBe('second');
    expect(tools[0].name).toBe('x');
    expect((tools[0] as any).parameters).toEqual({ type: 'object' });
  });

  it('toPiMessages keeps a fixed timestamp across converted messages', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(4242);

    const messages = toPiMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ]);

    expect((messages[0] as any).timestamp).toBe(4242);
    expect((messages[1] as any).timestamp).toBe(4242);
    expect(nowSpy).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it('moves system context into the pi system prompt instead of chat history', () => {
    const context = toPiContext({
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: '[SYSTEM: Scheduler] Keep tomorrow afternoon in view.' },
        { role: 'assistant', content: 'a1' },
      ],
    });

    expect(context.systemPrompt).toBe([
      'system',
      '<session_context>',
      '[SYSTEM: Scheduler] Keep tomorrow afternoon in view.',
      '</session_context>',
    ].join('\n\n'));
    expect(context.messages).toHaveLength(2);
    expect((context.messages[0] as any).role).toBe('user');
    expect((context.messages[1] as any).role).toBe('assistant');
  });
});
