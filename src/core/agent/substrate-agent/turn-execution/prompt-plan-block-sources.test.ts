// ── Provider-inertness of per-block source identity (psfn-framework-ccgdz.4) ──
//
// `PromptPlanBlock.sources` records WHICH identified sources a block rendered.
// The whole change is only safe if it cannot move a prompt byte or a cache
// breakpoint. Serialization reads `renderedText` and the cache plan reads
// `volatility`, so that holds by construction — these tests prove it directly
// rather than trusting the reading.

import { describe, expect, it } from 'vitest';
import {
  buildPromptPlanCachePlan,
  clonePromptPlanBlock,
  computePromptPlanCachePrefixes,
  createPromptPlanBlock,
  serializePromptPlanForProvider,
  serializePromptPlanSystemPrompt,
  type PromptPlanBlock,
} from './prompt-plan.js';

const SOURCES = [
  { kind: 'memory', refId: 'mem-1' },
  {
    kind: 'intake_envelope',
    refId: 'env_01JZ0000000000000000000001',
    envelopeId: 'env_01JZ0000000000000000000001',
    receiptId: 'rcpt_01JZ0000000000000000000001',
  },
  { kind: 'wiki', refId: 'doc-1', contentSha256: 'd'.repeat(64) },
];

function blocks(withSources: boolean): PromptPlanBlock[] {
  return [
    createPromptPlanBlock({
      id: 'static_prefix',
      layer: 'prompt_stack',
      volatility: 'static',
      producer: 'identity.prompt-composer',
      renderedText: 'You are a companion.',
    }),
    createPromptPlanBlock({
      id: 'cogsec.canary',
      layer: 'prompt_stack',
      volatility: 'session_stable',
      producer: 'cogsec.canary',
      renderedText: '<canary>abc</canary>',
    }),
    createPromptPlanBlock({
      id: 'memory.retrieval',
      layer: 'session',
      volatility: 'turn',
      producer: 'session.context-builder',
      renderedText: '<memories>\n- the partner prefers oat milk\n</memories>',
      ...(withSources ? { sources: SOURCES } : {}),
    }),
  ];
}

describe('PromptPlanBlock.sources', () => {
  it('leaves the provider payload byte-identical', () => {
    const without = { blocks: blocks(false), messages: [] };
    const with_ = { blocks: blocks(true), messages: [] };
    expect(serializePromptPlanSystemPrompt(with_))
      .toBe(serializePromptPlanSystemPrompt(without));
    expect(serializePromptPlanForProvider(with_, 'system_parameter'))
      .toEqual(serializePromptPlanForProvider(without, 'system_parameter'));
  });

  it('leaves the cache plan and cache prefixes unchanged', () => {
    const without = blocks(false);
    const withSources = blocks(true);
    const cachePlan = buildPromptPlanCachePlan(without);
    expect(buildPromptPlanCachePlan(withSources)).toEqual(cachePlan);
    expect(computePromptPlanCachePrefixes({ blocks: withSources, cachePlan }))
      .toEqual(computePromptPlanCachePrefixes({ blocks: without, cachePlan }));
  });

  it('leaves the token estimate unchanged', () => {
    expect(blocks(true).map(block => block.tokensEst))
      .toEqual(blocks(false).map(block => block.tokensEst));
  });

  it('omits the field entirely when a block rendered no identified source', () => {
    const block = createPromptPlanBlock({
      id: 'dynamic_suffix',
      layer: 'prompt_stack',
      volatility: 'turn',
      producer: 'identity.prompt-runtime',
      renderedText: 'suffix',
      sources: [],
    });
    expect(block.sources).toBeUndefined();
  });

  it('clones the sources array so custody evidence never aliases the live plan', () => {
    const original = blocks(true)[2]!;
    const cloned = clonePromptPlanBlock(original);
    expect(cloned.sources).toEqual(original.sources);
    expect(cloned.sources).not.toBe(original.sources);
    expect(cloned.sources?.[0]).not.toBe(original.sources?.[0]);
  });
});
