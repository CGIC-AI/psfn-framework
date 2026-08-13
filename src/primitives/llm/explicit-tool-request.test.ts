import type { LLMContext } from '../../shared/contracts/runtime.js';
import { describe, expect, it } from 'vitest';
import { resolveExplicitToolChoice } from './explicit-tool-request.js';

function context(messages: LLMContext['messages']): LLMContext {
  return {
    systemPrompt: 'system',
    messages,
    tools: [
      { name: 'north_star', description: 'Direction', inputSchema: { type: 'object' } },
      { name: 'notify', description: 'Notify', inputSchema: { type: 'object' } },
    ],
  };
}

describe('explicit tool request choice', () => {
  it('requires a tool on the first provider step for an explicit active-tool request', () => {
    expect(resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Call north_star to append this decision.' }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBe('required');
  });

  it('does not keep forcing tools after the current user request has a tool result', () => {
    expect(resolveExplicitToolChoice({
      context: context([
        { role: 'user', content: 'Call north_star to append this decision.' },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'north_star',
          content: 'ok',
        },
      ] as LLMContext['messages']),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBeUndefined();
  });

  it('does not constrain ordinary discussion or non-turn inference', () => {
    expect(resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Why is north_star useful?' }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBeUndefined();
    expect(resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Call north_star now.' }]),
      originStage: 'memory.extract',
      modelApi: 'openai-completions',
    })).toBeUndefined();
  });

  it('maps the provider-neutral requirement to APIs that spell it as any', () => {
    expect(resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Use notify to send this.' }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'anthropic-messages',
    })).toBe('any');
  });
});
