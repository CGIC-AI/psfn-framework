import { describe, expect, it, vi } from 'vitest';
import { createBeadsTool } from './tools.js';
import type { BeadsOperations } from './ops.js';

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

describe('createBeadsTool', () => {
  it('routes ready-style reads without an explicit action', async () => {
    const ops = createMockOps();
    const tool = createBeadsTool(ops);

    await tool.execute('call-1', { actor: 'agent-main' });

    expect(ops.ready).toHaveBeenCalledWith({ actor: 'agent-main' });
  });

  it('accepts legacy issue_* aliases and preserves dispatch', async () => {
    const ops = createMockOps();
    const tool = createBeadsTool(ops);

    await tool.execute('call-2', { action: 'issue_show', id: 'PSFN-9' });
    await tool.execute('call-3', { action: 'issue_create', title: 'Refactor beads surface' });
    await tool.execute('call-4', { action: 'issue_update', id: 'PSFN-9', status: 'in_progress' });
    await tool.execute('call-5', { action: 'issue_close', id: 'PSFN-9', reason: 'done' });
    await tool.execute('call-6', { action: 'issue_sync', actor: 'agent-main' });

    expect(ops.show).toHaveBeenCalledWith({ id: 'PSFN-9', actor: undefined });
    expect(ops.create).toHaveBeenCalledWith({
      title: 'Refactor beads surface',
      issueType: undefined,
      priority: undefined,
      deps: undefined,
      parent: undefined,
      actor: undefined,
    });
    expect(ops.update).toHaveBeenCalledWith({
      id: 'PSFN-9',
      status: 'in_progress',
      priority: undefined,
      actor: undefined,
    });
    expect(ops.close).toHaveBeenCalledWith({ id: 'PSFN-9', reason: 'done', actor: undefined });
    expect(ops.sync).toHaveBeenCalledWith({ actor: 'agent-main' });
  });

  it('infers create, update, close, and show from unambiguous params', async () => {
    const ops = createMockOps();
    const tool = createBeadsTool(ops);

    await tool.execute('call-create', { title: 'Create task', priority: 2 });
    await tool.execute('call-update', { id: 'PSFN-11', priority: 1 });
    await tool.execute('call-close', { id: 'PSFN-12', reason: 'Completed' });
    await tool.execute('call-show', { id: 'PSFN-13' });

    expect(ops.create).toHaveBeenCalledWith({
      title: 'Create task',
      issueType: undefined,
      priority: 2,
      deps: undefined,
      parent: undefined,
      actor: undefined,
    });
    expect(ops.update).toHaveBeenCalledWith({
      id: 'PSFN-11',
      status: undefined,
      priority: 1,
      actor: undefined,
    });
    expect(ops.close).toHaveBeenCalledWith({ id: 'PSFN-12', reason: 'Completed', actor: undefined });
    expect(ops.show).toHaveBeenCalledWith({ id: 'PSFN-13', actor: undefined });
  });

  it('fails closed for ambiguous calls', async () => {
    const ops = createMockOps();
    const tool = createBeadsTool(ops);

    const result = await tool.execute('call-ambiguous', { id: 'PSFN-14', title: 'ambiguous' });

    expect((result.content[0] as { text: string }).text).toContain('action is required');
    expect(ops.ready).not.toHaveBeenCalled();
    expect(ops.show).not.toHaveBeenCalled();
    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.update).not.toHaveBeenCalled();
    expect(ops.close).not.toHaveBeenCalled();
    expect(ops.sync).not.toHaveBeenCalled();
  });
});
