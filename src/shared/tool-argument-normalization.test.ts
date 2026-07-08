import { describe, expect, it } from 'vitest';
import { normalizeToolArguments } from './tool-argument-normalization.js';

describe('normalizeToolArguments', () => {
  it('normalizes memory arguments through the canonical unified memory surface', () => {
    expect(normalizeToolArguments('memory', {
      action: 'write',
      content: 'Remember the canonical surface.',
      type: 'semantic',
    })).toMatchObject({
      action: 'write',
      text: 'Remember the canonical surface.',
      type: 'semantic',
    });

    expect(normalizeToolArguments('memory', {
      action: 'patch',
      id: 'mem-1',
      reason: 'corrected',
    })).toMatchObject({
      action: 'patch',
      memory_id: 'mem-1',
      reason: 'corrected',
    });

    expect(normalizeToolArguments('memory', {
      action: 'restore',
      id: 'delete-1',
    })).toMatchObject({
      action: 'restore',
      delete_id: 'delete-1',
    });
  });

  it('does not normalize retired memory split aliases as live callable surfaces', () => {
    const patchArgs = { id: 'mem-1', reason: 'legacy alias' };
    expect(normalizeToolArguments('memory_patch', patchArgs)).toEqual(patchArgs);

    const restoreArgs = { id: 'delete-1' };
    expect(normalizeToolArguments('undo_memory_delete', restoreArgs)).toEqual(restoreArgs);
  });
});
