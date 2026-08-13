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
    })).toEqual({ type: 'function', function: { name: 'north_star' } });
  });

  it('does not keep forcing a single requested tool after it has a result', () => {
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

  it('selects the exact requested tool for the pi messages API', () => {
    expect(resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Use notify to send this.' }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'pi-messages',
    })).toEqual({ type: 'function', function: { name: 'notify' } });
  });

  it('forces each requested tool in order across provider steps', () => {
    expect(resolveExplicitToolChoice({
      context: context([
        { role: 'user', content: 'Call north_star, then invoke notify.' },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'north_star',
          content: 'ok',
        },
      ] as LLMContext['messages']),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toEqual({ type: 'function', function: { name: 'notify' } });
  });

  it('rejects an unsupported provider API when an explicit request must be enforced', () => {
    expect(() => resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Call north_star now.' }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'custom-provider-api',
    })).toThrow('cannot enforce explicit tool execution for unsupported model API');
  });
});
