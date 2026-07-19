import { describe, expect, it, vi } from 'vitest';
import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { MemoryProvider } from '../../core/agent/contracts.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { buildShardLineageEnvelope } from '../shards/result-lineage.js';
import type { ShardResultLineageEnvelope } from '../shards/result-lineage.js';
import {
  SUBAGENT_MEMORY_STAGED_REASON,
  SUBAGENT_MEMORY_WRITE_CAPABILITY,
  SUBAGENT_ORIGIN_PROVENANCE_TAG,
  createGovernedSubagentMemoryTool,
  createSubagentMemoryProviderFacade,
  isRestrictedSubagentMemoryCandidate,
  resolveSubagentMemoryWritePolicy,
  type SubagentMemoryGovernanceContext,
  type SubagentMemoryWritePolicy,
} from './memory-governance.js';

const SUBAGENT_ID = 'subagent-test-1';

function buildTestLineage(): ShardResultLineageEnvelope {
  return buildShardLineageEnvelope({
    kind: 'spawn',
    coreCompanionId: createCompanionId('11111111-1111-4111-8111-111111111111', 'test core companionId'),
    shardId: SUBAGENT_ID,
    shardChannelId: `subagent:${SUBAGENT_ID}`,
    sourceMessage: {
      id: SUBAGENT_ID,
      channelId: `subagent:${SUBAGENT_ID}`,
      channelType: 'api',
      authorId: 'system:subagent-task',
      authorName: 'SubagentTask',
      timestamp: new Date('2026-07-19T00:00:00Z'),
      isDirectMessage: false,
    },
  });
}

function makeMemoryTool(): { tool: AgentTool<any>; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async (): Promise<AgentToolResult<{ isError?: boolean }>> => ({
    content: [{ type: 'text' as const, text: 'memory ok' }],
    details: {},
  }));
  return {
    tool: {
      name: 'memory',
      description: 'memory test tool',
      parameters: {},
      execute,
    } as AgentTool<any>,
    execute,
  };
}

function makeContext(
  policy: SubagentMemoryWritePolicy,
  overrides: Partial<SubagentMemoryGovernanceContext> = {},
): {
  context: SubagentMemoryGovernanceContext;
  audit: ReturnType<typeof vi.fn>;
  recordPendingMemoryCandidates: ReturnType<typeof vi.fn>;
} {
  const audit = vi.fn();
  const recordPendingMemoryCandidates = vi.fn(async () => ({}));
  const context: SubagentMemoryGovernanceContext = {
    subagentId: SUBAGENT_ID,
    subagentName: 'test-worker',
    channelId: `subagent:${SUBAGENT_ID}`,
    task: 'summarize the report',
    policy,
    resolveLineage: () => buildTestLineage(),
    foldReview: { recordPendingMemoryCandidates },
    auditTrail: { append: audit },
    ...overrides,
  };
  return { context, audit, recordPendingMemoryCandidates };
}

function resultIsError(result: AgentToolResult<any>): boolean {
  return (result.details as { isError?: boolean } | undefined)?.isError === true;
}

function resultText(result: AgentToolResult<any>): string {
  return result.content.map(entry => (entry as { text?: string }).text ?? '').join('');
}

describe('resolveSubagentMemoryWritePolicy', () => {
  it('defaults to no write access', () => {
    expect(resolveSubagentMemoryWritePolicy({ capabilities: ['general'] })).toEqual({ mode: 'none' });
  });

  it('grants governed writes for the opt-in capability token', () => {
    expect(resolveSubagentMemoryWritePolicy({
      capabilities: ['general', SUBAGENT_MEMORY_WRITE_CAPABILITY],
    })).toEqual({ mode: 'governed' });
  });

  it('grants elevated writes for an explicit per-spawn elevation', () => {
    expect(resolveSubagentMemoryWritePolicy({
      capabilities: ['general'],
      memoryWriteElevation: { reason: 'sleeptime introspection lane' },
    })).toEqual({ mode: 'elevated', reason: 'sleeptime introspection lane' });
  });

  it('fails closed on a blank elevation reason', () => {
    expect(() => resolveSubagentMemoryWritePolicy({
      capabilities: ['general'],
      memoryWriteElevation: { reason: '   ' },
    })).toThrow(/non-empty reason/);
  });
});

