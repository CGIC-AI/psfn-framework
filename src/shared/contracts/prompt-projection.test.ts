import { describe, expect, it } from 'vitest';
import type { PromptProjectionPlan, PromptProjectionSnapshot } from './prompt-projection.js';
import {
  deriveProviderWireMessagesForPromptProjection,
  projectTurnSnapshotPrompt,
  renderPromptProjectionAssembledPrompt,
  serializePromptProjectionForProvider,
  serializePromptProjectionSystemPrompt,
} from './prompt-projection.js';

function buildPlan(): PromptProjectionPlan {
  return {
    blocks: [
      {
        id: 'static_prefix',
        layer: 'prompt_stack',
        renderedText: [
          'Static identity.',
          '<current_datetime>stale clock</current_datetime>',
        ].join('\n'),
      },
      {
        id: 'runtime.context',
        layer: 'runtime',
        renderedText: 'Runtime context.',
      },
      {
        id: 'session_context',
        layer: 'provider',
        renderedText: 'Session context.',
      },
      {
        id: 'runtime.current_datetime',
        layer: 'provider',
        renderedText: '<runtime.current_datetime><iso>2026-07-16T12:00:00Z</iso></runtime.current_datetime>',
      },
    ],
    messages: [
      { role: 'system', content: 'folded elsewhere' },
      { role: 'user', content: 'prior user' },
      { role: 'assistant', content: 'prior assistant' },
    ],
    toolDefinitions: [{
      name: 'lookup',
      description: 'Look something up.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
      },
    }],
  };
}

describe('browser-safe prompt projection authority', () => {
  it('serializes blocks and messages in canonical byte order', () => {
    const plan = buildPlan();
    const systemPrompt = [
      'Static identity.',
      'Runtime context.',
      'Session context.',
      '<runtime.current_datetime><iso>2026-07-16T12:00:00Z</iso></runtime.current_datetime>',
    ].join('\n\n');

    expect(renderPromptProjectionAssembledPrompt(plan)).toBe([
      'Static identity.\n<current_datetime>stale clock</current_datetime>',
      'Runtime context.',
    ].join('\n\n'));
    expect(serializePromptProjectionSystemPrompt(plan)).toBe(systemPrompt);
    expect(serializePromptProjectionForProvider(plan, 'openai_developer')).toEqual({
      systemPrompt,
      providerWireMessages: [
        { role: 'developer', source: 'system_prompt', content: systemPrompt },
        { role: 'user', source: 'message', content: 'prior user' },
        {
          role: 'assistant',
          source: 'message',
          content: '[{"type":"text","text":"prior assistant"}]',
        },
      ],
    });
    expect(deriveProviderWireMessagesForPromptProjection({
      plan,
      transport: 'openai_developer',
      currentTurnInput: 'current user',
    })).toEqual([
      { role: 'developer', source: 'system_prompt', content: systemPrompt },
      { role: 'user', source: 'message', content: 'prior user' },
      {
        role: 'assistant',
        source: 'message',
        content: '[{"type":"text","text":"prior assistant"}]',
      },
      { role: 'user', source: 'message', content: 'current user' },
    ]);
  });

  it('derives omitted slim fields, preserves explicit empty fields, and isolates mutations', () => {
    const plan = buildPlan();
    const slim: PromptProjectionSnapshot = {
      plan,
      promptContext: {
        currentTurnInput: 'current user',
        providerObservability: {
          systemRole: { transport: 'anthropic_system' },
        },
      },
      toolContext: {},
    };
    const derived = projectTurnSnapshotPrompt(slim);

    expect(derived.providerMessages.at(-1)).toEqual({
      role: 'user',
      source: 'message',
      content: 'current user',
    });
    expect(derived.activeTools).toEqual(plan.toolDefinitions);
    derived.strings.contextMessages[1]!.content = 'mutated message';
    derived.activeTools[0]!.inputSchema.type = 'mutated';
    expect(plan.messages[1]!.content).toBe('prior user');
    expect(plan.toolDefinitions[0]!.inputSchema.type).toBe('object');

    const explicitEmpty = projectTurnSnapshotPrompt({
      ...slim,
      promptContext: {
        ...slim.promptContext,
        providerObservability: {
          systemRole: { transport: 'anthropic_system' },
          providerWireMessages: [],
        },
      },
      toolContext: { activeTools: [] },
    });
    expect(explicitEmpty.providerMessages).toEqual([]);
    expect(explicitEmpty.activeTools).toEqual([]);
    expect(explicitEmpty.providerWire.source).toBe('prompt_plan');
    expect(explicitEmpty.providerWire.messages.length).toBeGreaterThan(0);
  });

  it('fails closed when a canonical plan has no resolved tool definitions', () => {
    const plan = buildPlan() as PromptProjectionPlan & { toolDefinitionsRef?: string };
    delete (plan as Partial<PromptProjectionPlan>).toolDefinitions;
    plan.toolDefinitionsRef = 'tools-ref-1';

    expect(() => projectTurnSnapshotPrompt({
      plan,
      promptContext: {
        providerObservability: {
          systemRole: { transport: 'openai_system' },
        },
      },
    })).toThrow('unresolved toolDefinitionsRef "tools-ref-1"');
  });
});
