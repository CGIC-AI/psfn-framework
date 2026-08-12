import { describe, expect, it } from 'vitest';
import {
  EXACT_SESSION_PURGE_SURFACE_ORDER,
  parseExactSessionPurgeSagaRecord,
  type ExactSessionPurgeSagaRecord,
} from '../../faculties/automata/production-exact-session-purge.js';
import {
  AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_RELATIONS,
  AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_SCHEMA_STATEMENTS,
} from './automata-exact-session-purge-store.js';

const saga: ExactSessionPurgeSagaRecord = {
  schemaVersion: 1,
  companionId: 'companion-a',
  sessionId: 'session-a',
  runId: 'run-a',
  targetRevision: 'revision-a',
  preserveReferences: ['artifact:a'],
  target: {
    classification: {
      schemaVersion: 1,
      companionId: 'companion-a',
      sessionId: 'session-a',
      ownership: 'automata',
      runId: 'run-a',
      automatonClass: 'subagent.bounded',
      workerGeneration: 1,
      classifiedAtMs: 1,
      retentionDeadlineMs: 2,
    },
    channelId: 'worker:session-a',
    tailChannelKey: 'session-a',
    turnRecordChannelId: 'worker:session-a',
    activeJournalFilename: 'session-a.jsonl',
    rolledJournalFilenames: [],
  },
  status: 'in_progress',
  revision: 1,
  surfaces: Object.fromEntries(EXACT_SESSION_PURGE_SURFACE_ORDER.map(surface => [surface, {
    status: 'not_started',
    attempts: 0,
    removedCount: 0,
    completion: null,
    lastErrorDigest: null,
  }])) as ExactSessionPurgeSagaRecord['surfaces'],
};

describe('exact-session purge Postgres saga', () => {
  it('strictly round-trips the durable restart payload', () => {
    expect(parseExactSessionPurgeSagaRecord(JSON.parse(JSON.stringify(saga)))).toEqual(saga);
    expect(() => parseExactSessionPurgeSagaRecord({ ...saga, futureField: true }))
      .toThrow('invalid shape');
    expect(() => parseExactSessionPurgeSagaRecord({
      ...saga,
      surfaces: { ...saga.surfaces, future_surface: saga.surfaces.journals },
    })).toThrow('invalid shape');
  });

  it('declares the companion-scoped six-surface recovery relation', () => {
    const sql = AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_SCHEMA_STATEMENTS.join('\n');
    expect(AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_RELATIONS)
      .toEqual(['automata_exact_session_purge_sagas']);
    expect(sql).toContain("WHERE saga_status = 'in_progress'");
    for (const surface of EXACT_SESSION_PURGE_SURFACE_ORDER) expect(sql).toContain(surface);
    expect(sql).not.toMatch(/raw_message|transcript_text|prompt_text|response_text/iu);
    expect(AUTOMATA_EXACT_SESSION_PURGE_POSTGRES_ROLLBACK_STATEMENTS)
      .toEqual(['DROP TABLE IF EXISTS automata_exact_session_purge_sagas']);
  });
});
