import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOrientTool,
} from './tools.js';
import type { ActiveConcern } from '../../core/intention/concerns.js';
import type { ConcernStorePort } from '../../core/intention/concern-store-port.js';
import { ValuesJournalStore } from '../values/store.js';
import type {
  CoreMemoryAppendOptions,
  CoreMemoryBlock,
  CoreMemoryLabel,
  CoreMemoryRethinkInput,
  CoreMemorySnapshot,
} from './store.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(entry => entry.text).join('');
}

function makeBlock(label: CoreMemoryLabel, overrides: Partial<CoreMemoryBlock> = {}): CoreMemoryBlock {
  return {
    label,
    content: '',
    maxChars: label === 'goals' ? 1600 : 2400,
    ...(label === 'human' ? { trustLevel: 'trusted' } : {}),
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<CoreMemorySnapshot>): CoreMemorySnapshot {
  return {
    version: 1,
    updatedAt: '2026-03-05T00:00:00.000Z',
    blocks: {
      persona: makeBlock('persona'),
      human: makeBlock('human'),
      goals: makeBlock('goals'),
    },
    ...overrides,
  };
}

function createFakeConcernStore(): ConcernStorePort {
  const concerns = new Map<string, ActiveConcern>();
  let nextId = 1;

  return {
    create: vi.fn(async (input) => {
      const now = new Date().toISOString();
      const concern: ActiveConcern = {
        id: `concern-${nextId++}`,
        text: input.text,
        priority: input.priority ?? 'medium',
        source: input.source ?? 'agent',
        createdAt: input.createdAt ?? now,
        expiresAt: input.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ...(input.contactId ? { contactId: input.contactId } : {}),
        ...(input.formationVAD ? { formationVAD: input.formationVAD } : {}),
      };
      concerns.set(concern.id, concern);
      return { ...concern };
    }),
    getById: vi.fn(async (id) => {
      const concern = concerns.get(id);
      return concern ? { ...concern } : null;
    }),
    getActiveConcerns: vi.fn(async (contactId) => (
      [...concerns.values()]
        .filter(concern => !concern.resolvedAt && (!contactId || concern.contactId === contactId))
        .map(concern => ({ ...concern }))
    )),
    list: vi.fn(async (options = {}) => (
      [...concerns.values()]
        .filter((concern) => {
          if (options.contactId && concern.contactId !== options.contactId) return false;
          if (!options.includeResolved && concern.resolvedAt) return false;
          return true;
        })
        .slice(0, options.limit ?? 32)
        .map(concern => ({ ...concern }))
    )),
    listRecentlyResolvedConcerns: vi.fn(async () => []),
    findRecentlyResolvedSimilarConcern: vi.fn(async () => null),
    resolveConcern: vi.fn(async (id, options = {}) => {
      const concern = concerns.get(id);
      if (!concern || concern.resolvedAt) return null;
      const resolved: ActiveConcern = {
        ...concern,
        resolvedAt: options.resolvedAt ?? new Date().toISOString(),
        ...(options.outcome ? { resolutionOutcome: options.outcome } : {}),
      };
      concerns.set(id, resolved);
      return { ...resolved };
    }),
  };
}

describe('orient tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orient-tool-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends to the requested orientation block', async () => {
    const store = {
      append: vi.fn<(
        label: CoreMemoryLabel,
        appendText: string,
        options?: CoreMemoryAppendOptions,
      ) => CoreMemoryBlock>().mockReturnValue(
        makeBlock('persona', { content: 'line one\nline two' }),
      ),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createOrientTool(store);

    const result = await tool.execute('call-1', {
      action: 'append',
      block: 'persona',
      text: '  line two  ',
    });

    expect(store.append).toHaveBeenCalledWith('persona', 'line two', { separator: undefined });
    expect(resultText(result)).toContain('Appended to persona orientation');
    expect(result.details?.isError).toBeUndefined();
  });

  it('rejects empty append text', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createOrientTool(store);

    const result = await tool.execute('call-2', {
      action: 'append',
      block: 'persona',
      text: '   ',
    });

    expect(resultText(result)).toContain('Error: text is required for action=append');
    expect(result.details?.isError).toBe(true);
    expect(store.append).not.toHaveBeenCalled();
  });

  it('replaces one orientation block', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn<(
        label: CoreMemoryLabel,
        content: string,
      ) => CoreMemoryBlock>().mockReturnValue(
        makeBlock('goals', { content: 'Ship PSFN-du0t today.' }),
      ),
      rethink: vi.fn(),
    };
    const tool = createOrientTool(store);

    const result = await tool.execute('call-3', {
      action: 'replace',
      block: 'goals',
      text: 'Ship PSFN-du0t today.',
    });

    expect(store.replace).toHaveBeenCalledWith('goals', 'Ship PSFN-du0t today.');
    expect(resultText(result)).toContain('Replaced goals orientation');
    expect(result.details?.isError).toBeUndefined();
  });

  it('reorients all three blocks at once', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn<(input: CoreMemoryRethinkInput) => CoreMemorySnapshot>().mockReturnValue(
        makeSnapshot({
          blocks: {
            persona: makeBlock('persona', { content: 'Pragmatic and helpful.' }),
            human: makeBlock('human', { content: 'Prefers concise, technical answers.' }),
            goals: makeBlock('goals', { content: 'Complete Phase V core memory integration.' }),
          },
        }),
      ),
    };
    const tool = createOrientTool(store);

    const result = await tool.execute('call-4', {
      action: 'reorient',
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise, technical answers.',
      goals: 'Complete Phase V core memory integration.',
    });

    expect(store.rethink).toHaveBeenCalledWith({
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise, technical answers.',
      goals: 'Complete Phase V core memory integration.',
    });
    expect(resultText(result)).toContain('Reoriented active blocks');
    expect(result.details?.isError).toBeUndefined();
  });

  it('returns an error payload when orientation update fails', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn().mockImplementation(() => {
        throw new Error('disk full');
      }),
    };
    const tool = createOrientTool(store);

    const result = await tool.execute('call-5', {
      action: 'reorient',
      persona: 'x',
      human: 'y',
      goals: 'z',
    });

    expect(resultText(result)).toContain('Error updating orientation');
    expect(resultText(result)).toContain('disk full');
    expect(result.details?.isError).toBe(true);
  });

  it('routes values_list through orient when values support is wired', async () => {
    const valuesJournal = new ValuesJournalStore(join(tempDir, 'notes', 'values.jsonl'));
    valuesJournal.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P1',
      reflection: 'R1',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    valuesJournal.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P2',
      reflection: 'R2',
      createdAt: '2026-03-01T01:00:00.000Z',
    });
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    }, {
      valuesJournal,
    });

    const result = await tool.execute('call-values-list', {
      action: 'values_list',
      limit: 1,
    });
    const payload = JSON.parse(resultText(result)) as {
      limit: number;
      count: number;
      entries: Array<{ version: number }>;
    };

    expect(payload.limit).toBe(1);
    expect(payload.count).toBe(1);
    expect(payload.entries[0]?.version).toBe(2);
  });

  it('routes values_add and values_update through orient when values support is wired', async () => {
    const valuesJournal = new ValuesJournalStore(join(tempDir, 'notes', 'values.jsonl'));
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    }, {
      valuesJournal,
    });

    const added = await tool.execute('call-values-add', {
      action: 'values_add',
      value: 'Protect trust continuity across sessions.',
      context: 'Manual correction after an off-tone response.',
    });
    const addedPayload = JSON.parse(resultText(added)) as {
      action: string;
      entry: { version: number; templateId: string; reflection: string; provenance?: { source?: string } };
    };
    expect(addedPayload.action).toBe('added');
    expect(addedPayload.entry.version).toBe(1);
    expect(addedPayload.entry.templateId).toBe('values-tool');
    expect(addedPayload.entry.reflection).toBe('Protect trust continuity across sessions.');
    expect(addedPayload.entry.provenance?.source).toBe('values_add_tool');

    const updated = await tool.execute('call-values-update', {
      action: 'values_update',
      version: 1,
      value: 'Protect trust continuity and cite uncertainty explicitly.',
      context: 'Append-only revision after reflection.',
    });
    const updatedPayload = JSON.parse(resultText(updated)) as {
      action: string;
      source: { version: number };
      entry: { version: number; templateId: string; reflection: string; provenance?: { source?: string } };
    };
    expect(updatedPayload.action).toBe('updated');
    expect(updatedPayload.source.version).toBe(1);
    expect(updatedPayload.entry.version).toBe(2);
    expect(updatedPayload.entry.templateId).toBe('values-tool-update');
    expect(updatedPayload.entry.reflection).toBe('Protect trust continuity and cite uncertainty explicitly.');
    expect(updatedPayload.entry.provenance?.source).toBe('values_update_tool');
  });

  it('fails closed for unknown orient values_update source versions', async () => {
    const valuesJournal = new ValuesJournalStore(join(tempDir, 'notes', 'values.jsonl'));
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    }, {
      valuesJournal,
    });

    const result = await tool.execute('call-values-update-missing', {
      action: 'values_update',
      version: 99,
      value: 'Should not persist.',
    });

    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('version 99 not found');
    expect(valuesJournal.list()).toHaveLength(0);
  });

  it('routes concern lifecycle actions through orient when concern support is wired', async () => {
    const concernStore = createFakeConcernStore();
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    }, {
      concernStore,
    });

    const createdResult = await tool.execute('call-concern-create', {
      action: 'create_concern',
      text: 'Follow up tomorrow.',
      priority: 'high',
      contactId: 'contact-a',
    });
    const createdPayload = JSON.parse(resultText(createdResult)) as {
      created: boolean;
      concern: { id: string; text: string; priority: string; contactId?: string };
    };
    expect(createdPayload.created).toBe(true);
    expect(createdPayload.concern.text).toBe('Follow up tomorrow.');

    const listedResult = await tool.execute('call-concern-list', {
      action: 'list_concerns',
      contactId: 'contact-a',
    });
    const listedPayload = JSON.parse(resultText(listedResult)) as {
      count: number;
      concerns: Array<{ id: string }>;
    };
    expect(listedPayload.count).toBe(1);
    expect(listedPayload.concerns[0]?.id).toBe(createdPayload.concern.id);

    const resolvedResult = await tool.execute('call-concern-resolve', {
      action: 'resolve_concern',
      concernId: createdPayload.concern.id,
      outcome: 'Handled in orient.',
    });
    const resolvedPayload = JSON.parse(resultText(resolvedResult)) as {
      resolved: number;
      missing: string[];
      concerns: Array<{ resolutionOutcome?: string }>;
    };
    expect(resolvedPayload.resolved).toBe(1);
    expect(resolvedPayload.missing).toEqual([]);
    expect(resolvedPayload.concerns[0]?.resolutionOutcome).toBe('Handled in orient.');
  });

  it('resolves multiple concerns in one orient action', async () => {
    const concernStore = createFakeConcernStore();
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    }, {
      concernStore,
    });

    const firstResult = await tool.execute('call-concern-create-1', {
      action: 'create_concern',
      text: 'Check in tonight.',
    });
    const secondResult = await tool.execute('call-concern-create-2', {
      action: 'create_concern',
      text: 'Ask about sleep tomorrow.',
    });
    const firstPayload = JSON.parse(resultText(firstResult)) as { concern: { id: string } };
    const secondPayload = JSON.parse(resultText(secondResult)) as { concern: { id: string } };

    const resolvedResult = await tool.execute('call-concern-resolve-many', {
      action: 'resolve_concern',
      concernIds: [firstPayload.concern.id, secondPayload.concern.id],
      outcome: 'Handled together.',
    });
    const payload = JSON.parse(resultText(resolvedResult)) as {
      resolved: number;
      missing: string[];
      concerns: Array<{ id: string; resolutionOutcome?: string }>;
    };

    expect(payload.resolved).toBe(2);
    expect(payload.missing).toEqual([]);
    expect(payload.concerns.map(concern => concern.id).sort()).toEqual(
      [firstPayload.concern.id, secondPayload.concern.id].sort(),
    );
    expect(payload.concerns.every(concern => concern.resolutionOutcome === 'Handled together.')).toBe(true);
  });

  it('returns an actionable error when resolving a concern without concernId through orient', async () => {
    const concernStore = createFakeConcernStore();
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    }, {
      concernStore,
    });

    const result = await tool.execute('call-concern-resolve-missing-id', {
      action: 'resolve_concern',
    });
    const payload = JSON.parse(resultText(result)) as {
      error: string;
      required: string;
      hint: string;
    };

    expect(result.details.isError).toBe(true);
    expect(payload.error).toBe('missing_required_parameter');
    expect(payload.required).toBe('concernId or concernIds');
    expect(payload.hint).toContain('concernId or concernIds');
    expect(payload.hint).toContain('Do not use tool_search');
  });
});
