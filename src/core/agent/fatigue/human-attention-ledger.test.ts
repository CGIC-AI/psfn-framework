import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    localCompanionId: 'companion',
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
    sourceMessageId: 'discord-message-1',
    turnId: 'turn-1',
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

    expect(readFileSync(path, 'utf-8')).not.toContain('messageText');
    const rebooted = new HumanAttentionPressureLedger(path);
    expect(rebooted.listHumanAttentionPressureEvents({
      localCompanionId: 'companion',
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

  it('allowlists persisted event fields and rejects unknown fields on reload', () => {
    const path = join(makeTempDir(), 'state', 'human-attention-ledger.jsonl');
    const ledger = new HumanAttentionPressureLedger(path);
    ledger.recordHumanAttentionPressureEvent({
      ...event(),
      messageText: 'private message body',
    } as HumanAttentionPressureEvent);

    expect(readFileSync(path, 'utf-8')).not.toContain('private message body');
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    const eventValue = raw.event as Record<string, unknown>;
    eventValue.messageText = 'injected private text';
    const malformedPath = join(makeTempDir(), 'human-attention-ledger.jsonl');
    writeFileSync(malformedPath, `${JSON.stringify(raw)}\n`, 'utf-8');

    expect(() => new HumanAttentionPressureLedger(malformedPath))
      .toThrow('event contains unknown keys: messageText');
  });

  it('deduplicates the same physical source message after a ledger reload', () => {
    const path = join(makeTempDir(), 'state', 'human-attention-ledger.jsonl');
    const ledger = new HumanAttentionPressureLedger(path);
    ledger.recordHumanAttentionPressureEvent(event());
    const rebooted = new HumanAttentionPressureLedger(path);

    expect(rebooted.findHumanAttentionPressureEvent({
      localCompanionId: 'companion',
      contactId: 'human-a',
      channelId: 'channel-a',
      sourceMessageId: 'discord-message-1',
    })).toMatchObject({
      decision: 'boundary_alert',
      turnId: 'turn-1',
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
