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

    const evidence = await record({
      disposition: 'confirmed_bad',
      surface: { channelClass: 'group_chat' },
      envelopeId: 'envelope-post-escalation-1',
      sourceChannelId: 'room-7',
      sourceMessageId: 'message-11',
      action: 'quarantine',
      riskLabels: ['injection/override_attempt'],
      completedAtMs: 1_786_900_000_000,
    });

    expect(evidence).toMatchObject({ notification: 'delivered', durableEvidence: 'recorded' });
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
    const record = createPostEscalationIncidentRecorder({
      cogSecEvents: () => new CogSecEventStore(path),
      notifier: { notify: vi.fn().mockRejectedValue(new Error('zero configured sinks')) },
      companionName: 'Test Companion',
    });

    const evidence = await record({
      disposition: 'failed_closed',
      surface: { channelClass: 'group_chat' },
      envelopeId: 'envelope-post-escalation-2',
      sourceChannelId: 'room-8',
      sourceMessageId: 'message-12',
      action: 'quarantine',
      riskLabels: [],
      completedAtMs: 1_786_900_000_001,
    });

    expect(evidence.notification).toBe('unconfigured');
    expect(new CogSecEventStore(path).listEvents()[0]?.operatorAlertDeliveryStatus)
      .toBe('unconfigured');
  });
});
