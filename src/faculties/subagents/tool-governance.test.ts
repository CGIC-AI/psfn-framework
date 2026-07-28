import { describe, expect, it, vi } from 'vitest';
import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import {
  GOVERNED_SUBAGENT_TOOL_POLICIES,
  createGovernedSubagentTool,
  type SubagentToolGovernanceContext,
} from './tool-governance.js';

const SUBAGENT_ID = 'subagent-test-1';

function makeTool(name: string): { tool: AgentTool<any>; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn(async (): Promise<AgentToolResult<{ isError?: boolean }>> => ({
    content: [{ type: 'text' as const, text: `${name} ok` }],
    details: {},
  }));
  return {
    tool: {
      name,
      description: `${name} test tool`,
      parameters: {},
      execute,
    } as AgentTool<any>,
    execute,
  };
}

function makeGoverned(name: string): {
  governed: AgentTool<any>;
  execute: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  const policy = GOVERNED_SUBAGENT_TOOL_POLICIES.get(name);
  if (!policy) throw new Error(`no governance policy for ${name}`);
  const { tool, execute } = makeTool(name);
  const audit = vi.fn();
  const context: SubagentToolGovernanceContext = {
    subagentId: SUBAGENT_ID,
    subagentName: 'test-worker',
    auditTrail: { append: audit },
  };
  return { governed: createGovernedSubagentTool(tool, policy, context), execute, audit };
}

function resultIsError(result: AgentToolResult<any>): boolean {
  return (result.details as { isError?: boolean } | undefined)?.isError === true;
}

function resultText(result: AgentToolResult<any>): string {
  const first = result.content[0];
  return first.type === 'text' ? first.text : '';
}

async function expectDenied(
  harness: ReturnType<typeof makeGoverned>,
  params: unknown,
  expected: { action: string; reason: string },
): Promise<AgentToolResult<any>> {
  const callsBefore = harness.execute.mock.calls.length;
  const result = await harness.governed.execute('call-denied', params as never, undefined);
  expect(resultIsError(result)).toBe(true);
  expect((result.details as { errorClass?: string }).errorClass).toBe('policy_blocked');
  expect(harness.execute.mock.calls.length).toBe(callsBefore);
  expect(harness.audit).toHaveBeenCalledWith('subagent.tool.mutation.denied', expect.objectContaining({
    subagentId: SUBAGENT_ID,
    subagentName: 'test-worker',
    toolName: harness.governed.name,
    action: expected.action,
    reason: expected.reason,
  }));
  return result;
}

async function expectPassThrough(
  harness: ReturnType<typeof makeGoverned>,
  params: unknown,
): Promise<void> {
  const callsBefore = harness.execute.mock.calls.length;
  const result = await harness.governed.execute('call-read', params as never, undefined);
  expect(resultIsError(result)).toBe(false);
  expect(harness.execute.mock.calls.length).toBe(callsBefore + 1);
  // Params reach the underlying tool unchanged (reads are never stamped).
  expect(harness.execute.mock.calls.at(-1)?.[1]).toBe(params);
}

