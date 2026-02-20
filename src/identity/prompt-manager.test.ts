import { describe, expect, it } from 'vitest';
import { PromptManager } from './prompt-manager.js';
import type { PromptLayer } from './prompt-types.js';

function makeLayer(params: {
  id: string;
  type?: PromptLayer['type'];
  content: string;
  identifier?: string;
  priority?: number;
}): PromptLayer {
  return {
    id: params.id,
    type: params.type ?? 'runtime',
    name: params.id,
    content: params.content,
    identifier: params.identifier,
    enabled: true,
    priority: params.priority ?? 0,
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
    checksum: 'checksum',
    version: 1,
  };
}

describe('PromptManager', () => {
  it('preserves legacy composition for layers without identifiers', () => {
    const manager = new PromptManager();
    const result = manager.compose([
      makeLayer({ id: 'base-1', type: 'base', content: 'BASE' }),
      makeLayer({ id: 'runtime-1', type: 'runtime', content: 'RUNTIME' }),
    ]);

    expect(result.text).toBe('BASE\n\nRUNTIME');
    expect(result.prompts.map(prompt => prompt.identifier)).toEqual(['main', 'layer:runtime-1']);
  });

  it('auto-heals missing required main prompt when explicit identifiers are used', () => {
    const manager = new PromptManager();
    const result = manager.compose([
      makeLayer({
        id: 'scenario-1',
        identifier: 'scenario',
        content: 'Scenario: {{user}} is in the workshop.',
      }),
    ]);

    expect(result.text).toContain('You are {{char}}.');
    expect(result.text).toContain('Scenario: {{user}} is in the workshop.');
    expect(result.autoHealedIdentifiers).toContain('main');
  });

  it('orders required prompt identifiers deterministically', () => {
    const manager = new PromptManager();
    const result = manager.compose([
      makeLayer({ id: 'scenario-1', identifier: 'scenario', content: 'SCENARIO' }),
      makeLayer({ id: 'main-1', identifier: 'main', content: 'MAIN' }),
      makeLayer({ id: 'personality-1', identifier: 'charPersonality', content: 'PERSONALITY' }),
    ]);

    const parts = result.text.split('\n\n');
    expect(parts[0]).toBe('MAIN');
    expect(parts[1]).toBe('PERSONALITY');
    expect(parts[2]).toBe('SCENARIO');
  });

  it('maps known identifier aliases to canonical prompt identifiers', () => {
    const manager = new PromptManager();
    const result = manager.compose([
      makeLayer({ id: 'main-1', identifier: 'main_prompt', content: 'MAIN' }),
      makeLayer({ id: 'examples-1', identifier: 'mes_example', content: 'EXAMPLES' }),
    ]);

    expect(result.prompts.map(prompt => prompt.identifier)).toContain('main');
    expect(result.prompts.map(prompt => prompt.identifier)).toContain('dialogueExamples');
  });
});
