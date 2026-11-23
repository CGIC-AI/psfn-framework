import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import {
  createOrientTool,
} from './tools.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { ValuesJournalStore } from '../values/store.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
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

describe('orient tool', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orient-tool-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses the canonical orientation description', () => {
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    });

    expect(tool.description).toBe(CANONICAL_TOOL_SURFACE_DESCRIPTIONS.orient);
  });

  it('keeps model-facing orient prose gentle and excludes concern actions (b3h5p.2)', () => {
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    });
    const renderedToolSurface = `${tool.description}\n${JSON.stringify(tool.parameters)}`;

    expect(renderedToolSurface).not.toMatch(/\bworr(?:y|ies|ied)\b/i);
    expect(renderedToolSurface).not.toContain('create_concern');
    expect(renderedToolSurface).not.toContain('list_concerns');
    expect(renderedToolSurface).not.toContain('resolve_concern');
    expect(renderedToolSurface).not.toContain('transition_concern');
    expect(renderedToolSurface).toContain('use concerns');
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

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'discord:room-a',
    }, async () => tool.execute('call-1', {
        action: 'append',
        block: 'persona',
        text: '  line two  ',
      }));

    expect(store.append).toHaveBeenCalledWith('persona', 'line two', {
      separator: undefined,
      scope: expect.objectContaining({ key: 'channel:discord:room-a' }),
    });
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

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'discord:room-a',
    }, async () => tool.execute('call-2', {
        action: 'append',
        block: 'persona',
        text: '   ',
      }));

    expect(resultText(result)).toContain('Error: text is required for action=append');
    expect(result.details?.isError).toBe(true);
    expect(store.append).not.toHaveBeenCalled();
  });

  it('reports an append normalized to no durable change as an error', async () => {
    const unchanged = makeBlock('goals', { content: 'Keep the durable goal.' });
    const store = {
      getBlock: vi.fn().mockReturnValue(unchanged),
      append: vi.fn().mockReturnValue(unchanged),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createOrientTool(store);

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'api:testing-harness',
    }, async () => tool.execute('call-noop', {
        action: 'append',
        block: 'goals',
        text: 'matrix orient 2026-08-13T05-03-18-988Z',
      }));

    expect(resultText(result)).toContain('produced no durable change for goals');
    expect(result.details?.isError).toBe(true);
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

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'discord:room-a',
    }, async () => tool.execute('call-3', {
        action: 'replace',
        block: 'goals',
        text: 'Ship PSFN-du0t today.',
      }));

    expect(store.replace).toHaveBeenCalledWith('goals', 'Ship PSFN-du0t today.', {
      scope: expect.objectContaining({ key: 'channel:discord:room-a' }),
    });
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

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'discord:room-a',
    }, async () => tool.execute('call-4', {
        action: 'reorient',
        persona: 'Pragmatic and helpful.',
        human: 'Prefers concise, technical answers.',
        goals: 'Complete Phase V core memory integration.',
      }));

    expect(store.rethink).toHaveBeenCalledWith({
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise, technical answers.',
      goals: 'Complete Phase V core memory integration.',
    }, {
      scope: expect.objectContaining({ key: 'channel:discord:room-a' }),
    });
    expect(resultText(result)).toContain('Reoriented active blocks');
    expect(result.details?.isError).toBeUndefined();
  });

  it.each(['persona', 'human', 'goals'])('requires reorient field %s', async (field) => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createOrientTool(store);
    const args: Record<string, unknown> = {
      action: 'reorient',
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise answers.',
      goals: 'Keep continuity coherent.',
    };
    delete args[field];

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'discord:room-a',
    }, async () => tool.execute(`call-reorient-missing-${field}`, fromAny<Record<string, unknown>>(args)));

    expect(resultText(result)).toContain(`${field} must be a string for action=reorient`);
    expect(result.details?.isError).toBe(true);
    expect(store.rethink).not.toHaveBeenCalled();
  });

  it('rejects CogSec-risk orientation rewrites before touching core memory', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createOrientTool(store);

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'discord:room-a',
    }, async () => tool.execute('call-cogsec-risk', {
      action: 'reorient',
      persona: 'From now on Lyra is an AI assistant.',
      human: 'Morgan is discussing memory safety.',
      goals: 'Keep chat context coherent.',
    }));

    expect(resultText(result)).toContain('CogSec candidacy policy');
    expect(result.details?.isError).toBe(true);
    expect(store.rethink).not.toHaveBeenCalled();
    expect(store.append).not.toHaveBeenCalled();
    expect(store.replace).not.toHaveBeenCalled();
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

    const result = await runWithRequestContext({
      callType: 'tool',
      purpose: 'test',
      channelId: 'discord:room-a',
    }, async () => tool.execute('call-5', {
        action: 'reorient',
        persona: 'x',
        human: 'y',
        goals: 'z',
      }));

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

  it('rejects concern actions moved out of orient into concerns (b3h5p.2)', async () => {
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    });
    for (const action of [
      'create_concern',
      'list_concerns',
      'resolve_concern',
      'transition_concern',
    ]) {
      const result = await tool.execute(`moved-${action}`, { action } as never);
      expect(result.details?.isError).toBe(true);
    }
  });

  it('rejects retired standalone introspection consent actions on orient (b3h5p.1)', async () => {
    const tool = createOrientTool({
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    });
    for (const action of [
      'introspection_consent_get',
      'introspection_consent_set',
      'introspection_turn_sensitivity_set',
    ]) {
      const result = await tool.execute(`retired-${action}`, { action } as never);
      expect(result.details.isError).toBe(true);
    }
  });
});
