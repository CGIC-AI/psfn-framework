import { describe, expect, it } from 'vitest';
import {
  buildCogSecTombstoneContent,
  buildCogSecTombstoneMetadata,
} from '../../../core/cogsec/tombstones.js';
import { buildCogSecTombstoneDiagnostics } from './cogsec-operations.js';
import type { SessionEntry } from '../../../core/session/types.js';

function message(id: number, content: string, metadata?: string): SessionEntry {
  return {
    id,
    type: 'message',
    channelId: 'ch:1',
    role: 'user',
    content,
    timestamp: id * 1000,
    metadata,
  };
}

describe('buildCogSecTombstoneDiagnostics', () => {
  it('aggregates tombstoned rows by case and channel', () => {
    const caseA = buildCogSecTombstoneContent('cogsec_case_a');
    const metaA = buildCogSecTombstoneMetadata({ caseId: 'cogsec_case_a', redactedAt: new Date(1).toISOString() });
    const caseB = buildCogSecTombstoneContent('cogsec_case_b');

    const entries: SessionEntry[] = [
      message(1, 'visible'),
      message(2, caseA, metaA),
      message(3, caseA, metaA),
      message(4, caseB),
    ];

    const diagnostics = buildCogSecTombstoneDiagnostics([
      { channelId: 'ch:1', entries },
      { channelId: 'ch:2', entries: [message(5, caseA, metaA)] },
    ]);

    expect(diagnostics).toHaveLength(2);
    const a = diagnostics.find(d => d.caseId === 'cogsec_case_a')!;
    expect(a.rowCount).toBe(3);
    expect(a.channels).toEqual([
      { channelId: 'ch:1', messageIds: [2, 3], rowCount: 2 },
      { channelId: 'ch:2', messageIds: [5], rowCount: 1 },
    ]);
    const b = diagnostics.find(d => d.caseId === 'cogsec_case_b')!;
    expect(b.rowCount).toBe(1);
  });

  it('returns an empty array when no tombstones exist', () => {
    expect(buildCogSecTombstoneDiagnostics([
      { channelId: 'ch:1', entries: [message(1, 'visible')] },
    ])).toEqual([]);
  });
});
