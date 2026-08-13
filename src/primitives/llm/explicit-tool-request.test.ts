import type { LLMContext } from '../../shared/contracts/runtime.js';
import { describe, expect, it } from 'vitest';
import {
  assertExplicitToolContractSatisfied,
  resolveExplicitToolChoice,
  selectExplicitToolContractCall,
} from './explicit-tool-request.js';

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

  it('forbids extra tool calls after a single requested tool has a result', () => {
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
    })).toBe('none');
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

  it('treats an instruction to attempt a named tool as an explicit request', () => {
    expect(resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Attempt notify exactly once.' }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBe('required');
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
    })).toBe('required');
  });

  it('retains repeated named-tool steps and forbids calls after the sequence', () => {
    const request = 'Call north_star to create the item. Then call north_star to update it.';
    const firstResult = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'north_star',
      content: 'created',
    };
    expect(resolveExplicitToolChoice({
      context: context([
        { role: 'user', content: request },
        firstResult,
      ] as LLMContext['messages']),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBe('required');

    expect(resolveExplicitToolChoice({
      context: context([
        { role: 'user', content: request },
        firstResult,
        {
          role: 'toolResult',
          toolCallId: 'call-2',
          toolName: 'north_star',
          content: 'updated',
        },
      ] as LLMContext['messages']),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBe('none');
  });

  it('expands an exact-twice quantifier into two required calls', () => {
    const request = 'Use notify to inspect state. Then call north_star with this item exactly twice.';
    const notifyResult = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'notify',
      content: 'inspected',
    };
    const firstNorthStarResult = {
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'north_star',
      content: 'first',
    };
    expect(resolveExplicitToolChoice({
      context: context([
        { role: 'user', content: request },
        notifyResult,
        firstNorthStarResult,
      ] as LLMContext['messages']),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBe('required');

    expect(resolveExplicitToolChoice({
      context: context([
        { role: 'user', content: request },
        notifyResult,
        firstNorthStarResult,
        {
          role: 'toolResult',
          toolCallId: 'call-3',
          toolName: 'north_star',
          content: 'second',
        },
      ] as LLMContext['messages']),
      originStage: 'agent.turn.prompt',
      modelApi: 'openai-completions',
    })).toBe('none');
  });

  it('does not turn a negated tool prohibition into a requested sequence step', () => {
    const request = 'Call north_star to append this. Do not call notify or any unrelated tool.';
    expect(resolveExplicitToolChoice({
      context: context([{ role: 'user', content: request }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'pi-messages',
    })).toEqual({ type: 'function', function: { name: 'north_star' } });
    expect(resolveExplicitToolChoice({
      context: context([
        { role: 'user', content: request },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'north_star',
          content: 'ok',
        },
      ] as LLMContext['messages']),
      originStage: 'agent.turn.prompt',
      modelApi: 'pi-messages',
    })).toBe('none');

    for (const prohibited of ["Don't call notify.", 'Never invoke notify.']) {
      expect(resolveExplicitToolChoice({
        context: context([{ role: 'user', content: `Call north_star. ${prohibited}` }]),
        originStage: 'agent.turn.prompt',
        modelApi: 'pi-messages',
      })).toEqual({ type: 'function', function: { name: 'north_star' } });
    }
  });

  it('rejects an unsupported provider API when an explicit request must be enforced', () => {
    expect(() => resolveExplicitToolChoice({
      context: context([{ role: 'user', content: 'Call north_star now.' }]),
      originStage: 'agent.turn.prompt',
      modelApi: 'custom-provider-api',
    })).toThrow('cannot enforce explicit tool execution for unsupported model API');
  });

  it('rejects zero, unrelated, or parallel calls for a required exact tool', () => {
    expect(() => assertExplicitToolContractSatisfied({
      choice: 'required',
      requiredToolName: 'notify',
      toolCalls: [],
    })).toThrow('expected exactly one "notify" call');
    expect(() => assertExplicitToolContractSatisfied({
      choice: 'required',
      requiredToolName: 'notify',
      toolCalls: [{ name: 'north_star' }],
    })).toThrow('received ["north_star"]');
    expect(() => assertExplicitToolContractSatisfied({
      choice: 'required',
      requiredToolName: 'notify',
      toolCalls: [{ name: 'notify' }, { name: 'notify' }],
    })).toThrow('received ["notify","notify"]');
    expect(() => assertExplicitToolContractSatisfied({
      choice: 'required',
      requiredToolName: 'notify',
      toolCalls: [{ name: 'notify' }],
    })).not.toThrow();
  });

  it('selects only the first exact call when a provider fans out one exposed tool', () => {
    const calls = [
      { id: 'notify-1', name: 'notify' },
      { id: 'notify-2', name: 'notify' },
    ];
    expect(selectExplicitToolContractCall({
      choice: 'required',
      requiredToolName: 'notify',
      toolCalls: calls,
    })).toEqual([calls[0]]);
    expect(() => selectExplicitToolContractCall({
      choice: 'required',
      requiredToolName: 'notify',
      toolCalls: [{ id: 'notify-1', name: 'notify' }, { id: 'other-1', name: 'north_star' }],
    })).toThrow('received ["notify","north_star"]');
    expect(() => selectExplicitToolContractCall({
      choice: 'required',
      requiredToolName: 'notify',
      toolCalls: [],
    })).toThrow('expected exactly one "notify" call');
  });

  it('rejects any tool call after the requested sequence is complete', () => {
    expect(() => assertExplicitToolContractSatisfied({
      choice: 'none',
      toolCalls: [{ name: 'notify' }],
    })).toThrow('after tool execution was disabled');
  });
});
