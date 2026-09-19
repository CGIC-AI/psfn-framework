import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPartial } from '@total-typescript/shoehorn';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../../persistence/sessions/store.js';
import { buildSessionMetadataWithTurn } from '../../core/session/turn-provenance.js';
import { createTurnId } from '../../core/turns/id.js';
import type { SocialImpulseOutreachDestination } from '../../core/emotion/social-impulse-outreach.js';
import { buildSocialOutreachContext } from './social-outreach-context.js';

describe('social outreach conversation evidence', () => {
  it.each(['queued', 'delivered'] as const)('does not treat a native authored draft as sent when %s', async state => {
    const directory = mkdtempSync(join(tmpdir(), 'outreach-conversation-'));
    try {
      const sessions = new SessionStore(directory);
      const channelId = 'dm-example';
      const sentAt = Date.parse('2026-07-20T01:00:00Z');
      const receivedAt = sentAt + 1_000;
      const authoredAt = sentAt + 2_000;
      const deliveredAt = sentAt + 3_000;
      sessions.append({ channelId, role: 'assistant', timestamp: sentAt, content: 'Previous ordinary reply.' });
      sessions.append({ channelId, role: 'user', authorId: 'example-person', timestamp: receivedAt, content: 'Previous received message.' });
      sessions.append({
        channelId, role: 'assistant', timestamp: authoredAt, content: 'An authored but unsent draft.',
        metadata: buildSessionMetadataWithTurn(undefined, {
          turnId: createTurnId(authoredAt), requestId: 'example-authoring',
          sourceMessageId: 'social-outreach-example', role: 'assistant', actorKind: 'machine_intelligence',
        }),
      });
      const destination: SocialImpulseOutreachDestination = {
        kind: 'human_dm', destinationId: 'human:example:discord:dm-example', displayLabel: 'Example Person',
        contactId: 'example', channelId, channelType: 'discord', dyadId: null,
      };
      const record = fromPartial({ companionId: 'example-companion', destination, opportunityId: 'example-opportunity',
        state, updatedAtMs: state === 'delivered' ? deliveredAt : authoredAt });
      const context = await buildSocialOutreachContext({
        companionId: 'example-companion', destinations: [destination], sessions,
        contacts: { getById: async () => undefined },
        outreach: { getDestinationStatus: async () => ({
          pending: state === 'queued' ? record : null, latestTerminal: state === 'delivered' ? record : null,
        }) },
      });
      const person = JSON.parse(context.split('\n').find(line => line.startsWith('[{'))!)[0];
      expect(person).toMatchObject({
        lastReceivedAt: new Date(receivedAt).toISOString(),
        lastSentAt: new Date(state === 'delivered' ? deliveredAt : sentAt).toISOString(),
        lastConversationAt: new Date(receivedAt).toISOString(),
        lastSpeakerRole: 'user', lastMessagePreview: 'Previous received message.',
      });
      expect(context).not.toContain('An authored but unsent draft.');
      expect(sessions.findLatestEntries(channelId, entry => entry.role === 'assistant', 1)[0]?.content)
        .toBe('An authored but unsent draft.');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