describe('isRestrictedSubagentMemoryCandidate', () => {
  it('treats emotional, relational, and boundary types as restricted', () => {
    expect(isRestrictedSubagentMemoryCandidate('emotional', [])).toBe(true);
    expect(isRestrictedSubagentMemoryCandidate('relational', [])).toBe(true);
    expect(isRestrictedSubagentMemoryCandidate('boundary', [])).toBe(true);
  });

  it('treats an undeterminable type as restricted (fail closed)', () => {
    expect(isRestrictedSubagentMemoryCandidate(undefined, [])).toBe(true);
  });

  it('escalates procedural/semantic writes carrying relational or boundary tags', () => {
    expect(isRestrictedSubagentMemoryCandidate('procedural', ['partner'])).toBe(true);
    expect(isRestrictedSubagentMemoryCandidate('semantic', ['family'])).toBe(true);
    expect(isRestrictedSubagentMemoryCandidate('procedural', ['consent'])).toBe(true);
    expect(isRestrictedSubagentMemoryCandidate('semantic', ['boundary_note'])).toBe(true);
  });

  it('passes procedural and task-scoped classes without restricted tags', () => {
    expect(isRestrictedSubagentMemoryCandidate('procedural', ['workflow'])).toBe(false);
    expect(isRestrictedSubagentMemoryCandidate('semantic', [])).toBe(false);
    expect(isRestrictedSubagentMemoryCandidate('episodic', ['event'])).toBe(false);
    expect(isRestrictedSubagentMemoryCandidate('reflection', [])).toBe(false);
  });
});

describe('createSubagentMemoryProviderFacade', () => {
  it('forwards only the MemoryProvider contract reads and hides instance write surfaces', async () => {
    class FakeProviderWithWrites {
      retrieveCalls: string[] = [];
      async retrieve(contextText: string): Promise<string> {
        this.retrieveCalls.push(contextText);
        return `retrieved:${contextText}`;
      }
      async write(): Promise<void> {
        throw new Error('write must never be reachable through the facade');
      }
      async deleteMemory(): Promise<void> {
        throw new Error('delete must never be reachable through the facade');
      }
    }
    const raw = new FakeProviderWithWrites();
    const facade = createSubagentMemoryProviderFacade(raw as unknown as MemoryProvider);

    expect(facade).not.toBe(raw);
    await expect(facade.retrieve('hello', 'channel')).resolves.toBe('retrieved:hello');
    expect(raw.retrieveCalls).toEqual(['hello']);
    expect((facade as Record<string, unknown>).write).toBeUndefined();
    expect((facade as Record<string, unknown>).deleteMemory).toBeUndefined();
    // Optional contract methods absent on the source stay absent on the facade.
    expect(facade.captureTurnMemorySnapshot).toBeUndefined();
    expect(facade.retrieveProactiveRecall).toBeUndefined();
  });

  it('forwards optional contract methods when the source provides them', () => {
    const retrieveProactiveRecall = vi.fn(async () => 'recall');
    const provider = {
      retrieve: vi.fn(async () => ''),
      retrieveProactiveRecall,
    } as unknown as MemoryProvider;
    const facade = createSubagentMemoryProviderFacade(provider);
    expect(facade.retrieveProactiveRecall).toBeDefined();
  });
});

