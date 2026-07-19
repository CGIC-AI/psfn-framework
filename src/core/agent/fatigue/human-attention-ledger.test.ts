import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import type { HumanAttentionPressureEvent } from './human-attention-pressure.js';
import { HumanAttentionPressureLedger } from './human-attention-ledger.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-human-attention-ledger-'));
  tempDirs.push(dir);
  return dir;
}

function event(overrides: Partial<HumanAttentionPressureEvent> = {}): HumanAttentionPressureEvent {
  return {
    schemaVersion: 1,
    timestampMs: 1_000,
    localCompanionId: 'purrsephone',
    contactId: 'human-a',
    channelId: 'channel-a',
    trustLevel: 'public',
    relationshipType: 'stranger',
    channelContext: 'direct_mention',
    weight: 2,
    pressureInWindow: 4,
    threshold: 3,
    decision: 'boundary_alert',
    reason: 'threshold_reached',
    suppressTurn: false,
    ...overrides,
  };
}

describe('HumanAttentionPressureLedger', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists and reloads privacy-minimal per-contact and per-channel events', () => {
    const path = join(makeTempDir(), 'state', 'human-attention-ledger.jsonl');
    const ledger = new HumanAttentionPressureLedger(path);
    ledger.recordHumanAttentionPressureEvent(event());
    ledger.recordHumanAttentionPressureEvent(event({
      timestampMs: 2_000,
      contactId: 'human-b',
      decision: 'clear',
      reason: 'below_threshold',
    }));

    expect(readFileSync(path, 'utf-8')).not.toContain('message');
    const rebooted = new HumanAttentionPressureLedger(path);
    expect(rebooted.listHumanAttentionPressureEvents({
      localCompanionId: 'purrsephone',
      contactId: 'human-a',
      channelId: 'channel-a',
      sinceMs: 0,
    })).toEqual([expect.objectContaining({
      contactId: 'human-a',
      decision: 'boundary_alert',
    })]);
    expect(rebooted.getData().aggregates).toMatchObject({
      eventCount: 2,
      boundaryAlertCount: 1,
    });
  });

  it('subscribes to the typed event bus and stops after close', async () => {
    const eventBus = new EventBus();
    const ledger = new HumanAttentionPressureLedger(
      join(makeTempDir(), 'human-attention-ledger.jsonl'),
      eventBus,
    );

    await eventBus.emit('agent.human_attention_pressure', event());
    expect(ledger.getData().events).toHaveLength(1);
    ledger.close();
    await eventBus.emit('agent.human_attention_pressure', event({ timestampMs: 2_000 }));
    expect(ledger.getData().events).toHaveLength(1);
  });
});
