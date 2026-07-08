import { describe, expect, it } from 'vitest';
import {
  buildPromptPlanCachePlan,
  computePromptPlanCachePrefixes,
  createPromptPlanBlock,
  serializePromptPlanSystemPrompt,
  type PromptPlanBlock,
  type PromptPlanVolatility,
} from './prompt-plan.js';
import { PromptCacheTurnRuntime } from './prompt-cache-runtime.js';

function block(id: string, volatility: PromptPlanVolatility, renderedText: string): PromptPlanBlock {
  return createPromptPlanBlock({
    id,
    layer: volatility === 'static' ? 'prompt_stack' : 'runtime',
    volatility,
    producer: 'test',
    renderedText,
  });
}

function makeTurnBlocks(turn: number, staticOverrides: Partial<Record<string, string>> = {}): PromptPlanBlock[] {
  return [
    block('static_prefix', 'static', staticOverrides.static_prefix
      ?? '<character_foundation>You are Purrsephone.</character_foundation>'),
    block('values.core', 'static', staticOverrides['values.core']
      ?? '<values>Individual confidences stay individual.</values>'),
    block('session.orientation', 'session_stable', '<orientation>DM with Alice.</orientation>'),
    block('runtime.context', 'turn', `<runtime_context>turn ${turn}: mood shifts</runtime_context>`),
  ];
}

function makePlan(blocks: PromptPlanBlock[]) {
  return { blocks, cachePlan: buildPromptPlanCachePlan(blocks) };
}

describe('computePromptPlanCachePrefixes', () => {
  it('projects cachePlan boundaries onto byte-exact prefixes of the serialized system prompt', () => {
    const plan = makePlan(makeTurnBlocks(1));
    const prefixes = computePromptPlanCachePrefixes(plan);
    expect(prefixes.ok).toBe(true);
    if (!prefixes.ok) return;
    const full = serializePromptPlanSystemPrompt(plan);
    expect(full.startsWith(prefixes.staticPrefixText)).toBe(true);
    expect(full.startsWith(prefixes.sessionStablePrefixText)).toBe(true);
    expect(prefixes.sessionStablePrefixText.length).toBeGreaterThan(prefixes.staticPrefixText.length);
    expect(prefixes.staticPrefixText).toContain('character_foundation');
    expect(prefixes.staticPrefixText).not.toContain('orientation');
    expect(prefixes.sessionStablePrefixText).toContain('orientation');
    expect(prefixes.sessionStablePrefixText).not.toContain('runtime_context');
  });

  it('handles plans with no static region (custom prompt override turns)', () => {
    const blocks = [
      block('prompt_override', 'turn', 'operator override prompt'),
      block('runtime.context', 'turn', '<runtime_context>x</runtime_context>'),
    ];
    const prefixes = computePromptPlanCachePrefixes(makePlan(blocks));
    expect(prefixes.ok).toBe(true);
    if (!prefixes.ok) return;
    expect(prefixes.staticPrefixText).toBe('');
    expect(prefixes.sessionStablePrefixText).toBe('');
  });
});

describe('PromptCacheTurnRuntime directive holder', () => {
  it('resolves boundaries only for the byte-identical system prompt', () => {
    const runtime = new PromptCacheTurnRuntime();
    const plan = makePlan(makeTurnBlocks(1));
    const prefixes = computePromptPlanCachePrefixes(plan);
    expect(prefixes.ok).toBe(true);
    if (!prefixes.ok) return;
    const systemPrompt = serializePromptPlanSystemPrompt(plan);
    const directive = runtime.registerTurnDirective({
      systemPrompt,
      staticPrefixText: prefixes.staticPrefixText,
      sessionStablePrefixText: prefixes.sessionStablePrefixText,
    });

    expect(runtime.resolveBoundariesFor(systemPrompt)).toEqual(directive.boundaries);
    // Contradiction-retry / guard-mutated prompts get no boundaries.
    expect(runtime.resolveBoundariesFor(`STRENGTHENED\n\n${systemPrompt}`)).toBeUndefined();
    expect(runtime.resolveBoundariesFor('')).toBeUndefined();

    runtime.clearTurnDirective();
    expect(runtime.resolveBoundariesFor(systemPrompt)).toBeUndefined();
  });
});