describe('governed orient tool', () => {
  const MUTATIONS = [
    'append',
    'replace',
    'reorient',
    'values_add',
    'values_update',
    'create_concern',
    'resolve_concern',
    'transition_concern',
    'introspection_consent_set',
    'introspection_turn_sensitivity_set',
  ];

  it('passes read actions through unchanged', async () => {
    const harness = makeGoverned('orient');
    await expectPassThrough(harness, { action: 'values_list' });
    await expectPassThrough(harness, { action: 'list_concerns', includeResolved: true });
    await expectPassThrough(harness, { action: 'introspection_consent_get' });
    expect(harness.audit).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS)('denies the %s mutation from a subagent context', async (action) => {
    const harness = makeGoverned('orient');
    const result = await expectDenied(harness, { action, content: 'x', enabled: false }, {
      action,
      reason: 'mutation_not_permitted',
    });
    expect(resultText(result)).toContain('not available from an automaton context');
    // Register guard (rqn1.9): the denial text the automaton reads names the
    // automata register, never the clinical "subagent" (charter 6.28/8.12).
    expect(resultText(result)).not.toMatch(/\bsubagent\b/iu);
  });

  it('denies an unknown action (fail closed)', async () => {
    const harness = makeGoverned('orient');
    await expectDenied(harness, { action: 'values_delete' }, {
      action: 'values_delete',
      reason: 'unknown_action',
    });
  });

  it('denies a call with no resolvable action (fail closed)', async () => {
    const harness = makeGoverned('orient');
    await expectDenied(harness, { content: 'update my values' }, {
      action: 'unknown',
      reason: 'action_unresolved',
    });
    await expectDenied(harness, 'not-an-object', {
      action: 'unknown',
      reason: 'action_unresolved',
    });
  });
});

describe('governed journal tool', () => {
  it('passes reads through and denies write/append', async () => {
    const harness = makeGoverned('journal');
    await expectPassThrough(harness, { action: 'list' });
    await expectPassThrough(harness, { action: 'read', path: 'notes/today' });
    await expectPassThrough(harness, { action: 'search', query: 'garden' });
    await expectDenied(harness, { action: 'write', path: 'notes/today', content: 'x' }, {
      action: 'write',
      reason: 'mutation_not_permitted',
    });
    await expectDenied(harness, { action: 'append', path: 'notes/today', content: 'x' }, {
      action: 'append',
      reason: 'mutation_not_permitted',
    });
  });

  it('denies a journal call without an action (fail closed)', async () => {
    const harness = makeGoverned('journal');
    await expectDenied(harness, { path: 'notes/today', content: 'x' }, {
      action: 'unknown',
      reason: 'action_unresolved',
    });
  });
});

describe('governed wiki tool', () => {
  const MUTATIONS = [
    'write',
    'import',
    'propose_shared_world',
    'wish_create',
    'project_create',
    'project_update',
    'project_add_artifact',
    'project_share',
    'wardrobe_save',
    'wardrobe_revise',
  ];

  it('passes explicit read actions through', async () => {
    const harness = makeGoverned('wiki');
    for (const action of [
      'list', 'read', 'search', 'semantic_search', 'wish_list', 'wish_read',
      'project_list', 'project_read', 'wardrobe_list', 'wardrobe_read',
    ]) {
      await expectPassThrough(harness, { action, id: 'doc-1', query: 'q' });
    }
    expect(harness.audit).not.toHaveBeenCalled();
  });

  it.each(MUTATIONS)('denies the %s mutation from a subagent context', async (action) => {
    const harness = makeGoverned('wiki');
    await expectDenied(harness, { action, title: 't', body: 'b' }, {
      action,
      reason: 'mutation_not_permitted',
    });
  });

  it('keeps the omitted-action read defaults working (list/read/search inference)', async () => {
    const harness = makeGoverned('wiki');
    await expectPassThrough(harness, {});
    await expectPassThrough(harness, { id: 'doc-1' });
    await expectPassThrough(harness, { query: 'garden' });
  });

  it('denies an omitted action carrying write fields (fail closed)', async () => {
    const harness = makeGoverned('wiki');
    await expectDenied(harness, { title: 'New page', body: 'content' }, {
      action: 'unknown',
      reason: 'action_unresolved',
    });
  });
});

describe('governed skill tool', () => {
  it('passes reads (including retired aliases) through', async () => {
    const harness = makeGoverned('skill');
    for (const action of ['list', 'skill_list', 'view', 'skill_view', 'stats', 'skill_stats']) {
      await expectPassThrough(harness, { action, name: 'writing' });
    }
  });

  it.each(['create', 'skill_create', 'update', 'skill_update'])(
    'denies the %s self-modification action',
    async (action) => {
      const harness = makeGoverned('skill');
      await expectDenied(harness, { action, name: 'writing', category: 'c', content: 'x' }, {
        action,
        reason: 'mutation_not_permitted',
      });
    },
  );

  it('keeps the omitted-action list default working and fails closed otherwise', async () => {
    const harness = makeGoverned('skill');
    await expectPassThrough(harness, {});
    await expectPassThrough(harness, { includeSkipped: false, includeContent: true });
    await expectDenied(harness, { name: 'writing', content: 'x' }, {
      action: 'unknown',
      reason: 'action_unresolved',
    });
  });
});

describe('governed vault tool', () => {
  it('passes reads through, including daily without content', async () => {
    const harness = makeGoverned('vault');
    await expectPassThrough(harness, { action: 'read', name: 'note' });
    await expectPassThrough(harness, { action: 'vault_read', name: 'note' });
    await expectPassThrough(harness, { action: 'search', query: 'q' });
    await expectPassThrough(harness, { action: 'daily' });
    await expectPassThrough(harness, { action: 'vault_daily' });
  });

  it('denies write and daily-with-content mutations', async () => {
    const harness = makeGoverned('vault');
    await expectDenied(harness, { action: 'write', name: 'note', content: 'x' }, {
      action: 'write',
      reason: 'mutation_not_permitted',
    });
    await expectDenied(harness, { action: 'vault_write', name: 'note', content: 'x' }, {
      action: 'vault_write',
      reason: 'mutation_not_permitted',
    });
    await expectDenied(harness, { action: 'daily', content: 'append this' }, {
      action: 'daily',
      reason: 'mutation_not_permitted',
    });
  });

  it('classifies the omitted-action inference fail closed', async () => {
    const harness = makeGoverned('vault');
    // Read-shaped inferences keep working.
    await expectPassThrough(harness, { query: 'q' });
    await expectPassThrough(harness, { name: 'note' });
    // Write-shaped inferences are mutations.
    await expectDenied(harness, { name: 'note', content: 'x' }, {
      action: 'write',
      reason: 'mutation_not_permitted',
    });
    await expectDenied(harness, { content: 'daily append' }, {
      action: 'daily',
      reason: 'mutation_not_permitted',
    });
    // Ambiguous calls resolve to nothing and are denied.
    await expectDenied(harness, { folder: 'notes' }, {
      action: 'unknown',
      reason: 'action_unresolved',
    });
  });
});

describe('governance policy map', () => {
  it('covers exactly the core-authoritative multiplexed surfaces', () => {
    expect([...GOVERNED_SUBAGENT_TOOL_POLICIES.keys()].sort()).toEqual([
      'journal', 'orient', 'skill', 'vault', 'wiki',
    ]);
    // scratchpad is deliberately ungoverned: bounded 24h ephemeral working
    // memory (c7d review disposition).
    expect(GOVERNED_SUBAGENT_TOOL_POLICIES.has('scratchpad')).toBe(false);
  });
});
