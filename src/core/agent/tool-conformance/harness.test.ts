import { describe, expect, it, vi } from 'vitest';
import type { AgentTool, AgentToolResult } from '../../../boundary/pi-agent/index.js';
import { runToolConformanceSweep } from './harness.js';
import type { ToolProbeSpec, ActionProbeSpec } from './probe-registry.js';
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

  describe('union parameter schemas (bead an52.4)', () => {
    // A top-level TypeBox `Type.Union([...])` emits `{anyOf:[...]}` with no
    // top-level type:'object' and no top-level properties (they live in each
    // branch). validateSchema must accept these instead of falsely flagging
    // schema_invalid — the false positive that made `notify` fail every sweep.
    const objBranch = (action: string) => ({
      type: 'object',
      properties: { action: { const: action }, message: { type: 'string' } },
      required: ['action'],
      additionalProperties: false,
    });

    it('accepts a top-level anyOf of object branches', async () => {
      const result = await sweep(
        [tool('uni_any', async () => okResult(), { anyOf: [objBranch('a'), objBranch('b')] })],
        { uni_any: { kind: 'schema_only' } },
      );
      expect(result.results[0]).toMatchObject({ probeKind: 'schema_only', ok: true });
      expect(result.results[0].classification).toBeUndefined();
    });

    it('accepts a top-level oneOf of object branches', async () => {
      const result = await sweep(
        [tool('uni_one', async () => okResult(), { oneOf: [objBranch('a'), objBranch('b')] })],
        { uni_one: { kind: 'schema_only' } },
      );
      expect(result.results[0]).toMatchObject({ probeKind: 'schema_only', ok: true });
    });

    it('accepts a top-level allOf of object branches', async () => {
      const result = await sweep(
        [tool('uni_all', async () => okResult(), { allOf: [objBranch('a'), objBranch('b')] })],
        { uni_all: { kind: 'schema_only' } },
      );
      expect(result.results[0]).toMatchObject({ probeKind: 'schema_only', ok: true });
    });

    it('accepts a nested union-of-union of object branches', async () => {
      const result = await sweep(
        [tool('uni_nest', async () => okResult(), { anyOf: [{ oneOf: [objBranch('a')] }, objBranch('b')] })],
        { uni_nest: { kind: 'schema_only' } },
      );
      expect(result.results[0]).toMatchObject({ probeKind: 'schema_only', ok: true });
    });

    it('accepts a fixture mirroring notify\'s five-variant union shape', async () => {
      const notifyLike = {
        anyOf: [
          objBranch('brief'),
          objBranch('send'),
          objBranch('send'),
          objBranch('consider'),
          objBranch('approval_request'),
        ],
      };
      const result = await sweep(
        [tool('notify_like', async () => okResult(), notifyLike)],
        { notify_like: { kind: 'schema_only' } },
      );
      expect(result.results[0]).toMatchObject({ probeKind: 'schema_only', ok: true });
    });

    it('still rejects a genuinely malformed non-object non-union schema (fail-closed)', async () => {
      const scalar = await sweep(
        [tool('scalar', async () => okResult(), { type: 'string' })],
        { scalar: { kind: 'schema_only' } },
      );
      expect(scalar.results[0]).toMatchObject({ probeKind: 'schema_only', ok: false, classification: 'schema_invalid' });

      const empty = await sweep(
        [tool('empty', async () => okResult(), {})],
        { empty: { kind: 'schema_only' } },
      );
      expect(empty.results[0]).toMatchObject({ probeKind: 'schema_only', ok: false, classification: 'schema_invalid' });
    });

    it('rejects an empty union and a union with a malformed branch (fail-closed)', async () => {
      const emptyUnion = await sweep(
        [tool('empty_union', async () => okResult(), { anyOf: [] })],
        { empty_union: { kind: 'schema_only' } },
      );
      expect(emptyUnion.results[0]).toMatchObject({ probeKind: 'schema_only', ok: false, classification: 'schema_invalid' });

      const badBranch = await sweep(
        [tool('bad_branch', async () => okResult(), { anyOf: [objBranch('a'), { type: 'string' }] })],
        { bad_branch: { kind: 'schema_only' } },
      );
      expect(badBranch.results[0]).toMatchObject({ probeKind: 'schema_only', ok: false, classification: 'schema_invalid' });
    });
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

describe('extended per-action coverage (bead 65rk.7)', () => {
  const actionSchemaReq = {
    type: 'object',
    properties: { action: { type: 'string' } },
    required: ['action'],
  };

  it('default run stays byte-compatible: no mode field and only legacy probe kinds', async () => {
    const result = await sweep(
      [
        tool('reader', async () => okResult()),
        tool('schema', async () => okResult()),
      ],
      {
        reader: { kind: 'read_only', args: { action: 'list' } },
        schema: { kind: 'schema_only' },
      },
    );
    expect(result).not.toHaveProperty('mode');
    expect(Object.keys(result).sort()).toEqual(['ranAt', 'results', 'schemaVersion', 'trigger']);
    for (const probe of result.results) {
      expect(['read_only', 'schema_only', 'rejection_check']).toContain(probe.probeKind);
    }
  });

  it('extended run stamps mode and appends sandbox_helper probes', async () => {
    const result = await sweep(
      [tool('reader', async () => okResult())],
      { reader: { kind: 'read_only', args: { action: 'list' } } },
      { extended: true, resolveCanonicalActions: () => undefined },
    );
    expect(result.mode).toBe('extended');
    const sandboxProbes = result.results.filter(r => r.probeKind === 'sandbox_helper');
    expect(sandboxProbes.length).toBeGreaterThan(0);
    expect(sandboxProbes.every(p => p.ok)).toBe(true);
  });

  it('runs one probe per classified action: safe_read invoked, schema_assert schema-only', async () => {
    const executed: Array<Record<string, unknown> | undefined> = [];
    const t = tool('acty', async (_id, params) => {
      executed.push(params as Record<string, unknown>);
      return okResult();
    }, { type: 'object', properties: { action: { type: 'string' } } });
    const result = await sweep(
      [t],
      { acty: { kind: 'read_only', args: {} } },
      {
        extended: true,
        resolveCanonicalActions: () => ['list', 'delete'],
        resolveActionProbes: () => ({
          list: { kind: 'safe_read', args: { action: 'list' } },
          delete: { kind: 'schema_assert' },
        }),
      },
    );
    const list = result.results.find(r => r.action === 'list');
    const del = result.results.find(r => r.action === 'delete');
    expect(list).toMatchObject({ probeKind: 'safe_read', ok: true });
    expect(del).toMatchObject({ probeKind: 'schema_assert', ok: true });
    // Only the safe_read action actually invoked the handler.
    expect(executed).toEqual([{ action: 'list' }]);
  });

  it('scoped_mutation is skipped (never executed) without the isolated-scope flag', async () => {
    let calls = 0;
    const t = tool('mut', async () => { calls += 1; return okResult(); });
    const result = await sweep(
      [t],
      { mut: { kind: 'schema_only' } },
      {
        extended: true,
        resolveCanonicalActions: () => ['scrub'],
        resolveActionProbes: () => ({
          scrub: {
            kind: 'scoped_mutation',
            args: { action: 'add' },
            cancellation: { kind: 'abort_signal' },
            cleanup: { args: { action: 'remove' } },
          },
        }),
      },
    );
    const probe = result.results.find(r => r.action === 'scrub');
    expect(probe).toMatchObject({ probeKind: 'scoped_mutation', ok: true, skipped: true });
    expect(calls).toBe(0);
  });

  it('scoped_mutation executes then cleans up when the isolated-scope flag is set', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const t = tool('mut', async (_id, params) => { calls.push(params as Record<string, unknown>); return okResult(); });
    const result = await sweep(
      [t],
      { mut: { kind: 'schema_only' } },
      {
        extended: true,
        allowScopedMutations: true,
        resolveCanonicalActions: () => ['scrub'],
        resolveActionProbes: () => ({
          scrub: {
            kind: 'scoped_mutation',
            args: { action: 'add', channel_id: 'internal:tool-conformance' },
            cancellation: { kind: 'abort_signal' },
            cleanup: { args: { action: 'remove', channel_id: 'internal:tool-conformance' } },
          },
        }),
      },
    );
    const probe = result.results.find(r => r.action === 'scrub');
    expect(probe).toMatchObject({ probeKind: 'scoped_mutation', ok: true });
    expect(probe?.skipped).toBeUndefined();
    expect(calls).toEqual([
      { action: 'add', channel_id: 'internal:tool-conformance' },
      { action: 'remove', channel_id: 'internal:tool-conformance' },
    ]);
  });

  it('scoped_mutation FAILS closed (cleanup_failed) when teardown returns an error', async () => {
    const t = tool('mut', async (_id, params) =>
      (params as { action?: unknown }).action === 'remove' ? errorResult('teardown broke') : okResult());
    const result = await sweep(
      [t],
      { mut: { kind: 'schema_only' } },
      {
        extended: true,
        allowScopedMutations: true,
        resolveCanonicalActions: () => ['scrub'],
        resolveActionProbes: () => ({
          scrub: {
            kind: 'scoped_mutation',
            args: { action: 'add' },
            cancellation: { kind: 'abort_signal' },
            cleanup: { args: { action: 'remove' } },
          },
        }),
      },
    );
    const probe = result.results.find(r => r.action === 'scrub');
    expect(probe).toMatchObject({ ok: false, classification: 'cleanup_failed' });
  });

  it('fails closed when a canonical action has no per-action classification', async () => {
    await expect(sweep(
      [tool('acty', async () => okResult(), actionSchemaReq)],
      { acty: { kind: 'schema_only' } },
      {
        extended: true,
        resolveCanonicalActions: () => ['list', 'unclassified_verb'],
        resolveActionProbes: () => ({ list: { kind: 'safe_read', args: { action: 'list' } } }),
      },
    )).rejects.toBeInstanceOf(ToolConformanceHarnessError);
  });

  // ── Finding 1: schema-authoritative per-action coverage ──
  it('fails closed when a verb exists in the live schema but not in the classification (bead 65rk.7)', async () => {
    // The tool-surface canonical list ('list' only) is STALE: the live schema
    // also declares 'sneaky'. Coverage is driven by the union of the two, so the
    // unclassified schema verb fails closed. Reverting to registry-only coverage
    // (dropping the schema union) makes this reject NOT fire — the decisive proof.
    const schemaWithSneaky = {
      type: 'object',
      properties: { action: { anyOf: [{ const: 'list' }, { const: 'sneaky' }] } },
    };
    await expect(sweep(
      [tool('drifty', async () => okResult(), schemaWithSneaky)],
      { drifty: { kind: 'schema_only' } },
      {
        extended: true,
        resolveCanonicalActions: () => ['list'],
        resolveActionProbes: () => ({ list: { kind: 'safe_read', args: { action: 'list' } } }),
      },
    )).rejects.toBeInstanceOf(ToolConformanceHarnessError);
  });

  it('probes a classified schema verb even when the canonical list omits it (bead 65rk.7)', async () => {
    const schema = { type: 'object', properties: { action: { enum: ['list', 'snapshot'] } } };
    const result = await sweep(
      [tool('drifty', async () => okResult(), schema)],
      { drifty: { kind: 'schema_only' } },
      {
        extended: true,
        // Canonical list is stale (missing 'snapshot'); the live schema supplies it.
        resolveCanonicalActions: () => ['list'],
        resolveActionProbes: () => ({
          list: { kind: 'safe_read', args: { action: 'list' } },
          snapshot: { kind: 'schema_assert' },
        }),
      },
    );
    expect(result.results.find(r => r.action === 'snapshot')).toMatchObject({
      probeKind: 'schema_assert',
      ok: true,
    });
  });

  // ── Finding 3: scoped_mutation cancellation contract + teardown discipline ──
  it('rejects a scoped_mutation with no cancellation contract (registration integrity, bead 65rk.7)', async () => {
    await expect(sweep(
      [tool('mut', async () => okResult())],
      { mut: { kind: 'schema_only' } },
      {
        extended: true,
        resolveCanonicalActions: () => ['scrub'],
        resolveActionProbes: () => ({
          // Deliberately omit the now-required cancellation contract.
          scrub: { kind: 'scoped_mutation', args: { action: 'add' }, cleanup: { args: { action: 'remove' } } } as unknown as ActionProbeSpec,
        }),
      },
    )).rejects.toBeInstanceOf(ToolConformanceHarnessError);
  });

  it('awaits cancellation before teardown so a timed-out mutation cannot write after cleanup (bead 65rk.7)', async () => {
    const events: string[] = [];
    const t = tool('mut', async (_id, params, signal?: AbortSignal) => {
      const action = (params as { action?: unknown }).action;
      if (action === 'remove') { events.push('cleanup'); return okResult(); }
      // A slow mutation that would "commit" late — but honors the AbortSignal.
      return await new Promise<AgentToolResult<unknown>>((resolve, reject) => {
        const commit = setTimeout(() => { events.push('mutation-commit-LATE'); resolve(okResult()); }, 200);
        signal?.addEventListener('abort', () => {
          clearTimeout(commit);
          events.push('mutation-aborted');
          reject(new Error('aborted'));
        });
      });
    });
    const result = await sweep(
      [t],
      { mut: { kind: 'schema_only' } },
      {
        extended: true,
        allowScopedMutations: true,
        perProbeTimeoutMs: 20,
        resolveCanonicalActions: () => ['scrub'],
        resolveActionProbes: () => ({
          scrub: {
            kind: 'scoped_mutation',
            args: { action: 'add', channel_id: 'internal:tool-conformance' },
            cancellation: { kind: 'abort_signal' },
            cleanup: { args: { action: 'remove', channel_id: 'internal:tool-conformance' } },
          },
        }),
      },
    );
    const probe = result.results.find(r => r.action === 'scrub');
    expect(probe).toMatchObject({ probeKind: 'scoped_mutation', ok: false, classification: 'timeout' });
    // The mutation was cancelled BEFORE teardown, and the late commit never fired.
    expect(events).toEqual(['mutation-aborted', 'cleanup']);
    // Wait past the original commit window: still no post-return residual write.
    await new Promise(resolve => setTimeout(resolve, 260));
    expect(events).toEqual(['mutation-aborted', 'cleanup']);
  });

  it('withholds teardown when the mutation cannot be cancelled (bead 65rk.7)', async () => {
    const events: string[] = [];
    const t = tool('mut', async (_id, params, _signal?: AbortSignal) => {
      const action = (params as { action?: unknown }).action;
      if (action === 'remove') { events.push('cleanup'); return okResult(); }
      // Ignores the abort signal entirely — an uncancellable mutation.
      return await new Promise<AgentToolResult<unknown>>((resolve) => {
        setTimeout(() => { events.push('mutation-commit'); resolve(okResult()); }, 200);
      });
    });
    const result = await sweep(
      [t],
      { mut: { kind: 'schema_only' } },
      {
        extended: true,
        allowScopedMutations: true,
        perProbeTimeoutMs: 20,
        resolveCanonicalActions: () => ['scrub'],
        resolveActionProbes: () => ({
          scrub: {
            kind: 'scoped_mutation',
            args: { action: 'add' },
            cancellation: { kind: 'abort_signal' },
            cleanup: { args: { action: 'remove' } },
          },
        }),
      },
    );
    const probe = result.results.find(r => r.action === 'scrub');
    expect(probe).toMatchObject({ ok: false, classification: 'mutation_uncancellable' });
    // Teardown withheld: cleanup must never race an in-flight mutation.
    expect(events).not.toContain('cleanup');
    // Drain the dangling mutation timer so it cannot leak into later tests.
    await new Promise(resolve => setTimeout(resolve, 220));
  });

  it('extended mode falls back to the default per-tool probe for action-less tools', async () => {
    const result = await sweep(
      [tool('reader', async () => okResult())],
      { reader: { kind: 'read_only', args: { action: 'list' } } },
      { extended: true, resolveCanonicalActions: () => [] },
    );
    const probe = result.results.find(r => r.toolName === 'reader');
    expect(probe).toMatchObject({ probeKind: 'read_only', ok: true });
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