describe('PromptCacheTurnRuntime prefix stability (AC3)', () => {
  it('keeps the static region hash identical across a ten-turn quiet conversation', () => {
    const runtime = new PromptCacheTurnRuntime();
    const scopeKey = 'dm:alice';
    let previousHash: string | undefined;
    for (let turn = 1; turn <= 10; turn += 1) {
      const result = runtime.checkPrefixStability({
        scopeKey,
        turnId: `turn-${turn}`,
        plan: makePlan(makeTurnBlocks(turn)),
      });
      expect(result.stable).toBe(true);
      expect(result.firstObservation).toBe(turn === 1);
      if (previousHash !== undefined) {
        expect(result.currentStaticHash).toBe(previousHash);
      }
      previousHash = result.currentStaticHash;
    }
  });

  it('flags a deliberately poisoned static block and names the offender', () => {
    const runtime = new PromptCacheTurnRuntime();
    const scopeKey = 'dm:alice';
    for (let turn = 1; turn <= 10; turn += 1) {
      expect(runtime.checkPrefixStability({
        scopeKey,
        turnId: `turn-${turn}`,
        plan: makePlan(makeTurnBlocks(turn)),
      }).stable).toBe(true);
    }

    // Poisoned turn: a turn-volatile variable leaks into a static block.
    const poisoned = runtime.checkPrefixStability({
      scopeKey,
      turnId: 'turn-11',
      plan: makePlan(makeTurnBlocks(11, {
        'values.core': '<values>Individual confidences stay individual. (rendered at turn 11)</values>',
      })),
    });
    expect(poisoned.stable).toBe(false);
    expect(poisoned.previousTurnId).toBe('turn-10');
    expect(poisoned.changedBlocks).toEqual([{ id: 'values.core', change: 'modified' }]);

    // Recovery turn: clean static prefix differs from the poisoned turn once,
    // then stabilizes again.
    const recovered = runtime.checkPrefixStability({
      scopeKey,
      turnId: 'turn-12',
      plan: makePlan(makeTurnBlocks(12)),
    });
    expect(recovered.stable).toBe(false);
    expect(recovered.changedBlocks).toEqual([{ id: 'values.core', change: 'modified' }]);
    expect(runtime.checkPrefixStability({
      scopeKey,
      turnId: 'turn-13',
      plan: makePlan(makeTurnBlocks(13)),
    }).stable).toBe(true);
  });

  it('reports added and removed static blocks', () => {
    const runtime = new PromptCacheTurnRuntime();
    const scopeKey = 'room:townsquare';
    runtime.checkPrefixStability({
      scopeKey,
      turnId: 'turn-1',
      plan: makePlan(makeTurnBlocks(1)),
    });
    const withoutValues = makeTurnBlocks(2).filter(entry => entry.id !== 'values.core');
    withoutValues.splice(1, 0, block('skills.index', 'static', '<skills>index</skills>'));
    const result = runtime.checkPrefixStability({
      scopeKey,
      turnId: 'turn-2',
      plan: makePlan(withoutValues),
    });
    expect(result.stable).toBe(false);
    expect(result.changedBlocks).toEqual(expect.arrayContaining([
      { id: 'skills.index', change: 'added' },
      { id: 'values.core', change: 'removed' },
    ]));
  });

  it('tracks scopes independently', () => {
    const runtime = new PromptCacheTurnRuntime();
    expect(runtime.checkPrefixStability({
      scopeKey: 'dm:alice',
      turnId: 'turn-1',
      plan: makePlan(makeTurnBlocks(1)),
    }).firstObservation).toBe(true);
    expect(runtime.checkPrefixStability({
      scopeKey: 'dm:carol',
      turnId: 'turn-2',
      plan: makePlan(makeTurnBlocks(2)),
    }).firstObservation).toBe(true);
    expect(runtime.checkPrefixStability({
      scopeKey: 'dm:alice',
      turnId: 'turn-3',
      plan: makePlan(makeTurnBlocks(3)),
    }).firstObservation).toBe(false);
  });
});
