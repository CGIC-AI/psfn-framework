import { describe, expect, it } from 'vitest';

import {
  AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
  AUTOMATA_BUS_RELATIONS_FEATURE,
} from './contract.js';
import type { AutomataBusSqlPool } from './postgres-store.js';
import { PostgresAutomataLessonSource } from './postgres-lesson-source.js';

function event(input: { eventId: string; lessonCode?: string; replacement?: boolean }) {
  const body = {
    claim: 'private transcript-derived content must never enter the lesson projection',
    provenance: 'computed',
    evidence: [{ kind: 'artifact', reference: 'file:///private/transcript', summary: 'private evidence' }],
    verification: { status: 'verified', by: 'reviewer', evidenceRefs: ['file:///private/transcript'] },
    ...(input.lessonCode ? {
      lessonAttribution: {
        promptRevision: 'sha256:prompt-r1',
        toolName: 'repo',
        failureCategory: 'missing-instruction',
        lessonCode: input.lessonCode,
        contradictionEventIds: ['finding-opposite'],
      },
    } : {}),
  };
  return {
    schemaVersion: 1,
    eventId: input.eventId,
    companionId: 'companion-a',
    sequence: input.replacement ? 2 : 1,
    occurredAt: input.replacement ? '2026-08-12T02:00:00.000Z' : '2026-08-12T01:00:00.000Z',
    mustUnderstand: [
      ...(input.replacement ? [AUTOMATA_BUS_RELATIONS_FEATURE] : []),
      ...(input.lessonCode ? [AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE] : []),
    ],
    context: {
      automatonClass: 'subagent.bounded', runId: 'run-1', taskId: 'task-1',
      sessionIds: ['private-session'], artifactRefs: ['file:///private/transcript'],
    },
    type: input.replacement ? 'relation' : 'finding',
    body: input.replacement
      ? { targetEventId: 'finding-old', relation: 'corrects', reason: 'corrected', replacement: body }
      : body,
  };
}

describe('PostgresAutomataLessonSource', () => {
  it('reads attributed current rows only and returns explicit metadata without content', async () => {
    const query = async () => ({
      rows: [
        { audiences: ['operator'], sensitivity: 'personal', event_json: event({ eventId: 'finding-current', lessonCode: 'read-before-edit' }) },
        { audiences: ['operator'], sensitivity: 'personal', event_json: event({ eventId: 'finding-unattributed' }) },
      ],
      rowCount: 2,
    });
    const source = new PostgresAutomataLessonSource({
      pool: { query } as AutomataBusSqlPool,
      companionId: 'companion-a',
    });

    const rows = await source.listCurrent({
      companionId: 'companion-a', audience: 'operator', maxSensitivity: 'personal',
    });

    expect(rows).toEqual([expect.objectContaining({
      eventId: 'finding-current',
      automatonClass: 'subagent.bounded',
      promptRevision: 'sha256:prompt-r1',
      toolName: 'repo',
      failureCategory: 'missing-instruction',
      lessonCode: 'read-before-edit',
      evidenceRefs: ['file:///private/transcript'],
      contradictionEventIds: ['finding-opposite'],
    })]);
    expect(JSON.stringify(rows)).not.toContain('private transcript-derived content');
    expect(JSON.stringify(rows)).not.toContain('private evidence');
    expect(JSON.stringify(rows)).not.toContain('private-session');
  });

  it('uses correction-aware current rows and fails scope violations closed', async () => {
    const query = async () => ({
      rows: [{
        audiences: ['operator'], sensitivity: 'confidential',
        event_json: event({ eventId: 'finding-correction', lessonCode: 'corrected-path', replacement: true }),
      }],
      rowCount: 1,
    });
    const source = new PostgresAutomataLessonSource({
      pool: { query } as AutomataBusSqlPool,
      companionId: 'companion-a',
    });

    await expect(source.listCurrent({
      companionId: 'companion-a', audience: 'operator', maxSensitivity: 'personal',
    })).rejects.toThrow(/outside.*sensitivity/);
    await expect(source.listCurrent({
      companionId: 'companion-other', audience: 'operator', maxSensitivity: 'confidential',
    })).rejects.toThrow(/scope mismatch/);
    await expect(source.listCurrent({
      companionId: 'companion-a', audience: 'operator', maxSensitivity: 'confidential',
    })).resolves.toEqual([expect.objectContaining({
      eventId: 'finding-correction',
      lessonCode: 'corrected-path',
    })]);
  });

  it('rejects duplicate persisted audience authority instead of normalizing it', async () => {
    const source = new PostgresAutomataLessonSource({
      pool: {
        query: async () => ({
          rows: [{
            audiences: ['operator', 'operator'],
            sensitivity: 'personal',
            event_json: event({ eventId: 'finding-duplicate-scope', lessonCode: 'scoped' }),
          }],
          rowCount: 1,
        }),
      } as AutomataBusSqlPool,
      companionId: 'companion-a',
    });

    await expect(source.listCurrent({
      companionId: 'companion-a', audience: 'operator', maxSensitivity: 'personal',
    })).rejects.toThrow(/audiences contain duplicates/u);
  });
});
