import { describe, expect, it } from 'vitest';
import { backfillLegacyTurnId } from '../turns/id.js';
import {
  buildSessionMetadataWithTurn,
  resolveSessionEntryActorKind,
  resolveSessionEntryTurnContext,
} from './turn-provenance.js';

function entryWithMetadata(metadata?: string) {
  return {
    id: 1,
    channelId: 'room:one',
    role: 'user' as const,
    content: 'hello',
    timestamp: 1,
    metadata,
  };
}

describe('session turn actor provenance', () => {
  it('round-trips authoritative actor kind metadata', () => {
    const metadata = buildSessionMetadataWithTurn(undefined, {
      turnId: backfillLegacyTurnId('actor-kind'),
      requestId: 'actor-kind',
      role: 'user',
      actorKind: 'machine_intelligence',
    });

    expect(resolveSessionEntryActorKind(entryWithMetadata(metadata)))
      .toBe('machine_intelligence');
  });

  it('treats legacy entries without actor provenance as unknown', () => {
    expect(resolveSessionEntryActorKind(entryWithMetadata())).toBe('unknown');
    expect(resolveSessionEntryActorKind(entryWithMetadata('{}'))).toBe('unknown');
  });

  it('rejects malformed actor provenance instead of guessing human', () => {
    expect(() => resolveSessionEntryActorKind(entryWithMetadata(JSON.stringify({
      turn: { actorKind: 'person' },
    })))).toThrow('actorKind');
  });

  it('distinguishes persisted TurnIDs from legacy backfills and rejects corrupt explicit IDs', () => {
    expect(resolveSessionEntryTurnContext(entryWithMetadata())).toMatchObject({
      turnIdSource: 'backfilled',
      turnRecordExpectation: 'not_expected',
    });
    expect(resolveSessionEntryTurnContext(entryWithMetadata(buildSessionMetadataWithTurn(
      undefined,
      {
        turnId: backfillLegacyTurnId('persisted-source'),
        requestId: 'persisted-source',
        role: 'user',
      },
    )))).toMatchObject({
      turnIdSource: 'persisted',
      turnRecordExpectation: 'required',
    });
    expect(() => resolveSessionEntryTurnContext(entryWithMetadata(JSON.stringify({
      turn: {
        schemaVersion: 1,
        turnId: 42,
        requestId: 'corrupt-source',
        role: 'user',
      },
    })))).toThrow('turnId');
  });

  it('marks only observed-message provenance as not expecting a local TurnRecord', () => {
    const turnId = backfillLegacyTurnId('observed-source');
    const observedMetadata = buildSessionMetadataWithTurn(JSON.stringify({
      type: 'observed_message',
      source: 'discord',
      responseMode: 'observe',
    }), {
      turnId,
      requestId: 'observed-source',
      role: 'user',
      actorKind: 'unknown',
    });
    const unrelatedMetadata = buildSessionMetadataWithTurn(JSON.stringify({
      type: 'other_context',
    }), {
      turnId,
      requestId: 'ordinary-source',
      role: 'user',
      actorKind: 'unknown',
    });

    expect(resolveSessionEntryTurnContext(entryWithMetadata(observedMetadata)))
      .toMatchObject({ turnRecordExpectation: 'not_expected' });
    expect(resolveSessionEntryTurnContext(entryWithMetadata(unrelatedMetadata)))
      .toMatchObject({ turnRecordExpectation: 'required' });
  });
});
