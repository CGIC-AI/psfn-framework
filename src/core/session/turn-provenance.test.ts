import { describe, expect, it } from 'vitest';
import { backfillLegacyTurnId } from '../turns/id.js';
import {
  buildSessionMetadataWithTurn,
  resolveSessionEntryActorKind,
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
});
