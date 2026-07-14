import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';
import { backfillLegacyTurnId } from '../../core/turns/id.js';

function createTurnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schemaVersion: 1,
    turnId: '019d2326-d9e1-701d-bcee-250d2cbb0e4e',
    requestId: 'req-psfn-amica',
    channelId: 'psfn-amica:test:pi5',
    channelType: 'psfn-amica',
    startedAt: 1_742_000_000_000,
    completedAt: 1_742_000_000_500,
    status: 'completed',
    userMessage: {
      role: 'user',
      content: 'hello',
      timestamp: 1_742_000_000_000,
      authorId: 'pi5',
      authorName: 'Pi5',
    },
    assistantMessage: {
      role: 'assistant',
      content: 'ok',
      timestamp: 1_742_000_000_500,
      authorId: 'companion',
      authorName: 'Companion',
    },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
    versionPointers: {
      model: 'psfn',
    },
    provenanceRefs: [],
    ...overrides,
  };
}

describe('turn-records', () => {
  it('persists and reads psfn-amica turn records', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-psfn-amica-turn-records-'));
    const record = createTurnRecord();
    const turnRecordStore: TurnRecordStorePort = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(record.channelId, 5)).toEqual([record]);
  });

  it('round-trips a durable satellite/place location', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-location-'));
    const record = createTurnRecord({
      location: { placeId: 'living_room', satelliteId: 'pi-voice' },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    const read = turnRecordStore.readRecentTurnRecords(record.channelId, 5);
    expect(read).toEqual([record]);
    expect(read[0]?.location).toEqual({ placeId: 'living_room', satelliteId: 'pi-voice' });
  });

  it('round-trips a durable ICP suppression correlation', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-icp-correlation-'));
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const channelId = `companion-dm:${companionA}:${companionB}`;
    const turnId = '019d2326-d9e1-701d-bcee-250d2cbb0e4e';
    const requestId = 'companion-reply-11111111-1111-4111-8111-111111111111-prior-turn';
    const record = createTurnRecord({
      channelId,
      channelType: 'companion',
      turnId,
      requestId,
      assistantMessage: undefined,
      icpCorrelation: {
        conversationId: '33333333-3333-4333-8333-333333333333',
        rootInitiationId: '44444444-4444-4444-8444-444444444444',
        initiatedByCompanionId: companionA,
        localCompanionId: companionB,
        peerCompanionId: companionA,
        peerContactId: 'contact-a',
        channelId,
        turnId,
        messageId: requestId,
        requestId,
        chargeLane: 'companion_social',
        surface: 'companion_dm',
        costPurpose: 'conversation_turn',
        costOriginStage: 'reply',
        fatigueDecision: 'suppress',
        fatigueReasonCode: 'fatigue_exhausted',
      },
    });
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    expect(turnRecordStore.readRecentTurnRecords(channelId, 5)).toEqual([record]);
  });

  it('omits location for turns that carried no place binding (legacy rows load fine)', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-nolocation-'));
    const record = createTurnRecord();
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);

    turnRecordStore.appendTurnRecord(record);

    const read = turnRecordStore.readRecentTurnRecords(record.channelId, 5);
    expect(read).toEqual([record]);
    expect(read[0]).not.toHaveProperty('location');
  });

  it('finds an old durable completion marker without a recent-record cap', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-turn-records-marker-'));
    const turnRecordStore = createFilesystemTurnRecordStorePort(sessionsDir);
    const old = createTurnRecord({ turnId: backfillLegacyTurnId('old-completion-marker') });
    turnRecordStore.appendTurnRecord(old);
    for (let index = 0; index < 40; index += 1) {
      turnRecordStore.appendTurnRecord(createTurnRecord({
        turnId: backfillLegacyTurnId(`newer-turn-${index}`),
        requestId: `newer-request-${index}`,
        startedAt: old.startedAt + index + 1,
        completedAt: old.completedAt + index + 1,
      }));
    }

    expect(turnRecordStore.findTurnRecord(old.channelId, old.turnId)).toEqual(old);
  });
});
