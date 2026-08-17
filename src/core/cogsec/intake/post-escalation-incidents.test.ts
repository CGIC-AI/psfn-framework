import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CogSecEventStore } from '../events.js';
import { createPostEscalationIncidentRecorder } from './post-escalation-incidents.js';

describe('post-pass CogSec escalation incidents', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('persists structural surgical provenance and proves configured alert delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-post-escalation-'));
    dirs.push(dir);
    const path = join(dir, 'events.json');
    const notify = vi.fn().mockResolvedValue({ status: 'sent', topic: 'operator' });
    const record = createPostEscalationIncidentRecorder({
      cogSecEvents: () => new CogSecEventStore(path),
      notifier: { notify },
      companionName: 'Test Companion',
    });

    const finding = {
      phase: 'inline_shadow',
      disposition: 'confirmed_bad',
      surface: { channelClass: 'group_chat' },
      envelopeId: 'envelope-post-escalation-1',
      sourceChannelId: 'room-7',
      sourceMessageId: 'message-11',
      action: 'quarantine',
      riskLabels: ['injection/override_attempt'],
      scores: { 'l1.rules': 0.98, 'l3.confidence': 0.97 },
      semanticTrace: {
        l2: { status: 'flagged', reason: 'semantic classifier flagged' },
        l3: { status: 'flagged', reason: 'deep screener flagged' },
      },
      completedAtMs: 1_786_900_000_000,
    } as const;
    const [evidence, concurrentEvidence] = await Promise.all([
      record(finding),
      record(finding),
    ]);
    const replayEvidence = await record(finding);

    expect(evidence).toMatchObject({ notification: 'delivered', durableEvidence: 'recorded' });
    expect(concurrentEvidence).toMatchObject({
      notification: 'delivered',
      durableEvidence: 'recorded',
    });
    expect(replayEvidence).toMatchObject({ notification: 'delivered', durableEvidence: 'recorded' });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      sender: expect.objectContaining({ kind: 'system' }),
      priority: 5,
      message: expect.stringContaining('room-7'),
    }));
    const event = new CogSecEventStore(path).listEvents()[0];
    expect(event).toMatchObject({
      caseId: evidence.caseId,
      type: 'intake_firewall',
      severity: 'high',
      status: 'open',
      sourceChannelId: 'room-7',
      operatorAlertDeliveryStatus: 'delivered',
      affectedMessageRanges: [{
        sourceChannelId: 'room-7',
        sourceMessageIds: ['message-11'],
      }],
    });
  });

  it('records failed-closed escalation and unconfigured delivery without losing the case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-post-escalation-'));
    dirs.push(dir);
    const path = join(dir, 'events.json');
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error('zero configured sinks'))
      .mockResolvedValue({ status: 'sent', topic: 'operator' });
    const record = createPostEscalationIncidentRecorder({
      cogSecEvents: () => new CogSecEventStore(path),
      notifier: { notify },
      companionName: 'Test Companion',
    });

    const finding = {
      phase: 'post_pass',
      disposition: 'failed_closed',
      surface: { channelClass: 'group_chat' },
      envelopeId: 'envelope-post-escalation-2',
      sourceChannelId: 'room-8',
      sourceMessageId: 'message-12',
      action: 'quarantine',
      riskLabels: [],
      scores: {},
      semanticTrace: {
        l2: { status: 'failed_closed', reason: 'transport unavailable' },
        l3: { status: 'failed_closed', reason: 'transport unavailable' },
      },
      completedAtMs: 1_786_900_000_001,
    } as const;
    const evidence = await record(finding);

    expect(evidence.notification).toBe('unconfigured');
    const retryEvidence = await record(finding);
    expect(retryEvidence.notification).toBe('delivered');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(new CogSecEventStore(path).listEvents()[0]?.operatorAlertDeliveryStatus).toBe('delivered');
  });

  it('persists clear post-pass telemetry without notifying the operator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-post-escalation-'));
    dirs.push(dir);
    const path = join(dir, 'events.json');
    const notify = vi.fn();
    const record = createPostEscalationIncidentRecorder({
      cogSecEvents: () => new CogSecEventStore(path),
      notifier: { notify },
      companionName: 'Test Companion',
    });

    const evidence = await record({
      phase: 'post_pass',
      disposition: 'clear',
      surface: { channelClass: 'group_chat' },
      envelopeId: 'envelope-post-escalation-clear',
      sourceChannelId: 'room-clear',
      sourceMessageId: 'message-clear',
      action: 'pass',
      riskLabels: [],
      scores: { 'l2.confidence': 0.02 },
      semanticTrace: {
        l2: { status: 'clear', reason: 'semantic classifier clear' },
        l3: { status: 'not_run', reason: 'below escalation threshold' },
      },
      completedAtMs: 1_786_900_000_002,
    });

    expect(evidence).toMatchObject({ notification: 'not_required', durableEvidence: 'recorded' });
    expect(notify).not.toHaveBeenCalled();
    expect(new CogSecEventStore(path).listEvents()[0]).toMatchObject({
      type: 'intake_firewall',
      severity: 'low',
      status: 'applied',
      affectedMessageRanges: [{ sourceMessageIds: ['message-clear'] }],
    });
  });
});
