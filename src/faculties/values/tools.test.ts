import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@mariozechner/pi-ai';
import { ValuesJournalStore } from './store.js';
import { createOrientTool } from '../core-memory/tools.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((part): part is TextContent => part.type === 'text')
    .map(part => part.text)
    .join('');
}

describe('orient values actions', () => {
  let tempDir: string;
  let store: ValuesJournalStore;

  function makeTool(): ReturnType<typeof createOrientTool> {
    const unusedCoreMemoryStore = {
      append: () => {
        throw new Error('core-memory store must not be touched by values actions');
      },
      replace: () => {
        throw new Error('core-memory store must not be touched by values actions');
      },
      rethink: () => {
        throw new Error('core-memory store must not be touched by values actions');
      },
    };
    return createOrientTool(unusedCoreMemoryStore, { valuesJournal: store });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'values-tools-'));
    store = new ValuesJournalStore(join(tempDir, 'notes', 'values.jsonl'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('values_add appends a manual values journal entry', async () => {
    const tool = makeTool();
    const result = await tool.execute('add-1', {
      action: 'values_add',
      value: 'Protect trust continuity across sessions.',
      context: 'Manual correction after an off-tone response.',
    });
    const payload = JSON.parse(resultText(result)) as {
      action: string;
      mode: string;
      entry: { templateId: string; templateName: string; reflection: string; prompt: string; version: number };
    };

    expect(result.details.isError).toBeUndefined();
    expect(payload.action).toBe('added');
    expect(payload.mode).toBe('append_only');
    expect(payload.entry.templateId).toBe('values-tool');
    expect(payload.entry.templateName).toBe('Values Tool');
    expect(payload.entry.reflection).toBe('Protect trust continuity across sessions.');
    expect(payload.entry.prompt).toBe('Manual correction after an off-tone response.');
    expect(payload.entry.version).toBe(1);
  });

  it('values_add fails closed on blank value', async () => {
    const tool = makeTool();
    const result = await tool.execute('add-blank', {
      action: 'values_add',
      value: '   ',
    });

    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('values_add failed');
    expect(store.list()).toHaveLength(0);
  });

  it('values_list returns newest-first entries and enforces explicit limit', async () => {
    store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P1',
      reflection: 'R1',
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    store.append({
      templateId: 'values-reflection',
      templateName: 'Values Reflection',
      prompt: 'P2',
      reflection: 'R2',
      createdAt: '2026-03-01T01:00:00.000Z',
    });

    const tool = makeTool();
    const limitedResult = await tool.execute('list-1', { action: 'values_list', limit: 1 });
    const limitedPayload = JSON.parse(resultText(limitedResult)) as {
      limit: number;
      count: number;
      entries: Array<{ version: number }>;
    };
    expect(limitedPayload.limit).toBe(1);
    expect(limitedPayload.count).toBe(1);
    expect(limitedPayload.entries[0]?.version).toBe(2);

    const invalidResult = await tool.execute('list-invalid', { action: 'values_list', limit: 0 });
    expect(invalidResult.details.isError).toBe(true);
    expect(resultText(invalidResult)).toContain('values_list failed');
  });

  it('values_update appends a revision entry for an existing version', async () => {
    const tool = makeTool();
    await tool.execute('seed-add', {
      action: 'values_add',
      value: 'Speak directly when uncertain.',
      context: 'Initial value.',
    });

    const result = await tool.execute('update-1', {
      action: 'values_update',
      version: 1,
      value: 'Speak directly and cite uncertainty explicitly.',
      context: 'Refined wording after reflection.',
    });
    const payload = JSON.parse(resultText(result)) as {
      action: string;
      mode: string;
      source: { version: number; id: string };
      entry: { version: number; templateId: string; reflection: string };
    };

    expect(payload.action).toBe('updated');
    expect(payload.mode).toBe('append_only_revision');
    expect(payload.source.version).toBe(1);
    expect(payload.source.id).toBe('values-1');
    expect(payload.entry.version).toBe(2);
    expect(payload.entry.templateId).toBe('values-tool-update');
    expect(payload.entry.reflection).toBe('Speak directly and cite uncertainty explicitly.');
  });

  it('values_update fails closed for unknown source version', async () => {
    const tool = makeTool();
    const result = await tool.execute('update-missing', {
      action: 'values_update',
      version: 99,
      value: 'Should not persist.',
    });

    expect(result.details.isError).toBe(true);
    expect(resultText(result)).toContain('version 99 not found');
    expect(store.list()).toHaveLength(0);
  });
});

describe('values docs parity', () => {
  it('documents orient as the only direct values surface', () => {
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf-8');
    const valuesRow = readme.split('\n').find(line => line.includes('| **Values** |'));

    expect(valuesRow).toBeDefined();
    const tools = [...(valuesRow ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]);
    expect(tools).toEqual(['orient action=values_list|values_add|values_update']);
  });
});
