import { describe, expect, it } from 'vitest';
import { HookMatcher, HookRegistry } from './hook-registry.js';
import {
  buildRedactedPreToolAudit,
  createPreToolHookGate,
  normalizePreToolResult,
  type PreToolUseHookContext,
  type PreToolUseHookHandler,
} from './pre-tool-hook.js';
import { resolveToolAliasMatchers } from '../../core/agent/tool-surface/registry.js';

function contextFor(
  toolName: string,
  input: unknown,
  aliases: readonly string[] = [],
): PreToolUseHookContext {
  return {
    toolName,
    aliases,
    input,
    capabilityTier: 'autonomous',
    sessionId: 'session-1',
    turnId: 'turn-1',
    channelId: 'channel-1',
  };
}

function registerSync(
  registry: HookRegistry,
  name: string,
  patterns: readonly string[],
  handler: PreToolUseHookHandler,
): void {
  registry.register({
    mode: 'sync_decision',
    name,
    sourcePath: 'test',
    matcher: new HookMatcher([...patterns]),
    handler,
  });
}

describe('normalizePreToolResult (decision contract, fail-closed)', () => {
  it('treats no-opinion returns as a permissive allow', () => {
    for (const raw of [undefined, null]) {
      expect(normalizePreToolResult(raw)).toEqual({ block: false, hasModifiedInput: false });
    }
    expect(normalizePreToolResult({})).toEqual({ block: false, hasModifiedInput: false });
    expect(normalizePreToolResult({ decision: 'allow' })).toMatchObject({ block: false });
    expect(normalizePreToolResult({ decision: 'approve' })).toMatchObject({ block: false });
  });

  it('blocks on explicit block/deny and preserves the reason', () => {
    expect(normalizePreToolResult({ decision: 'block', reason: 'unsafe rm' }))
      .toEqual({ block: true, reason: 'unsafe rm', hasModifiedInput: false });
    expect(normalizePreToolResult({ decision: 'deny', reason: '  spaced  ' }))
      .toMatchObject({ block: true, reason: 'spaced' });
    // Block without a reason still blocks (fail-closed) with a generic reason.
    expect(normalizePreToolResult({ decision: 'block' }))
      .toMatchObject({ block: true, reason: 'blocked by a pre_tool_use hook' });
  });

  it('blocks fail-closed on malformed decisions', () => {
    expect(normalizePreToolResult('block').block).toBe(true);
    expect(normalizePreToolResult(42).block).toBe(true);
    expect(normalizePreToolResult(true).block).toBe(true);
    expect(normalizePreToolResult({ decision: 'maybe' }).block).toBe(true);
    // additionalContext must be a string, or the call blocks.
    expect(normalizePreToolResult({ additionalContext: { note: 'x' } }).block).toBe(true);
  });

  it('surfaces modify and augment decisions', () => {
    expect(normalizePreToolResult({ modifiedInput: { command: 'ls' } }))
      .toEqual({ block: false, hasModifiedInput: true, modifiedInput: { command: 'ls' } });
    expect(normalizePreToolResult({ additionalContext: 'remember the policy' }))
      .toEqual({ block: false, hasModifiedInput: false, additionalContext: 'remember the policy' });
    // Empty/whitespace context is ignored (treated as no augmentation).
    expect(normalizePreToolResult({ additionalContext: '   ' }))
      .toEqual({ block: false, hasModifiedInput: false });
    // modify + augment can co-occur.
    expect(normalizePreToolResult({ modifiedInput: { a: 1 }, additionalContext: 'note' }))
      .toMatchObject({ hasModifiedInput: true, additionalContext: 'note' });
  });
});

describe('HookRegistry.evaluatePreToolUse matcher selection', () => {
  it('matches tool names and dotted wildcards for shell, web.fetch, fs, analysis_workbench', async () => {
    const registry = new HookRegistry();
    const seen: string[] = [];
    registerSync(registry, 'shell-watch', ['shell'], (ctx) => { seen.push(ctx.toolName); });
    registerSync(registry, 'web-watch', ['web.*'], (ctx) => { seen.push(ctx.toolName); });
    registerSync(registry, 'fs-watch', ['fs'], (ctx) => { seen.push(ctx.toolName); });
    registerSync(registry, 'workbench-watch', ['analysis_workbench'], (ctx) => { seen.push(ctx.toolName); });

    expect((await registry.evaluatePreToolUse(contextFor('shell', {}))).matchedHookCount).toBe(1);
    expect((await registry.evaluatePreToolUse(contextFor('web.fetch', {}))).matchedHookCount).toBe(1);
    expect((await registry.evaluatePreToolUse(contextFor('fs', {}))).matchedHookCount).toBe(1);
    expect((await registry.evaluatePreToolUse(contextFor('analysis_workbench', {}))).matchedHookCount).toBe(1);
    // A non-matching tool selects nothing and allows fast.
    const none = await registry.evaluatePreToolUse(contextFor('memory', {}));
    expect(none.matchedHookCount).toBe(0);
    expect(none.outcome).toBe('allow');
    expect(seen).toEqual(['shell', 'web.fetch', 'fs', 'analysis_workbench']);
  });

  it('matches on aliases as well as the primary tool name', async () => {
    const registry = new HookRegistry();
    registerSync(registry, 'alias-watch', ['legacy_web_fetch'], () => ({ decision: 'block', reason: 'no' }));
    const decision = await registry.evaluatePreToolUse(
      contextFor('web.fetch', {}, ['legacy_web_fetch']),
    );
    expect(decision.outcome).toBe('block');
    expect(decision.blockingHook).toBe('alias-watch');
  });

  it('hasSyncDecisionHooks reflects registration', () => {
    const registry = new HookRegistry();
    expect(registry.hasSyncDecisionHooks()).toBe(false);
    registerSync(registry, 'x', ['shell'], () => undefined);
    expect(registry.hasSyncDecisionHooks()).toBe(true);
  });
});

