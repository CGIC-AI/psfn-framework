import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import { buildSessionMetadataWithMessageAddressing } from '../../../core/session/message-addressing.js';
import type { ExtractedFact, ExtractedFactAttribution } from '../types.js';
import {
  resolveStrictGroupSubject,
  validateStrictGroupAddressing,
} from './strict-group-routing.js';

const entry: SessionEntry = {
  id: 1,
  channelId: 'discord-room',
  role: 'user',
  authorId: 'dragon',
  authorName: 'Example Partner',
  content: 'remember that I call you starlight',
  timestamp: 1,
  metadata: buildSessionMetadataWithMessageAddressing(undefined, {
    schemaVersion: 2,
    source: 'discord',
    author: { authorId: 'dragon', authorName: 'Example Partner' },
    observer: { authorId: 'fixture-companion-bot', authorName: 'Fixture Companion' },
    mentionedTargets: [{ authorId: 'purr-bot', authorName: 'Companion' }],
    channel: { scope: 'group', channelId: 'discord-room' },
    resolvedAddressee: {
      kind: 'participants',
      participants: [{
        authorId: 'purr-bot',
        authorName: 'Companion',
        evidence: ['mention'],
      }],
    },
  }),
};

function fact(text: string, attribution: ExtractedFactAttribution): ExtractedFact {
  return {
    text,
    type: 'emotional',
    importance: 0.9,
    confidence: 0.95,
    emotionalValence: 0,
    tags: [],
    attribution,
  };
}

describe('strict group routing', () => {
  it('requires every fact type to name its subject and true addressee', () => {
    const baseAttribution: ExtractedFactAttribution = {
      sourceMessageIds: [1],
      sourceSpeakerName: 'Example Partner',
      addressMode: 'overheard_room_context',
    };
    expect(validateStrictGroupAddressing(
      fact('Example Partner reassured Fixture Companion.', baseAttribution),
      baseAttribution,
      [entry],
    )).toEqual({ status: 'skip', reason: 'missing_subject_attribution' });

    const attributed = { ...baseAttribution, subjectName: 'Example Partner' };
    expect(validateStrictGroupAddressing(
      fact('Example Partner reassured Companion.', attributed),
      attributed,
      [entry],
    )).toMatchObject({ status: 'ok' });
  });

  it('binds a model contact id to the unique speaker selected by subject name', () => {
    const speakers = [
      { normalizedName: 'example partner', contactId: 'contact-dragon' },
      { normalizedName: 'morgan', contactId: 'contact-morgan' },
    ];
    expect(resolveStrictGroupSubject({
      subjectName: 'Example Partner',
      subjectContactId: 'contact-morgan',
    }, speakers)).toEqual({ status: 'skip', reason: 'conflicting_subject_contact' });
    expect(resolveStrictGroupSubject({
      subjectName: 'Example Partner',
      subjectContactId: 'contact-dragon',
    }, speakers)).toEqual({ status: 'ok', speaker: speakers[0] });
  });
});
