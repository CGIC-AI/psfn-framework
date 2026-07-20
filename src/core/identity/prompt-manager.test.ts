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
  it('fails closed when a base layer has no identifier', () => {
    const manager = new PromptManager();

    expect(() => manager.compose([
      makeLayer({ id: 'base-1', type: 'base', content: 'BASE' }),
    ])).toThrow(
      'Prompt layer "base-1" (record id "base-1", type "base") is missing required identifier. '
      + 'Run `npm run migrate:prompt-layer-identifiers -- --apply` against '
      + 'companion-data/state/prompt-layers.json before starting the runtime.',
    );
  });

  it('preserves the old legacy-main composition byte-for-byte after backfill', () => {
    const manager = new PromptManager();
    const result = manager.compose([
      makeLayer({ id: 'base-1', type: 'base', identifier: 'main', content: 'BASE' }),
      makeLayer({ id: 'runtime-1', type: 'runtime', content: 'RUNTIME' }),
    ]);

    // Captured from the pre-backfill coercion path over the same fixture.
    expect(result.text).toBe('BASE\n\nRUNTIME');
    expect(result.prompts.map(prompt => ({
      content: prompt.content,
      identifier: prompt.identifier,
      sourceLayerId: prompt.sourceLayerId,
    }))).toEqual([
      { content: 'BASE', identifier: 'main', sourceLayerId: 'base-1' },
      { content: 'RUNTIME', identifier: 'layer:runtime-1', sourceLayerId: 'runtime-1' },
    ]);
    expect(result.autoHealedIdentifiers).toEqual([
      'charDescription',
      'charPersonality',
      'scenario',
      'dialogueExamples',
      'postHistoryInstructions',
    ]);
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