describe('HookRegistry.evaluatePreToolUse decisions', () => {
  it('blocks and stops later hooks when a hook denies', async () => {
    const registry = new HookRegistry();
    const ran: string[] = [];
    registerSync(registry, 'blocker', ['shell'], (ctx) => {
      ran.push('blocker');
      return { decision: 'block', reason: `unsafe: ${(ctx.input as { command: string }).command}` };
    });
    registerSync(registry, 'after', ['shell'], () => { ran.push('after'); });

    const decision = await registry.evaluatePreToolUse(contextFor('shell', { command: 'rm -rf /' }));
    expect(decision.outcome).toBe('block');
    expect(decision.blockingHook).toBe('blocker');
    expect(decision.blockReason).toContain('unsafe');
    expect(ran).toEqual(['blocker']);
  });

  it('applies a modified input and chains it to the next hook', async () => {
    const registry = new HookRegistry();
    registerSync(registry, 'redactor', ['shell'], () => ({
      modifiedInput: { command: 'ls', redacted: true },
    }));
    registerSync(registry, 'observer', ['shell'], (ctx) => {
      // Second hook sees the first hook's rewritten input.
      expect(ctx.input).toEqual({ command: 'ls', redacted: true });
      return undefined;
    });

    const decision = await registry.evaluatePreToolUse(contextFor('shell', { command: 'rm -rf /' }));
    expect(decision.outcome).toBe('modified');
    expect(decision.inputModified).toBe(true);
    expect(decision.finalInput).toEqual({ command: 'ls', redacted: true });
  });

  it('accumulates additional context without changing the input', async () => {
    const registry = new HookRegistry();
    registerSync(registry, 'ctx-a', ['web.*'], () => ({ additionalContext: 'cite sources' }));
    registerSync(registry, 'ctx-b', ['web.*'], () => ({ additionalContext: 'avoid tracking params' }));

    const decision = await registry.evaluatePreToolUse(contextFor('web.fetch', { url: 'https://x.test' }));
    expect(decision.outcome).toBe('allow');
    expect(decision.inputModified).toBe(false);
    expect(decision.additionalContext).toEqual(['cite sources', 'avoid tracking params']);
  });

  it('fails closed and blocks when a hook throws', async () => {
    const registry = new HookRegistry();
    registerSync(registry, 'boom', ['shell'], () => {
      throw new Error('operator hook bug');
    });
    const decision = await registry.evaluatePreToolUse(contextFor('shell', { command: 'ls' }));
    expect(decision.outcome).toBe('block');
    expect(decision.blockingHook).toBe('boom');
    expect(decision.blockReason).toContain('operator hook bug');
    expect(registry.stats().find(stat => stat.name === 'boom')?.failures).toBe(1);
  });

  it('fails closed and blocks when an async hook rejects', async () => {
    const registry = new HookRegistry();
    registerSync(registry, 'reject', ['shell'], async () => {
      throw new Error('async denial');
    });
    const decision = await registry.evaluatePreToolUse(contextFor('shell', { command: 'ls' }));
    expect(decision.outcome).toBe('block');
    expect(decision.blockReason).toContain('async denial');
  });

  it('fails closed and blocks when a hook hangs past the timeout', async () => {
    const registry = new HookRegistry();
    registerSync(registry, 'hang', ['shell'], () => new Promise<never>(() => {
      // never settles
    }));
    const decision = await registry.evaluatePreToolUse(
      contextFor('shell', { command: 'ls' }),
      { timeoutMs: 20 },
    );
    expect(decision.outcome).toBe('block');
    expect(decision.blockingHook).toBe('hang');
    expect(decision.blockReason).toMatch(/timed out/);
    expect(registry.stats().find(stat => stat.name === 'hang')?.failures).toBe(1);
  });

  it('fails closed and blocks on a malformed hook return', async () => {
    const registry = new HookRegistry();
    registerSync(registry, 'garbage', ['shell'], () => 'not a decision object');
    const decision = await registry.evaluatePreToolUse(contextFor('shell', { command: 'ls' }));
    expect(decision.outcome).toBe('block');
    expect(decision.blockingHook).toBe('garbage');
    expect(registry.stats().find(stat => stat.name === 'garbage')?.failures).toBe(1);
  });
});

