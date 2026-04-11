import { describe, expect, it, vi } from 'vitest';
import type { BeadsOperations } from './ops.js';
import { createBeadsTool } from './tools.js';

function createMockOps(): BeadsOperations {
  return {
    ready: vi.fn().mockResolvedValue({ actor: 'agent', action: 'ready', target: null, result: 'ok', payload: [] }),
    show: vi.fn().mockResolvedValue({ actor: 'agent', action: 'show', target: 'PSFN-1', result: 'ok', payload: {} }),
    create: vi.fn().mockResolvedValue({ actor: 'agent', action: 'create', target: 'PSFN-2', result: 'ok', payload: {} }),
    update: vi.fn().mockResolvedValue({ actor: 'agent', action: 'update', target: 'PSFN-2', result: 'ok', payload: {} }),
    close: vi.fn().mockResolvedValue({ actor: 'agent', action: 'close', target: 'PSFN-2', result: 'ok', payload: {} }),
    sync: vi.fn().mockResolvedValue({ actor: 'agent', action: 'sync', target: null, result: 'ok', payload: {} }),
  };
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((entry) => entry.text).join('');
}

describe('beads tool', () => {
  it('routes ready reads through action=ready', async () => {
    const ops = createMockOps();
    const tool = createBeadsTool(ops);

    const result = await tool.execute('call-ready', { action: 'ready', actor: 'agent-main' });

    expect(ops.ready).toHaveBeenCalledWith({ actor: 'agent-main' });
    expect(JSON.parse(resultText(result))).toMatchObject({
      actor: 'agent',
      action: 'ready',
      result: 'ok',
    });
  });

  it('shows issue details through action=show and accepts legacy aliases', async () => {
    const ops = createMockOps();
    const tool = createBeadsTool(ops);

    await tool.execute('call-show', { action: 'issue_show', id: 'PSFN-9', actor: 'agent-main' });

    expect(ops.show).toHaveBeenCalledWith({ id: 'PSFN-9', actor: 'agent-main' });
  });

  it('creates, updates, and closes issues through the unified tool surface', async () => {
    const ops = createMockOps();
    const tool = createBeadsTool(ops);

    await tool.execute('call-create', {
      action: 'create',
      title: 'Refactor beads surface',
      issue_type: 'task',
      priority: 2,
      deps: ['discovered-from:PSFN-hkel.14'],
      parent: 'PSFN-hkel',
      actor: 'agent-main',
    });
    await tool.execute('call-update', {
      action: 'issue_update',
      id: 'PSFN-9',
      status: 'in_progress',
      priority: 1,
      actor: 'agent-main',
    });
    await tool.execute('call-close', {
      action: 'close',
      id: 'PSFN-9',
      reason: 'done',
      actor: 'agent-main',
    });

    expect(ops.create).toHaveBeenCalledWith({
      title: 'Refactor beads surface',
      issueType: 'task',
      priority: 2,
      deps: ['discovered-from:PSFN-hkel.14'],
      parent: 'PSFN-hkel',
      actor: 'agent-main',
    });
    expect(ops.update).toHaveBeenCalledWith({
      id: 'PSFN-9',
      status: 'in_progress',
      priority: 1,
      actor: 'agent-main',
    });
    expect(ops.close).toHaveBeenCalledWith({
      id: 'PSFN-9',
      reason: 'done',
      actor: 'agent-main',
    });
  });

  it('surfaces canonical sync failures', async () => {
    const ops = createMockOps();
    ops.sync = vi.fn().mockRejectedValue(new Error('bd unavailable'));
    const tool = createBeadsTool(ops);

    const result = await tool.execute('call-sync', { action: 'sync', actor: 'agent-main' });

    expect(resultText(result)).toContain('beads failed for action=sync: bd unavailable');
    expect(result.details?.isError).toBe(true);
  });
});
