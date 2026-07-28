import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CogSecEventStore } from './events.js';
import {
  createSessionIntegrityIncidentObserver,
  sessionIntegrityCaseId,
} from './session-integrity-incident.js';
import {
  listAgentVisibleCogSecEvents,
  listOperatorVisibleCogSecEvents,
} from './safe-log.js';
import type { SessionIntegrityFailureEvent } from '../../shared/contracts/session-integrity.js';

describe('createSessionIntegrityIncidentObserver (bead g59z)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function newStorePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-session-integrity-incident-'));
    dirs.push(dir);
    return join(dir, 'cogsec-events.json');
  }

  const failureEvent = (over: Partial<SessionIntegrityFailureEvent> = {}): SessionIntegrityFailureEvent => ({
    channelId: 'ch-broken',
    failedEntryCount: 3,
    firstFailedEntryId: 10,
    lastFailedEntryId: 42,
    contiguousRunCount: 1,
    detectedAtMs: 1_700_000_000_000,
    ...over,
  });

  it('records one durable, operator-only CogSec incident on first failure', () => {
    const path = newStorePath();
    const observer = createSessionIntegrityIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordIntegrityFailure(failureEvent());

    const events = new CogSecEventStore(path).listEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.caseId).toBe(sessionIntegrityCaseId('ch-broken'));
    expect(event.type).toBe('session_integrity');
    expect(event.severity).toBe('high');
    expect(event.status).toBe('open');
    expect(event.sourceChannelId).toBe('ch-broken');
    expect(event.affectedMessageRanges).toEqual([
      { sourceChannelId: 'ch-broken', logicalSessionId: 'ch-broken', startEntryId: 10, endEntryId: 42 },
    ]);
    // Content-free: the summary carries counts/ids only, no message text.
    expect(event.safeAgentSummary).toContain('Session integrity check failed');
    expect(event.safeAgentSummary).not.toContain('secret');

    // Operator surface sees it; the companion-facing surface never does.
    expect(listOperatorVisibleCogSecEvents(events).map(e => e.type)).toContain('session_integrity');
    expect(listAgentVisibleCogSecEvents(events)).toHaveLength(0);
  });

  it('collapses repeated failures for the same session into one updated incident', () => {
    const path = newStorePath();
    const observer = createSessionIntegrityIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordIntegrityFailure(failureEvent());
    observer.recordIntegrityFailure(failureEvent({ failedEntryCount: 5, lastFailedEntryId: 60, contiguousRunCount: 2 }));
    observer.recordIntegrityFailure(failureEvent({ failedEntryCount: 5, lastFailedEntryId: 60, contiguousRunCount: 2 }));

    const events = new CogSecEventStore(path).listEvents();
    expect(events).toHaveLength(1);
    // The single incident reflects the latest evidence (widened range).
    expect(events[0].affectedMessageRanges[0].endEntryId).toBe(60);
  });

  it('keeps a distinct incident per session', () => {
    const path = newStorePath();
    const observer = createSessionIntegrityIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordIntegrityFailure(failureEvent({ channelId: 'ch-a' }));
    observer.recordIntegrityFailure(failureEvent({ channelId: 'ch-b' }));

    expect(new CogSecEventStore(path).listEvents()).toHaveLength(2);
  });

  it('does not resurrect or overwrite an incident the operator has begun remediating', () => {
    const path = newStorePath();
    const observer = createSessionIntegrityIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordIntegrityFailure(failureEvent());
    const caseId = sessionIntegrityCaseId('ch-broken');
    new CogSecEventStore(path).updateEvent(caseId, { status: 'applying' });

    observer.recordIntegrityFailure(failureEvent({ failedEntryCount: 99, lastFailedEntryId: 999 }));

    const event = new CogSecEventStore(path).getEvent(caseId);
    expect(event?.status).toBe('applying');
    // The operator-owned case is left intact (range not overwritten).
    expect(event?.affectedMessageRanges[0].endEntryId).toBe(42);
  });
});