describe('createPreToolHookGate alias resolution (psfn-framework-816w)', () => {
  function registerBlocker(registry: HookRegistry, name: string, pattern: string): void {
    registerSync(registry, name, [pattern], () => ({ decision: 'block', reason: `${name} refused` }));
  }

  it('lets an alias-only policy intercept the canonical tool call', async () => {
    // Policy is registered against a RETIRED alias (`web_fetch`); the tool is
    // invoked by its canonical name (`web`). Before the fix the adapter passed
    // aliases:[] and this policy never matched.
    const registry = new HookRegistry();
    registerBlocker(registry, 'alias-policy', 'web_fetch');
    const gate = createPreToolHookGate({
      evaluator: registry,
      getCorrelation: () => undefined,
      resolveAliases: resolveToolAliasMatchers,
      onDecision: () => {},
    });

    const evaluation = await gate.evaluate({ toolName: 'web', params: {}, tier: 'autonomous' });
    expect(evaluation?.outcome).toBe('block');
    expect(evaluation?.blockingHook).toBe('alias-policy');
  });

  it('lets a canonical-name policy intercept an alias-form invocation', async () => {
    // Policy is registered against the canonical `web`; the tool is invoked by
    // a retired alias (`web_fetch`). The alias set must expose `web`.
    const registry = new HookRegistry();
    registerBlocker(registry, 'canonical-policy', 'web');
    const gate = createPreToolHookGate({
      evaluator: registry,
      getCorrelation: () => undefined,
      resolveAliases: resolveToolAliasMatchers,
      onDecision: () => {},
    });

    const evaluation = await gate.evaluate({ toolName: 'web_fetch', params: {}, tier: 'autonomous' });
    expect(evaluation?.outcome).toBe('block');
    expect(evaluation?.blockingHook).toBe('canonical-policy');
  });

  it('fails closed (rejects) when alias resolution reports malformed metadata', async () => {
    // A resolver that throws on malformed alias metadata must abort the call
    // rather than degrade to a never-matching empty alias set.
    const registry = new HookRegistry();
    registerBlocker(registry, 'any', 'web');
    const gate = createPreToolHookGate({
      evaluator: registry,
      getCorrelation: () => undefined,
      resolveAliases: () => {
        throw new Error('Malformed tool alias metadata: dangling canonical reference');
      },
      onDecision: () => {},
    });

    await expect(
      gate.evaluate({ toolName: 'web', params: {}, tier: 'autonomous' }),
    ).rejects.toThrow(/Malformed tool alias metadata/u);
  });

  it('skips alias resolution entirely on the no-hooks fast path', async () => {
    // With no sync hooks the adapter must return null BEFORE resolving aliases,
    // so a throwing resolver is never consulted.
    const registry = new HookRegistry();
    let resolverCalls = 0;
    const gate = createPreToolHookGate({
      evaluator: registry,
      getCorrelation: () => undefined,
      resolveAliases: () => {
        resolverCalls += 1;
        return [];
      },
      onDecision: () => {},
    });

    await expect(
      gate.evaluate({ toolName: 'web', params: {}, tier: 'autonomous' }),
    ).resolves.toBeNull();
    expect(resolverCalls).toBe(0);
  });
});

describe('buildRedactedPreToolAudit', () => {
  it('records only structural shape, counts, and lengths — never argument contents', () => {
    const audit = buildRedactedPreToolAudit('shell', 'autonomous', {
      outcome: 'modified',
      matchedHookCount: 2,
      evaluatedHooks: ['a', 'b'],
      finalInput: { command: 'super-secret-command', path: '/secret' },
      inputModified: true,
      additionalContext: ['policy note one', 'policy note two'],
    });
    expect(audit).toMatchObject({
      toolName: 'shell',
      tier: 'autonomous',
      matchedHookCount: 2,
      evaluatedHooks: ['a', 'b'],
      outcome: 'modified',
      inputModified: true,
      modifiedInputKeys: ['command', 'path'],
      additionalContextCount: 2,
    });
    expect(audit.additionalContextTotalLength).toBe('policy note one'.length + 'policy note two'.length);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('super-secret-command');
    expect(serialized).not.toContain('/secret');
    expect(serialized).not.toContain('policy note one');
  });

  it('redacts the block reason to a length and tags non-object modified inputs', () => {
    const blockAudit = buildRedactedPreToolAudit('shell', 'nursery', {
      outcome: 'block',
      matchedHookCount: 1,
      evaluatedHooks: ['blocker'],
      finalInput: { command: 'ls' },
      inputModified: false,
      additionalContext: [],
      blockReason: 'contains a secret token value',
      blockingHook: 'blocker',
    });
    expect(blockAudit.blockReasonLength).toBe('contains a secret token value'.length);
    expect(JSON.stringify(blockAudit)).not.toContain('secret token');

    const arrayAudit = buildRedactedPreToolAudit('shell', 'nursery', {
      outcome: 'modified',
      matchedHookCount: 1,
      evaluatedHooks: ['m'],
      finalInput: ['a', 'b'],
      inputModified: true,
      additionalContext: [],
    });
    expect(arrayAudit.modifiedInputType).toBe('array');
    expect(arrayAudit.modifiedInputKeys).toBeUndefined();
  });
});
