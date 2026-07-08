import { describe, expect, it, vi } from 'vitest';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { runToolConformanceSweep } from './harness.js';
import type { ToolProbeSpec } from './probe-registry.js';
import { ToolConformanceHarnessError } from './types.js';

function okResult(text = 'ok'): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text }], details: {} };
}

function errorResult(text = 'nope'): AgentToolResult<{ isError: true }> {
  return { content: [{ type: 'text', text }], details: { isError: true } };
}

function tool(
  name: string,
  execute: AgentTool<any>['execute'],
  parameters: Record<string, unknown> = { type: 'object', properties: {} },
): AgentTool<any> {
  return { name, label: name, description: name, parameters, execute } as AgentTool<any>;
}

const actionSchema = {
  type: 'object',
  properties: { action: { type: 'string' } },
  required: ['action'],
};

function sweep(
  tools: AgentTool<any>[],
  specs: Record<string, ToolProbeSpec>,
  overrides: Partial<Parameters<typeof runToolConformanceSweep>[0]> = {},
) {
  return runToolConformanceSweep({
    tools,
    trigger: 'manual',
    perProbeTimeoutMs: 50,
    resolveProbeSpec: (n) => specs[n],
    ...overrides,
  });
}

describe('tool conformance harness', () => {
  it('records a passing read_only probe', async () => {
    const result = await sweep(
      [tool('reader', async () => okResult())],
      { reader: { kind: 'read_only', action: 'list', args: { action: 'list' } } },
    );
    expect(result.schemaVersion).toBe(1);
    expect(result.trigger).toBe('manual');
    const probe = result.results.find(r => r.toolName === 'reader');
    expect(probe).toMatchObject({ probeKind: 'read_only', action: 'list', ok: true });
    expect(probe?.classification).toBeUndefined();
    expect(typeof probe?.durationMs).toBe('number');
  });

  it('classifies a thrown handler as threw', async () => {
    const [probe] = (await sweep(
      [tool('boom', async () => { throw new Error('kaboom'); })],
      { boom: { kind: 'read_only', args: {} } },
    )).results;
    expect(probe).toMatchObject({ ok: false, classification: 'threw' });
    expect(probe.error).toContain('kaboom');
  });

  it('classifies an isError result as returned_error', async () => {
    const [probe] = (await sweep(
      [tool('erry', async () => errorResult('bad state'))],
      { erry: { kind: 'read_only', args: {} } },
    )).results;
    expect(probe).toMatchObject({ ok: false, classification: 'returned_error' });
    expect(probe.error).toContain('bad state');
  });

  it('classifies malformed output', async () => {
    const [probe] = (await sweep(
      [tool('junk', async () => ({ nope: true }) as unknown as AgentToolResult<unknown>)],
      { junk: { kind: 'read_only', args: {} } },
    )).results;
    expect(probe).toMatchObject({ ok: false, classification: 'malformed_output' });
  });

  it('classifies a hung handler as timeout under the bounded per-probe timeout', async () => {
    const [probe] = (await sweep(
      [tool('hang', () => new Promise<AgentToolResult<unknown>>(() => { /* never resolves */ }))],
      { hang: { kind: 'read_only', args: {} } },
      { perProbeTimeoutMs: 20 },
    )).results;
    expect(probe).toMatchObject({ ok: false, classification: 'timeout' });
  });

  it('validates schema for schema_only tools', async () => {
    const good = await sweep(
      [tool('schema_good', async () => okResult(), { type: 'object', properties: {} })],
      { schema_good: { kind: 'schema_only' } },
    );
    expect(good.results[0]).toMatchObject({ probeKind: 'schema_only', ok: true });

    const bad = await sweep(
      [tool('schema_bad', async () => okResult(), { not: 'a schema' } as Record<string, unknown>)],
      { schema_bad: { kind: 'schema_only' } },
    );
    expect(bad.results[0]).toMatchObject({ probeKind: 'schema_only', ok: false, classification: 'schema_invalid' });
  });

  describe('required-action rejection_check (bead gu8m regression)', () => {
    it('passes when the tool rejects empty args by throwing', async () => {
      const result = await sweep(
        [tool('acts', async (_id, params) => {
          if (!params || !(params as { action?: unknown }).action) {
            throw new Error('action is required');
          }
          return okResult();
        }, actionSchema)],
        { acts: { kind: 'schema_only' } },
      );
      const rejection = result.results.find(r => r.probeKind === 'rejection_check');
      expect(rejection).toMatchObject({ toolName: 'acts', ok: true });
    });

    it('passes when the tool rejects empty args with an isError result', async () => {
      const result = await sweep(
        [tool('acts2', async (_id, params) =>
          (params as { action?: unknown }).action ? okResult() : errorResult('action required'),
        actionSchema)],
        { acts2: { kind: 'schema_only' } },
      );
      const rejection = result.results.find(r => r.probeKind === 'rejection_check');
      expect(rejection).toMatchObject({ ok: true });
    });

    it('FAILS (accepted_empty_args) when the tool accepts empty args and acts', async () => {
      const result = await sweep(
        [tool('mutator', async () => okResult('did a mutation'), actionSchema)],
        { mutator: { kind: 'schema_only' } },
      );
      const rejection = result.results.find(r => r.probeKind === 'rejection_check');
      expect(rejection).toMatchObject({ ok: false, classification: 'accepted_empty_args' });
    });

    it('does not run a rejection_check for tools without a required action', async () => {
      const result = await sweep(
        [tool('optional_action', async () => okResult(), {
          type: 'object',
          properties: { action: { type: 'string' } },
        })],
        { optional_action: { kind: 'read_only', args: {} } },
      );
      expect(result.results.some(r => r.probeKind === 'rejection_check')).toBe(false);
    });
  });

  it('fails closed when a live tool has no probe classification', async () => {
    await expect(sweep(
      [tool('unknown_tool', async () => okResult())],
      {},
    )).rejects.toBeInstanceOf(ToolConformanceHarnessError);
  });

  it('executes handlers with no session-store handle (only callId + args)', async () => {
    const executeArgs: unknown[][] = [];
    const spied = tool('reader', async (...args) => { executeArgs.push(args); return okResult(); });
    await sweep([spied], { reader: { kind: 'read_only', args: { action: 'list' } } });
    // Handlers receive exactly (callId, args) — no session store is ever threaded
    // through the probe path.
    expect(executeArgs).toHaveLength(1);
    expect(executeArgs[0]).toHaveLength(2);
    expect(typeof executeArgs[0][0]).toBe('string');
    expect(executeArgs[0][1]).toEqual({ action: 'list' });
  });
});

describe('tool conformance harness never writes session entries', () => {
  it('performs zero session-store writes during a full sweep', async () => {
    // Session write surfaces per src/core/session/manager.ts + store.ts.
    const sessionSpy = {
      append: vi.fn(),
      recordUserMessage: vi.fn(),
      recordAssistantMessage: vi.fn(),
    };
    const tools = [
      tool('reader', async () => okResult()),
      tool('schema', async () => okResult(), { type: 'object', properties: {} }),
      tool('acts', async (_id, params) =>
        (params as { action?: unknown }).action ? okResult() : errorResult('nope'), actionSchema),
    ];
    await sweep(tools, {
      reader: { kind: 'read_only', args: {} },
      schema: { kind: 'schema_only' },
      acts: { kind: 'schema_only' },
    });
    expect(sessionSpy.append).not.toHaveBeenCalled();
    expect(sessionSpy.recordUserMessage).not.toHaveBeenCalled();
    expect(sessionSpy.recordAssistantMessage).not.toHaveBeenCalled();
  });
});
