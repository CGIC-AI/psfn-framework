import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../shared/event-bus.js';
import { loadWorkspaceHooks } from './hook-loader.js';
import { HookRegistry } from './hook-registry.js';

declare global {
  var __vvf2HookTestEnvelopes: unknown[] | undefined;
}

const COLLECTOR_HANDLER = [
  'export default (envelope) => {',
  '  globalThis.__vvf2HookTestEnvelopes ??= [];',
  '  globalThis.__vvf2HookTestEnvelopes.push(envelope);',
  '};',
  '',
].join('\n');

const NOOP_HANDLER = 'export default () => {};\n';

function writeHook(
  workspacePath: string,
  hookDir: string,
  manifest: string,
  handlers: Record<string, string> = { 'handler.mjs': NOOP_HANDLER },
): void {
  const directory = join(workspacePath, 'hooks', hookDir);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'HOOK.yaml'), `${manifest.trim()}\n`, 'utf-8');
  for (const [fileName, content] of Object.entries(handlers)) {
    writeFileSync(join(directory, fileName), content, 'utf-8');
  }
}

describe('workspace hook loader', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'vvf2-hooks-'));
    globalThis.__vvf2HookTestEnvelopes = undefined;
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
    globalThis.__vvf2HookTestEnvelopes = undefined;
  });

  it('treats an absent hooks directory as a clean no-op', async () => {
    const registry = new HookRegistry();
    const result = await loadWorkspaceHooks({ workspacePath, registry });
    expect(result.rootExists).toBe(false);
    expect(result.loaded).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(registry.list()).toEqual([]);
  });

  it('rejects a symlinked hooks root instead of loading external handlers', async () => {
    const externalWorkspacePath = mkdtempSync(join(tmpdir(), 'vvf2-hooks-external-'));
    try {
      writeHook(externalWorkspacePath, 'external', [
        'name: external',
        'events:',
        '  - system.ready',
        'handler: handler.mjs',
      ].join('\n'));
      symlinkSync(join(externalWorkspacePath, 'hooks'), join(workspacePath, 'hooks'), 'dir');

      const registry = new HookRegistry();
      const result = await loadWorkspaceHooks({ workspacePath, registry });

      expect(result.rootExists).toBe(false);
      expect(result.loaded).toEqual([]);
      expect(result.rejected).toEqual([]);
      expect(registry.list()).toEqual([]);
    } finally {
      rmSync(externalWorkspacePath, { recursive: true, force: true });
    }
  });

  it('requires an explicit workspacePath', async () => {
    await expect(loadWorkspaceHooks({ workspacePath: '  ', registry: new HookRegistry() }))
      .rejects.toThrow(/explicit workspacePath/);
  });

  it('loads a valid hook, expands wildcard events, and dispatches to its handler', async () => {
    writeHook(workspacePath, 'tool-audit', [
      'name: tool-audit',
      'description: Counts tool calls',
      'events:',
      '  - agent.tool.*',
      'handler: handler.mjs',
    ].join('\n'), { 'handler.mjs': COLLECTOR_HANDLER });

    const registry = new HookRegistry();
    const result = await loadWorkspaceHooks({ workspacePath, registry });
    expect(result.rejected).toEqual([]);
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]).toMatchObject({ name: 'tool-audit' });
    expect([...result.loaded[0]!.events].sort()).toEqual(['agent.tool.end', 'agent.tool.start']);

    const bus = new EventBus();
    registry.attachLifecycleConsumer(bus);
    await bus.emit('agent.tool.start', {
      channelId: 'channel-1',
      toolCallId: 'call-1',
      toolName: 'analysis_workbench',
    });
    const deadline = Date.now() + 2_000;
    while ((globalThis.__vvf2HookTestEnvelopes?.length ?? 0) < 1 && Date.now() < deadline) {
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    expect(globalThis.__vvf2HookTestEnvelopes).toHaveLength(1);
    expect(globalThis.__vvf2HookTestEnvelopes?.[0]).toMatchObject({
      hook: 'tool-audit',
      event: 'agent.tool.start',
      payload: {
        channelId: 'channel-1',
        toolCallId: 'call-1',
        toolName: 'analysis_workbench',
      },
    });
  });

  it('rejects unknown lifecycle events with the allowlist in the reason and keeps loading others', async () => {
    writeHook(workspacePath, 'bad-events', [
      'name: bad-events',
      'events:',
      '  - agent.tool.end',
      '  - memory.retrieval',
      'handler: handler.mjs',
    ].join('\n'));
    writeHook(workspacePath, 'good', [
      'name: good',
      'events:',
      '  - system.ready',
      'handler: handler.mjs',
    ].join('\n'));

    const registry = new HookRegistry();
    const result = await loadWorkspaceHooks({ workspacePath, registry });
    expect(result.loaded.map(record => record.name)).toEqual(['good']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ kind: 'unknown_event', name: 'bad-events' });
    expect(result.rejected[0]!.reason).toContain('memory.retrieval');
    expect(result.rejected[0]!.reason).toContain('agent.turn.start');
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects malformed YAML as parse_error without crashing the scan', async () => {
    writeHook(workspacePath, 'broken', 'name: [unclosed');
    const result = await loadWorkspaceHooks({ workspacePath, registry: new HookRegistry() });
    expect(result.loaded).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ kind: 'parse_error' });
  });

  it('rejects unknown manifest keys fail-closed', async () => {
    writeHook(workspacePath, 'typo', [
      'name: typo',
      'event:',
      '  - agent.tool.end',
      'handler: handler.mjs',
    ].join('\n'));
    const result = await loadWorkspaceHooks({ workspacePath, registry: new HookRegistry() });
    expect(result.rejected[0]).toMatchObject({ kind: 'invalid_manifest' });
    expect(result.rejected[0]!.reason).toContain('unknown manifest keys: event');
  });

  it('rejects manifests with a missing or escaping handler', async () => {
    writeHook(workspacePath, 'no-file', [
      'name: no-file',
      'events:',
      '  - agent.tool.end',
      'handler: does-not-exist.mjs',
    ].join('\n'), {});
    writeHook(workspacePath, 'escapes', [
      'name: escapes',
      'events:',
      '  - agent.tool.end',
      'handler: ../../outside.mjs',
    ].join('\n'), {});
    writeHook(workspacePath, 'no-handler-key', [
      'name: no-handler-key',
      'events:',
      '  - agent.tool.end',
    ].join('\n'), {});
    writeFileSync(join(workspacePath, 'outside.mjs'), NOOP_HANDLER, 'utf-8');

    const registry = new HookRegistry();
    const result = await loadWorkspaceHooks({ workspacePath, registry });
    expect(result.loaded).toEqual([]);
    const byName = new Map(result.rejected.map(rejection => [rejection.name ?? rejection.relativePath, rejection]));
    expect(byName.get('no-file')).toMatchObject({ kind: 'missing_handler' });
    expect(byName.get('escapes')).toMatchObject({ kind: 'missing_handler' });
    expect(byName.get('escapes')!.reason).toContain('escapes the hook directory');
    expect(byName.get('no-handler-key')).toMatchObject({ kind: 'missing_handler' });
    expect(registry.list()).toEqual([]);
  });

  it('rejects handler modules without a function export or that fail to import', async () => {
    writeHook(workspacePath, 'no-export', [
      'name: no-export',
      'events:',
      '  - agent.tool.end',
      'handler: handler.mjs',
    ].join('\n'), { 'handler.mjs': 'export const value = 42;\n' });
    writeHook(workspacePath, 'syntax-error', [
      'name: syntax-error',
      'events:',
      '  - agent.tool.end',
      'handler: handler.mjs',
    ].join('\n'), { 'handler.mjs': 'export default (((\n' });

    const result = await loadWorkspaceHooks({ workspacePath, registry: new HookRegistry() });
    expect(result.loaded).toEqual([]);
    const kinds = result.rejected.map(rejection => rejection.kind);
    expect(kinds).toEqual(['handler_load_error', 'handler_load_error']);
    const noExport = result.rejected.find(rejection => rejection.name === 'no-export');
    expect(noExport!.reason).toContain('must export a function');
  });

  it('rejects the future sync_decision invocation mode with a pointer to 7ym.3', async () => {
    writeHook(workspacePath, 'sync-hook', [
      'name: sync-hook',
      'invocation: sync_decision',
      'events:',
      '  - agent.tool.start',
      'handler: handler.mjs',
    ].join('\n'));
    const result = await loadWorkspaceHooks({ workspacePath, registry: new HookRegistry() });
    expect(result.rejected[0]).toMatchObject({ kind: 'unsupported_invocation', name: 'sync-hook' });
    expect(result.rejected[0]!.reason).toContain('bead 7ym.3');
  });

  it('keeps the first hook and rejects later duplicates by name', async () => {
    writeHook(workspacePath, 'a-first', [
      'name: same-name',
      'events:',
      '  - agent.tool.end',
      'handler: handler.mjs',
    ].join('\n'));
    writeHook(workspacePath, 'b-second', [
      'name: same-name',
      'events:',
      '  - agent.tool.end',
      'handler: handler.mjs',
    ].join('\n'));

    const registry = new HookRegistry();
    const result = await loadWorkspaceHooks({ workspacePath, registry });
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.relativePath).toBe('a-first/HOOK.yaml');
    expect(result.rejected[0]).toMatchObject({
      kind: 'duplicate_name',
      relativePath: 'b-second/HOOK.yaml',
    });
    expect(registry.list()).toHaveLength(1);
  });

  it('skips hooks disabled by manifest without registering them', async () => {
    writeHook(workspacePath, 'off', [
      'name: off',
      'enabled: false',
      'events:',
      '  - agent.tool.end',
      'handler: handler.mjs',
    ].join('\n'));
    const registry = new HookRegistry();
    const result = await loadWorkspaceHooks({ workspacePath, registry });
    expect(result.loaded).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ kind: 'disabled', name: 'off' });
    expect(registry.list()).toEqual([]);
  });

  it('rejects manifests missing name or a usable events array', async () => {
    writeHook(workspacePath, 'nameless', [
      'events:',
      '  - agent.tool.end',
      'handler: handler.mjs',
    ].join('\n'));
    writeHook(workspacePath, 'empty-events', [
      'name: empty-events',
      'events: []',
      'handler: handler.mjs',
    ].join('\n'));

    const result = await loadWorkspaceHooks({ workspacePath, registry: new HookRegistry() });
    expect(result.loaded).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    for (const rejection of result.rejected) {
      expect(rejection.kind).toBe('invalid_manifest');
    }
  });
});
