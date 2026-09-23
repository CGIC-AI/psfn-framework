import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Contact } from '../../core/contacts/types.js';
import { buildSessionMetadataWithMessageAddressing } from '../../core/session/message-addressing.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { resolvePrimaryContactOutreachIdentity } from './social-outreach-context.js';

const contact: Contact = {
  id: 'contact-example', displayName: 'Example Person', trustLevel: 'primary',
  discordUserId: 'discord-example', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-01-01T00:00:00Z',
};

function addressed(channelId: string, authorId: string, scope: 'direct' | 'group'): string {
  return buildSessionMetadataWithMessageAddressing(undefined, {
    schemaVersion: 2,
    source: 'discord',
    author: { authorId, authorName: 'Someone' },
    observer: { authorId: 'companion-bot', authorName: 'Companion' },
    mentionedTargets: [],
    channel: { scope, channelId },
    resolvedAddressee: scope === 'group'
      ? { kind: 'room', channelId }
      : { kind: 'participants', participants: [{ authorId: 'companion-bot', authorName: 'Companion', evidence: ['direct_message'] }] },
  });
}

describe('primary contact outreach identity', () => {
  it.each([
    { scope: 'direct' as const, authorId: 'discord-example', expected: 'discord-example' },
    { scope: 'group' as const, authorId: 'discord-example', expected: undefined },
    { scope: 'direct' as const, authorId: 'discord-stranger', expected: undefined },
  ])('binds the channel only to the contact\'s own direct messages ($scope, $authorId)', ({ scope, authorId, expected }) => {
    const directory = mkdtempSync(join(tmpdir(), 'outreach-identity-'));
    try {
      const sessions = new SessionStore(directory);
      sessions.append({
        channelId: 'dm-example', role: 'user', authorId, timestamp: 1, content: 'hello',
        metadata: addressed('dm-example', authorId, scope),
      });
      expect(resolvePrimaryContactOutreachIdentity(sessions, contact, 'dm-example')).toBe(expected);
      expect(resolvePrimaryContactOutreachIdentity(sessions, contact, 'dm-unknown')).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
