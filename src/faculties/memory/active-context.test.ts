import { describe, expect, it } from 'vitest';
import { resolveActiveMemoryContextIdentity } from './active-context.js';

describe('active memory context identity', () => {
  it('separates casual and task retrieval contexts', () => {
    const base = {
      contextText: 'same prompt',
      channelId: 'api:test',
    };
    const casual = resolveActiveMemoryContextIdentity({
      ...base,
      turnBudgetCharacteristics: { taskKind: 'chat' },
    });
    const task = resolveActiveMemoryContextIdentity({
      ...base,
      turnBudgetCharacteristics: { taskKind: 'maintenance' },
    });

    expect(casual.key).toContain('taskKind:chat');
    expect(task.key).toContain('taskKind:maintenance');
    expect(task.key).not.toBe(casual.key);
  });
});
