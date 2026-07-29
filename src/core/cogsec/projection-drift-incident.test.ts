import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CogSecEventStore } from './events.js';
import {
  createProjectionDriftIncidentObserver,
  projectionDriftCaseId,
} from './projection-drift-incident.js';
import {
  listAgentVisibleCogSecEvents,
  listOperatorVisibleCogSecEvents,
} from './safe-log.js';
import type { RedactionProjectionDriftEvent } from '../../shared/contracts/projection-drift.js';

describe('createProjectionDriftIncidentObserver (bead 6oott)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function newStorePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-projection-drift-incident-'));
    dirs.push(dir);
    return join(dir, 'cogsec-events.json');
  }

  const driftEvent = (over: Partial<RedactionProjectionDriftEvent> = {}): RedactionProjectionDriftEvent => ({
    channelId: 'ch-drifted',
    reason: 'connection reset during projection DELETE',
    markedAtMs: 1_700_000_000_000,
    ...over,
  });

  it('records one durable, operator-only incident on first redaction drift', () => {
    const path = newStorePath();
    const observer = createProjectionDriftIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordRedactionProjectionDrift(driftEvent());

    const events = new CogSecEventStore(path).listEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.caseId).toBe(projectionDriftCaseId('ch-drifted'));
    expect(event.type).toBe('session_integrity');
    expect(event.severity).toBe('high');
    expect(event.status).toBe('open');
    expect(event.sourceChannelId).toBe('ch-drifted');
    // Content-free: session identifier + database error + remediation pointer.
    expect(event.safeAgentSummary).toContain('transcript search projection');
    expect(event.safeAgentSummary).toContain('session:repair:transcript-projection');
    expect(event.safeAgentSummary).toContain('connection reset');

    // Operator surface sees it; the companion-facing surface never does.
    expect(listOperatorVisibleCogSecEvents(events).map(e => e.caseId)).toContain(event.caseId);
    expect(listAgentVisibleCogSecEvents(events)).toHaveLength(0);
  });

  it('collapses repeated drift for the same session into one refreshed open incident', () => {
    const path = newStorePath();
    const observer = createProjectionDriftIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordRedactionProjectionDrift(driftEvent());
    observer.recordRedactionProjectionDrift(driftEvent({ reason: 'second failure' }));

    const events = new CogSecEventStore(path).listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].safeAgentSummary).toContain('second failure');
  });

  it('does not resurrect or overwrite an incident the operator already acted on', () => {
    const path = newStorePath();
    const observer = createProjectionDriftIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordRedactionProjectionDrift(driftEvent());
    const caseId = projectionDriftCaseId('ch-drifted');
    new CogSecEventStore(path).updateEvent(caseId, { status: 'applied' });

    observer.recordRedactionProjectionDrift(driftEvent({ reason: 'post-remediation failure' }));

    const events = new CogSecEventStore(path).listEvents();
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('applied');
    expect(events[0].safeAgentSummary).not.toContain('post-remediation failure');
  });

  it('keeps distinct sessions as distinct incidents with deterministic caseIds', () => {
    const path = newStorePath();
    const observer = createProjectionDriftIncidentObserver({
      cogSecEvents: () => new CogSecEventStore(path),
    });

    observer.recordRedactionProjectionDrift(driftEvent({ channelId: 'ch-one' }));
    observer.recordRedactionProjectionDrift(driftEvent({ channelId: 'ch-two' }));

    const events = new CogSecEventStore(path).listEvents();
    expect(events.map(event => event.caseId).sort()).toEqual([
      projectionDriftCaseId('ch-one'),
      projectionDriftCaseId('ch-two'),
    ].sort());
    expect(projectionDriftCaseId('ch-one')).toMatch(/^cogsec_projectiondrift_[0-9a-f]{40}$/);
  });
});
