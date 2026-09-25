import { describe, expect, it } from 'vitest';
import type { PromptLayer } from '../identity/prompt-types.js';
import { renderAppraiserOperatorGuidance, selectAppraiserOperatorGuidance } from './operator-guidance.js';
import { TEMPORAL_RULES_LAYER_CONTENT, TEMPORAL_RULES_LAYER_IDENTIFIER } from '../identity/temporal-rules-layer.js';

function layer(overrides: Partial<PromptLayer>): PromptLayer {
  return {
    id: 'layer',
    type: 'operator',
    name: 'layer',
    content: 'guidance',
    enabled: true,
    priority: 0,
    updatedAt: '2026-09-25T00:00:00.000Z',
    updatedBy: 'admin',
    checksum: 'abc',
    version: 1,
    ...overrides,
  };
}

describe('selectAppraiserOperatorGuidance (9iooo)', () => {
  it('keeps only enabled, unscoped, non-empty operator layers in stack order', () => {
    expect(selectAppraiserOperatorGuidance([
      layer({ id: 'b', name: 'second', content: 'two', priority: 2 }),
      layer({ id: 'a', name: 'first', content: ' one ', priority: 1 }),
      layer({ id: 'off', enabled: false }),
      layer({ id: 'empty', content: '   ' }),
      layer({ id: 'scoped', channelType: 'discord_text' }),
      layer({ id: 'task', taskKind: 'reflection' }),
      layer({ id: 'base', type: 'base', content: 'the whole character card' }),
    ])).toEqual([
      { name: 'first', content: 'one' },
      { name: 'second', content: 'two' },
    ]);
  });
});

describe('appraiser operator guidance budget (8huns)', () => {
  const briefing = `<tester_briefing author="operator">${'Reply when addressed. '.repeat(55)}Declining is allowed; say why. Report friction.</tester_briefing>`;

  it('leaves the seeded temporal rules layer out so the operator briefing fits whole', () => {
    const guidance = selectAppraiserOperatorGuidance([
      layer({
        id: 'temporal',
        identifier: TEMPORAL_RULES_LAYER_IDENTIFIER,
        name: 'Temporal Grounding Rules',
        content: TEMPORAL_RULES_LAYER_CONTENT,
        priority: 990,
        updatedBy: 'system',
      }),
      layer({ id: 'seeded', name: 'seeded default', content: 'runtime-maintained', priority: 5, updatedBy: 'system:runtime-layer-seed' }),
      layer({ id: 'briefing', name: 'Tester Briefing', content: briefing, priority: 991, updatedBy: 'operator:setup' }),
    ]);
    expect(guidance.map(item => item.name)).toEqual(['Tester Briefing']);

    const rendered = renderAppraiserOperatorGuidance(guidance, 2000);
    expect(rendered).toContain('Declining is allowed; say why. Report friction.</tester_briefing>');
    expect(rendered).not.toContain('truncated');
  });

  it('marks truncation explicitly with how much was cut', () => {
    const rendered = renderAppraiserOperatorGuidance([{ name: 'Long', content: 'x'.repeat(300) }], 100);
    expect(rendered).toMatch(/\[operator guidance truncated: \d+ of \d+ characters not shown\]$/);
  });

  it('keeps an operator-edited temporal layer out too: it grounds replies, not reply decisions', () => {
    expect(selectAppraiserOperatorGuidance([
      layer({ id: 'temporal', identifier: TEMPORAL_RULES_LAYER_IDENTIFIER, content: 'edited', updatedBy: 'admin' }),
    ])).toEqual([]);
  });
});
