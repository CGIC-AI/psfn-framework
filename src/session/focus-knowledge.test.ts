import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FocusKnowledgeStore } from './focus-knowledge.js';

describe('FocusKnowledgeStore project contexts', () => {
  let dir: string;
  let store: FocusKnowledgeStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-focus-knowledge-'));
    store = new FocusKnowledgeStore(join(dir, 'focus-knowledge.jsonl'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('groups repeated scope blocks into a single project context summary', () => {
    store.append({
      channelId: 'api:project',
      focusId: 'focus-1',
      scope: 'Memory Improvement',
      knowledge: 'Initial findings captured.',
      startedAt: 1_000,
      completedAt: 2_000,
      evidenceCount: 2,
    });
    store.append({
      channelId: 'api:project',
      focusId: 'focus-2',
      scope: 'memory improvement',
      knowledge: 'Follow-up findings superseded the initial notes.',
      startedAt: 3_000,
      completedAt: 4_000,
      evidenceCount: 3,
    });
    store.append({
      channelId: 'api:project',
      focusId: 'focus-3',
      scope: 'Other scope',
      knowledge: 'Independent project context.',
      startedAt: 5_000,
      completedAt: 6_000,
      evidenceCount: 1,
    });

    const summaries = store.listProjectContextsByChannel('api:project', { limit: 10 });
    expect(summaries).toHaveLength(2);

    const memoryImprovement = store.getProjectContextSummary('api:project', 'MEMORY IMPROVEMENT');
    expect(memoryImprovement).toBeDefined();
    expect(memoryImprovement?.scope).toBe('memory improvement');
    expect(memoryImprovement?.knowledgeBlockCount).toBe(2);
    expect(memoryImprovement?.totalEvidenceCount).toBe(5);
    expect(memoryImprovement?.latestKnowledge).toContain('superseded');
  });
});
