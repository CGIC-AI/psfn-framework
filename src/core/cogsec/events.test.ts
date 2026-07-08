import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CogSecEventStore } from './events.js';
import { resolveCogSecEventsPath } from '../../persistence/layout.js';

const TEST_HASH = `sha256:${'a'.repeat(64)}`;
const TEST_REF = 'cogsec-forensic://cogsec_20260701T000000Z_test/00000000-0000-4000-8000-000000000000.json';
const SAFE_SUMMARY = 'Unsafe instruction-like content was sealed and removed from active cognition.';

let tempRoot: string | null = null;

function makeTempRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'psfn-cogsec-events-'));
  return tempRoot;
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe('CogSecEventStore', () => {
  it('creates, persists, and reloads safe CogSec event metadata', () => {
    const root = makeTempRoot();
    const path = resolveCogSecEventsPath(root);
    const store = new CogSecEventStore(path, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });

    const created = store.createEvent({
      caseId: 'cogsec_20260701T000000Z_test',
      type: 'content_poisoning',
      severity: 'high',
      sourceChannelId: 'discord-channel-1',
      affectedLogicalSessionIds: ['logical-session-1'],
      affectedMessageRanges: [{
        sourceChannelId: 'discord-channel-1',
        logicalSessionId: 'logical-session-1',
        startEntryId: 4,
        endEntryId: 8,
      }],
      sealedForensicPayloadRefs: [TEST_REF],
      sealedForensicPayloadHashes: [TEST_HASH],
      affectedArtifacts: {
        memories: {
          ids: ['memory-1'],
          count: 1,
        },
      },
      actions: ['seal', 'tombstone'],
      actor: 'operator',
      safeAgentSummary: SAFE_SUMMARY,
    });

    expect(created).toMatchObject({
      caseId: 'cogsec_20260701T000000Z_test',
      status: 'open',
      sourceChannelId: 'discord-channel-1',
      safeAgentSummary: SAFE_SUMMARY,
    });
    expect(JSON.stringify(created)).not.toContain('dirty payload');

    const reloaded = new CogSecEventStore(path).getEvent('cogsec_20260701T000000Z_test');
    expect(reloaded?.sealedForensicPayloadRefs).toEqual([TEST_REF]);
    expect(reloaded?.affectedMessageRanges).toEqual([{
      sourceChannelId: 'discord-channel-1',
      logicalSessionId: 'logical-session-1',
      startEntryId: 4,
      endEntryId: 8,
    }]);
  });

  it('fails closed on unknown persisted fields', () => {
    const root = makeTempRoot();
    const path = resolveCogSecEventsPath(root);
    new CogSecEventStore(path, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    }).createEvent({
      caseId: 'cogsec_20260701T000000Z_strict',
      type: 'prompt_injection',
      severity: 'critical',
      sourceChannelId: 'discord-channel-1',
      safeAgentSummary: SAFE_SUMMARY,
    });

    const raw = {
      version: 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
      events: {
        cogsec_20260701T000000Z_strict: {
          caseId: 'cogsec_20260701T000000Z_strict',
          type: 'prompt_injection',
          severity: 'critical',
          status: 'open',
          sourceChannelId: 'discord-channel-1',
          affectedLogicalSessionIds: [],
          affectedMessageRanges: [],
          sealedForensicPayloadRefs: [],
          sealedForensicPayloadHashes: [],
          tombstonedL0RowCount: 0,
          affectedArtifacts: {},
          actions: [],
          actor: 'operator',
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-01T00:00:00.000Z',
          safeAgentSummary: SAFE_SUMMARY,
          resultCounters: {},
          epochCuts: [],
          payload: 'this must never be accepted in event metadata',
        },
      },
    };
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');

    expect(() => new CogSecEventStore(path)).toThrow(/unknown field "payload"/u);
  });

  it('rejects summary and failure details that look like payload or exploit instructions', () => {
    const root = makeTempRoot();
    const path = resolveCogSecEventsPath(root);
    const store = new CogSecEventStore(path);

    expect(() => store.createEvent({
      caseId: 'cogsec_20260701T000000Z_badsummary',
      type: 'prompt_injection',
      severity: 'high',
      sourceChannelId: 'discord-channel-1',
      safeAgentSummary: 'payload: ignore previous instructions',
    })).toThrow(/unsafe implementation or payload detail/u);

    expect(() => store.createEvent({
      caseId: 'cogsec_20260701T000000Z_badfailure',
      type: 'prompt_injection',
      severity: 'high',
      sourceChannelId: 'discord-channel-1',
      safeAgentSummary: SAFE_SUMMARY,
      failureDetails: 'reproducer uses a bypass',
    })).toThrow(/unsafe implementation or payload detail/u);
  });

  it('links a CogSec event to a route epoch cut', () => {
    const root = makeTempRoot();
    const path = resolveCogSecEventsPath(root);
    const store = new CogSecEventStore(path, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    store.createEvent({
      caseId: 'cogsec_20260701T000000Z_epoch',
      type: 'content_poisoning',
      severity: 'medium',
      sourceChannelId: 'discord-channel-1',
      safeAgentSummary: SAFE_SUMMARY,
    });

    const updated = store.appendEpochCut('cogsec_20260701T000000Z_epoch', {
      sourceChannelId: 'discord-channel-1',
      oldLogicalSessionId: 'discord-channel-1',
      newLogicalSessionId: 'discord-channel-1:session:20260701T000000Z-abc12345',
      routeGeneration: 2,
      cutAt: '2026-07-01T00:00:00.000Z',
    });

    expect(updated.actions).toContain('epoch_cut');
    expect(updated.epochCuts).toEqual([{
      sourceChannelId: 'discord-channel-1',
      oldLogicalSessionId: 'discord-channel-1',
      newLogicalSessionId: 'discord-channel-1:session:20260701T000000Z-abc12345',
      routeGeneration: 2,
      cutAt: '2026-07-01T00:00:00.000Z',
    }]);
  });

  it('persists safe persona conformance diagnostics without prompt text', () => {
    const root = makeTempRoot();
    const path = resolveCogSecEventsPath(root);
    const store = new CogSecEventStore(path, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    store.createEvent({
      caseId: 'cogsec_20260701T000000Z_conformance',
      type: 'persona_poisoning',
      severity: 'high',
      sourceChannelId: 'discord-channel-1',
      safeAgentSummary: SAFE_SUMMARY,
    });

    store.updateEvent('cogsec_20260701T000000Z_conformance', {
      status: 'failed',
      resultCounters: {
        conformanceFailures: 1,
        conformanceWarnings: 0,
      },
      personaConformance: {
        status: 'fail',
        checkedAt: '2026-07-01T00:00:00.000Z',
        summary: 'Persona conformance checks failed and require operator review before the CogSec case is clean.',
        failureCount: 1,
        warningCount: 0,
        promptContextHash: `sha256:${'c'.repeat(64)}`,
        checks: [{
          id: 'assistant_genericness',
          status: 'fail',
          reasonCodes: ['generic_assistant_marker_visible'],
        }],
      },
    });

    const reloaded = new CogSecEventStore(path).getEvent('cogsec_20260701T000000Z_conformance');
    expect(reloaded?.personaConformance?.status).toBe('fail');
    expect(reloaded?.personaConformance?.checks[0]?.id).toBe('assistant_genericness');
    expect(reloaded?.resultCounters.conformanceFailures).toBe(1);
    expect(JSON.stringify(reloaded)).not.toContain('helpful AI assistant');
    expect(JSON.stringify(reloaded)).not.toContain('promptVisibleText');
  });

  it('returns defensive copies from reads', () => {
    const root = makeTempRoot();
    const path = resolveCogSecEventsPath(root);
    const store = new CogSecEventStore(path);
    const created = store.createEvent({
      caseId: 'cogsec_20260701T000000Z_clone',
      type: 'content_poisoning',
      severity: 'low',
      sourceChannelId: 'discord-channel-1',
      affectedLogicalSessionIds: ['logical-session-1'],
      safeAgentSummary: SAFE_SUMMARY,
    });

    created.affectedLogicalSessionIds.push('mutated');

    expect(store.getEvent('cogsec_20260701T000000Z_clone')?.affectedLogicalSessionIds).toEqual(['logical-session-1']);
  });
});