describe('createGovernedSubagentMemoryTool', () => {
  it('passes read actions through unchanged', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context } = makeContext({ mode: 'none' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    for (const action of ['search', 'shared_background', 'census', 'exists', 'timeline']) {
      execute.mockClear();
      const result = await governed.execute('call-1', { action, query: 'q' }, undefined);
      expect(resultIsError(result)).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toEqual({ action, query: 'q' });
    }
  });

  it('denies writes without the opt-in capability (default toolset has no memory write)', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, audit } = makeContext({ mode: 'none' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'write', text: 'routine step', type: 'procedural',
    }, undefined);

    expect(resultIsError(result)).toBe(true);
    expect(resultText(result)).toContain('opt-in');
    expect(execute).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('subagent.memory.mutation.denied', expect.objectContaining({
      subagentId: SUBAGENT_ID,
      action: 'write',
      reason: 'memory_write_not_granted',
    }));
  });

  it.each<SubagentMemoryWritePolicy>([
    { mode: 'none' },
    { mode: 'governed' },
    { mode: 'elevated', reason: 'memory maintenance lane' },
  ])('denies delete-class actions at every tier and elevation (policy %j)', async (policy) => {
    const { tool, execute } = makeMemoryTool();
    const { context, recordPendingMemoryCandidates } = makeContext(policy);
    const governed = createGovernedSubagentMemoryTool(tool, context);

    for (const action of ['delete', 'redact', 'restore']) {
      const result = await governed.execute('call-1', { action, memory_id: 'mem-1' }, undefined);
      expect(resultIsError(result)).toBe(true);
      expect(resultText(result)).toContain('never available');
    }
    expect(execute).not.toHaveBeenCalled();
    expect(recordPendingMemoryCandidates).not.toHaveBeenCalled();
  });

  it('denies unknown actions (fail closed)', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context } = makeContext({ mode: 'elevated', reason: 'maintenance' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    for (const params of [{}, { action: 'compact' }, { action: 42 }]) {
      const result = await governed.execute('call-1', params, undefined);
      expect(resultIsError(result)).toBe(true);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes governed procedural writes through with subagent provenance stamping', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, audit, recordPendingMemoryCandidates } = makeContext({ mode: 'governed' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'write', text: 'build step order matters', type: 'procedural', tags: 'workflow',
    }, undefined);

    expect(resultIsError(result)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      action: 'write',
      __psfnShardSource: `subagent:${SUBAGENT_ID}`,
    });
    expect(recordPendingMemoryCandidates).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('subagent.memory.write.direct', expect.objectContaining({
      subagentId: SUBAGENT_ID,
      action: 'write',
    }));
  });

  it.each([
    { label: 'emotional type', params: { action: 'write', text: 'this moved me deeply', type: 'emotional' } },
    { label: 'relational type', params: { action: 'write', text: 'they grew closer', type: 'relational' } },
    { label: 'boundary type', params: { action: 'write', text: 'never bring this up', type: 'boundary' } },
    { label: 'relational tags on a procedural type', params: { action: 'write', text: 'note about partner', type: 'procedural', tags: 'partner' } },
  ])('stages restricted governed writes for fold review instead of writing ($label)', async ({ params }) => {
    const { tool, execute } = makeMemoryTool();
    const { context, audit, recordPendingMemoryCandidates } = makeContext({ mode: 'governed' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', params, undefined);

    expect(execute).not.toHaveBeenCalled();
    expect(resultIsError(result)).toBe(false);
    expect(result.details).toMatchObject({
      mutationWorkflow: 'fold_review_only',
      reviewState: 'pending',
      blockedCorePromotion: true,
      blockedCorePromotionReason: SUBAGENT_MEMORY_STAGED_REASON,
      pendingTaggedOutputCount: 1,
    });
    expect(recordPendingMemoryCandidates).toHaveBeenCalledTimes(1);
    const staged = recordPendingMemoryCandidates.mock.calls[0]?.[0] as {
      shardId: string;
      channelId: string;
      outputs: Array<{ kind: string; provenanceTags: string[]; provenance: { tags: string[] } }>;
    };
    expect(staged.shardId).toBe(SUBAGENT_ID);
    expect(staged.channelId).toBe(`subagent:${SUBAGENT_ID}`);
    expect(staged.outputs).toHaveLength(1);
    expect(staged.outputs[0]?.kind).toBe('l2_memory');
    expect(staged.outputs[0]?.provenanceTags).toEqual(expect.arrayContaining([
      SUBAGENT_ORIGIN_PROVENANCE_TAG,
      `subagent:${SUBAGENT_ID}`,
    ]));
    expect(staged.outputs[0]?.provenance.tags).toEqual(expect.arrayContaining([
      SUBAGENT_ORIGIN_PROVENANCE_TAG,
    ]));
    expect(audit).toHaveBeenCalledWith('subagent.memory.write.staged', expect.objectContaining({
      subagentId: SUBAGENT_ID,
      stagedCandidateCount: 1,
    }));
  });

  it('treats an undeterminable memory type as restricted and fails closed', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, recordPendingMemoryCandidates } = makeContext({ mode: 'governed' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    for (const params of [
      { action: 'write', text: 'typed nothing' },
      { action: 'write', text: 'typed garbage', type: 'vibes' },
    ]) {
      const result = await governed.execute('call-1', params, undefined);
      expect(resultIsError(result)).toBe(true);
      expect(resultText(result)).toContain('fail closed');
    }
    expect(execute).not.toHaveBeenCalled();
    expect(recordPendingMemoryCandidates).not.toHaveBeenCalled();
  });

  it('denies restricted writes when the fold-review queue is not wired (no silent fallback)', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, audit } = makeContext({ mode: 'governed' }, { foldReview: null });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'write', text: 'this moved me', type: 'emotional',
    }, undefined);

    expect(resultIsError(result)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('subagent.memory.mutation.denied', expect.objectContaining({
      reason: 'fold_review_unavailable',
    }));
  });

  it('denies the mutation when lineage resolution fails (fail closed, run survives)', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, recordPendingMemoryCandidates } = makeContext({ mode: 'governed' }, {
      resolveLineage: () => {
        throw new Error('missing companion identity');
      },
    });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'write', text: 'this moved me', type: 'emotional',
    }, undefined);

    expect(resultIsError(result)).toBe(true);
    expect(resultText(result)).toContain('missing companion identity');
    expect(execute).not.toHaveBeenCalled();
    expect(recordPendingMemoryCandidates).not.toHaveBeenCalled();
  });

  it('denies the mutation when fold-review staging itself fails', async () => {
    const { tool, execute } = makeMemoryTool();
    const recordPendingMemoryCandidates = vi.fn(async () => {
      throw new Error('store unavailable');
    });
    const { context } = makeContext({ mode: 'governed' }, {
      foldReview: { recordPendingMemoryCandidates },
    });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'write', text: 'this moved me', type: 'emotional',
    }, undefined);

    expect(resultIsError(result)).toBe(true);
    expect(resultText(result)).toContain('store unavailable');
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes a fully procedural governed import through with stamping', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, recordPendingMemoryCandidates } = makeContext({ mode: 'governed' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'import',
      records: [
        { text: 'step one', type: 'procedural' },
        { text: 'fact two', type: 'semantic' },
      ],
    }, undefined);

    expect(resultIsError(result)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      __psfnShardSource: `subagent:${SUBAGENT_ID}`,
    });
    expect(recordPendingMemoryCandidates).not.toHaveBeenCalled();
  });

  it('stages the entire governed import batch when any record is restricted (atomic)', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, recordPendingMemoryCandidates } = makeContext({ mode: 'governed' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'import',
      records: [
        { text: 'step one', type: 'procedural' },
        { text: 'they were grieving', type: 'emotional' },
      ],
    }, undefined);

    expect(execute).not.toHaveBeenCalled();
    expect(resultIsError(result)).toBe(false);
    expect(recordPendingMemoryCandidates).toHaveBeenCalledTimes(1);
    const staged = recordPendingMemoryCandidates.mock.calls[0]?.[0] as { outputs: unknown[] };
    expect(staged.outputs).toHaveLength(2);
  });

  it('rejects a governed import containing invalid records (fail closed, no partial import)', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, recordPendingMemoryCandidates } = makeContext({ mode: 'governed' });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'import',
      records: [
        { text: 'step one', type: 'procedural' },
        { text: 'typed nothing' },
      ],
    }, undefined);

    expect(resultIsError(result)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(recordPendingMemoryCandidates).not.toHaveBeenCalled();
  });

  it('lets an elevated spawn write restricted memory directly with provenance and audit', async () => {
    const { tool, execute } = makeMemoryTool();
    const { context, audit, recordPendingMemoryCandidates } = makeContext({
      mode: 'elevated',
      reason: 'sleeptime emotional-memory maintenance',
    });
    const governed = createGovernedSubagentMemoryTool(tool, context);

    const result = await governed.execute('call-1', {
      action: 'write', text: 'this moved me deeply', type: 'emotional',
    }, undefined);

    expect(resultIsError(result)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      __psfnShardSource: `subagent:${SUBAGENT_ID}`,
    });
    expect(recordPendingMemoryCandidates).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('subagent.memory.mutation.elevated', expect.objectContaining({
      subagentId: SUBAGENT_ID,
      action: 'write',
      elevationReason: 'sleeptime emotional-memory maintenance',
    }));
  });

  it('restricts patch to elevated spawns', async () => {
    const { tool, execute } = makeMemoryTool();
    const governedContext = makeContext({ mode: 'governed' });
    const governed = createGovernedSubagentMemoryTool(tool, governedContext.context);

    const denied = await governed.execute('call-1', {
      action: 'patch', memory_id: 'mem-1', tags: 'workflow',
    }, undefined);
    expect(resultIsError(denied)).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const elevatedContext = makeContext({ mode: 'elevated', reason: 'maintenance' });
    const elevated = createGovernedSubagentMemoryTool(tool, elevatedContext.context);
    const allowed = await elevated.execute('call-2', {
      action: 'patch', memory_id: 'mem-1', tags: 'workflow',
    }, undefined);
    expect(resultIsError(allowed)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
