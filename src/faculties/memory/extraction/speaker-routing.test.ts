import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import type { ExtractedFact } from '../types.js';
import { buildSessionMetadataWithMessageAddressing } from '../../../core/session/message-addressing.js';
import {
  buildSpeakerRoutingContext,
  resolveFactRouting,
  type ExtractionSourceSpeaker,
} from './speaker-routing.js';

function entry(id: number, authorId: string, authorName: string, content: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    channelId: 'discord-room',
    role: 'user',
    authorId,
    authorName,
    content,
    timestamp: id * 1_000,
    ...overrides,
  };
}

function fact(overrides: Partial<ExtractedFact>): ExtractedFact {
  return {
    text: 'source fact',
    type: 'semantic',
    importance: 0.9,
    confidence: 0.95,
    emotionalValence: 0,
    tags: [],
    ...overrides,
  };
}

async function context(entries: SessionEntry[]) {
  const contactByAuthor = new Map([
    ['dragon', 'contact-dragon'],
    ['morgan', 'contact-morgan'],
    ['iki', 'contact-iki'],
  ]);
  return buildSpeakerRoutingContext(
    entries,
    async (speaker: ExtractionSourceSpeaker) => (
      speaker.authorId ? contactByAuthor.get(speaker.authorId) : undefined
    ),
  );
}

function addressedTo(...targets: Array<{ authorId: string; authorName: string }>): string {
  return buildSessionMetadataWithMessageAddressing(undefined, {
    schemaVersion: 2,
    source: 'discord',
    author: { authorId: 'dragon', authorName: 'Example Partner' },
    observer: { authorId: 'current-companion-bot', authorName: 'Lyra' },
    mentionedTargets: targets,
    channel: { scope: 'group', channelId: 'discord-room' },
    resolvedAddressee: {
      kind: 'participants',
      participants: targets.map(target => ({ ...target, evidence: ['mention'] })),
    },
  });
}

function repliedTo(target: { authorId: string; authorName: string }): string {
  return buildSessionMetadataWithMessageAddressing(undefined, {
    schemaVersion: 2,
    source: 'discord',
    author: { authorId: 'dragon', authorName: 'Example Partner' },
    observer: { authorId: 'current-companion-bot', authorName: 'Lyra' },
    mentionedTargets: [],
    replyTarget: { messageId: 'discord-parent', author: target },
    channel: { scope: 'group', channelId: 'discord-room' },
    resolvedAddressee: {
      kind: 'participants',
      participants: [{ ...target, evidence: ['reply'] }],
    },
  });
}

describe('structured group fact routing', () => {
  it('rejects attribution-less facts whenever group addressing is required', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'remember the observatory promise', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({ text: 'Example Partner remembers the observatory promise.' }),
      routingContext,
      undefined,
      { requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'missing_structured_attribution',
    });
  });

  it('rejects observer-directed relational confabulation even when claimed as overheard', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'remember that I call you starlight', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner affectionately called Lyra starlight.',
        type: 'relational',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Lyra',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      { requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'conflicting_observer_attribution',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('rejects attribution-less subjects for emotional facts in a typed group room', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'remember that I call you starlight', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner reassured Lyra that he was not angry.',
        type: 'emotional',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      { requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'missing_subject_attribution',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('rejects episodic observer confabulation when another participant is the true addressee', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'remember that I call you starlight', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner told Lyra that the observatory promise still mattered.',
        type: 'episodic',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      { requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'conflicting_observer_attribution',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('rejects the known source contact when the model binds it to another named subject', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'remember that I call you starlight', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner affectionately called Other Companion starlight.',
        type: 'relational',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Other Companion',
          subjectContactId: 'contact-dragon',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      { requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'conflicting_subject_contact',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('rejects an unrelated known contact when the model binds it to another named subject', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'remember that I call you starlight', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
      entry(2, 'morgan', 'Morgan', 'I can help later.'),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner affectionately called Other Companion starlight.',
        type: 'relational',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Other Companion',
          subjectContactId: 'contact-morgan',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      { requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'conflicting_subject_contact',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('treats a typed reply to another participant as overheard room context', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'the observatory promise still matters', {
        metadata: repliedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner told Other Companion the observatory promise still matters.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'reply_to_user',
        },
      }),
      routingContext,
      undefined,
      { requireStructuredAddressing: true },
    )).toMatchObject({
      status: 'route',
      addressMode: 'overheard_room_context',
    });
  });

  it('routes source speaker from source message metadata', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'Lyra, remember that I hate blue cheese.'),
      entry(2, 'morgan', 'Morgan', 'lol'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'Example Partner hates blue cheese.',
        attribution: {
          sourceMessageIds: [1],
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'] },
    );

    expect(decision).toMatchObject({
      status: 'route',
      contactId: 'contact-dragon',
      sourceContactId: 'contact-dragon',
      sourceAuthorId: 'dragon',
      sourceSpeakerName: 'Example Partner',
      addressMode: 'direct_to_companion',
      sourceMessageIds: [1],
      sourceSpanStartMessageId: 1,
      sourceSpanEndMessageId: 1,
      reason: 'structured_source_metadata',
    });
  });

  it('routes a subject contact separately from the source speaker', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'Morgan is helping run moderation tonight.'),
      entry(2, 'morgan', 'Morgan', 'I can do it after dinner.'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'Morgan is helping run moderation tonight.',
        attribution: {
          sourceMessageIds: [1],
          subjectName: 'Morgan',
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'] },
    );

    expect(decision).toMatchObject({
      status: 'route',
      contactId: 'contact-morgan',
      sourceContactId: 'contact-dragon',
      sourceSpeakerName: 'Example Partner',
      subjectContactId: 'contact-morgan',
      subjectName: 'Morgan',
      addressMode: 'overheard_room_context',
      reason: 'structured_subject_metadata',
    });
  });

  it('skips a named subject whose contact is unresolved instead of routing to the source', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'Robin is helping run moderation tonight.'),
      entry(2, 'stranger', 'Robin', 'I can do it after dinner.'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'Robin is helping run moderation tonight.',
        attribution: {
          sourceMessageIds: [1],
          subjectName: 'Robin',
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'] },
    );

    expect(decision).toEqual({
      status: 'skip',
      reason: 'unresolved_subject_contact',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('routes room-level facts to a conversation scope instead of a contact', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'The room gets noisy whenever launch planning starts.'),
      entry(2, 'morgan', 'Morgan', 'That is true.'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'The room gets noisy whenever launch planning starts.',
        attribution: {
          sourceMessageIds: [1],
          subjectName: 'room',
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'] },
    );

    expect(decision).toMatchObject({
      status: 'route',
      sourceContactId: 'contact-dragon',
      sourceSpeakerName: 'Example Partner',
      subjectName: 'room',
      scopeRef: {
        kind: 'conversation',
        id: 'discord-room',
        label: 'Group room discord-room',
      },
      scopeTags: ['group_memory', 'room_context'],
      reason: 'structured_room_context',
    });
    expect(decision).not.toHaveProperty('contactId');
  });

  it('rejects conflicting LLM speaker attribution instead of trusting prose', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'I hate blue cheese.'),
      entry(2, 'morgan', 'Morgan', 'I love blue cheese.'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'Morgan hates blue cheese.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Morgan',
        },
      }),
      routingContext,
      undefined,
    );

    expect(decision).toEqual({
      status: 'skip',
      reason: 'conflicting_source_attribution',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('rejects unresolved source IDs and ambiguous multi-speaker spans', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'I hate blue cheese.'),
      entry(2, 'morgan', 'Morgan', 'I love blue cheese.'),
    ]);

    expect(resolveFactRouting(
      fact({ attribution: { sourceMessageIds: [99] } }),
      routingContext,
      undefined,
    )).toEqual({ status: 'skip', reason: 'missing_source_message_ids' });

    expect(resolveFactRouting(
      fact({ attribution: { sourceSpanStartMessageId: 1, sourceSpanEndMessageId: 2 } }),
      routingContext,
      undefined,
    )).toEqual({ status: 'skip', reason: 'ambiguous_source_message_ids' });
  });

  it('classifies mention, reply, and explicit system/api address modes', async () => {
    const mentionContext = await context([
      entry(1, 'dragon', 'Example Partner', 'I think Lyra should stream later.'),
    ]);
    expect(resolveFactRouting(
      fact({ attribution: { sourceMessageIds: [1] } }),
      mentionContext,
      undefined,
      { companionNames: ['Lyra'] },
    )).toMatchObject({ status: 'route', addressMode: 'mention_of_companion' });

    const replyContext = await context([
      entry(2, 'iki', 'Iki', 'That plan works for me.', {
        metadata: JSON.stringify({
          turn: {
            schemaVersion: 1,
            turnId: '019f59cd-0eaf-74c6-98dc-7ddf0e7f67e5',
            requestId: 'request-1',
            role: 'user',
            replyToMessageId: 'discord-1',
          },
        }),
      }),
    ]);
    expect(resolveFactRouting(
      fact({ attribution: { sourceMessageIds: [2] } }),
      replyContext,
      undefined,
    )).toMatchObject({ status: 'route', addressMode: 'reply_to_user' });

    expect(resolveFactRouting(
      fact({
        attribution: {
          sourceMessageIds: [2],
          addressMode: 'system_api',
        },
      }),
      replyContext,
      undefined,
    )).toMatchObject({ status: 'route', addressMode: 'system_api' });
  });

  it('rejects an unsupported direct-to-companion claim in a group room', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', '<@other-bot> hello there', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner affectionately greeted Other Companion.',
        type: 'semantic',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'direct_to_companion',
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'], requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'unverified_direct_address',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('keeps another participant address as observer context and trusts transport over the model', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', '<@other-bot> hello there', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner greeted Other Companion.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'], requireStructuredAddressing: true },
    )).toMatchObject({
      status: 'route',
      sourceContactId: 'contact-dragon',
      addressMode: 'overheard_room_context',
    });
  });

  it('derives direct address from a structured current-companion mention', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'hello there', {
        metadata: addressedTo({ authorId: 'current-companion-bot', authorName: 'Lyra' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner greeted Lyra.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      {
        companionNames: ['Lyra'],
        companionAuthorIds: [],
        requireStructuredAddressing: true,
      },
    )).toMatchObject({
      status: 'route',
      addressMode: 'direct_to_companion',
    });
  });

  it('does not let a companion-like display name override configured transport ids', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'hello there', {
        metadata: addressedTo({
          authorId: 'imposter-bot',
          authorName: 'Lyra',
        }),
      }),
    ]);
    const options = {
      companionNames: ['Lyra'],
      companionAuthorIds: ['current-companion-bot'],
      requireStructuredAddressing: true,
    };

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner greeted Lyra.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'direct_to_companion',
        },
      }),
      routingContext,
      undefined,
      options,
    )).toEqual({
      status: 'skip',
      reason: 'unverified_direct_address',
      sourceSpeakerName: 'Example Partner',
    });

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner greeted the participant using Lyra as a display name.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'overheard_room_context',
        },
      }),
      routingContext,
      undefined,
      options,
    )).toMatchObject({
      status: 'route',
      addressMode: 'overheard_room_context',
    });
  });

  it('rejects a direct claim whose attributed span mixes current and other targets', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'hello Lyra', {
        metadata: addressedTo({
          authorId: 'current-companion-bot',
          authorName: 'Room Nickname',
        }),
      }),
      entry(2, 'dragon', 'Example Partner', 'hello Other Companion', {
        metadata: addressedTo({ authorId: 'imposter-bot', authorName: 'Lyra' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner addressed Lyra directly.',
        attribution: {
          sourceMessageIds: [1, 2],
          sourceSpeakerName: 'Example Partner',
          addressMode: 'direct_to_companion',
        },
      }),
      routingContext,
      undefined,
      {
        companionNames: ['Lyra'],
        companionAuthorIds: ['current-companion-bot'],
        requireStructuredAddressing: true,
      },
    )).toEqual({
      status: 'skip',
      reason: 'conflicting_resolved_addressee',
      sourceSpeakerName: 'Example Partner',
    });
  });

  it('recognizes the current companion by transport author id when its room display name differs', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'Example Partner', 'hello there', {
        metadata: addressedTo({
          authorId: 'current-companion-bot',
          authorName: 'Room Nickname',
        }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'Example Partner greeted Lyra.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Example Partner',
          subjectName: 'Example Partner',
          addressMode: 'direct_to_companion',
        },
      }),
      routingContext,
      undefined,
      {
        companionNames: ['Lyra'],
        companionAuthorIds: ['current-companion-bot'],
        requireStructuredAddressing: true,
      },
    )).toMatchObject({
      status: 'route',
      addressMode: 'direct_to_companion',
    });
  });
});

describe('legacy (attribution-less) fact routing', () => {
  it('carries source contact and inferred address mode on speaker-name-prefix routes', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MemberOne', 'i have been growing tomatoes for years'),
      entry(2, 'iki', 'MemberTwo', 'nice, mine always wilt'),
    ]);

    const decision = resolveFactRouting(
      fact({ text: 'MemberOne has been growing tomatoes for years.' }),
      routingContext,
      undefined,
      { companionNames: ['Companion'] },
    );

    expect(decision).toMatchObject({
      status: 'route',
      contactId: 'contact-dragon',
      sourceContactId: 'contact-dragon',
      sourceAuthorId: 'dragon',
      sourceSpeakerName: 'MemberOne',
      addressMode: 'overheard_room_context',
      reason: 'speaker_name_prefix',
    });
  });

  it('infers direct_to_companion for legacy routes when the speaker addressed the companion', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MemberOne', 'Companion, remember that i like beekeeping'),
      entry(2, 'iki', 'MemberTwo', 'cool hobby'),
    ]);

    const decision = resolveFactRouting(
      fact({ text: 'MemberOne likes beekeeping.' }),
      routingContext,
      undefined,
      { companionNames: ['Companion'] },
    );

    expect(decision).toMatchObject({
      status: 'route',
      sourceContactId: 'contact-dragon',
      addressMode: 'direct_to_companion',
      reason: 'speaker_name_prefix',
    });
  });

  it('carries source metadata on single-speaker transcripts', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MemberOne', 'i really love heirloom tomatoes'),
    ]);

    const decision = resolveFactRouting(
      fact({ text: 'MemberOne loves heirloom tomatoes.' }),
      routingContext,
      'contact-trigger',
      { companionNames: ['Companion'] },
    );

    expect(decision).toMatchObject({
      status: 'route',
      contactId: 'contact-trigger',
      sourceContactId: 'contact-dragon',
      sourceAuthorId: 'dragon',
      sourceSpeakerName: 'MemberOne',
      addressMode: 'overheard_room_context',
      reason: 'single_speaker_transcript',
    });
  });

  it('still skips ambiguous group speakers instead of guessing evidence fields', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MemberOne', 'we should plant more basil'),
      entry(2, 'iki', 'MemberTwo', 'agreed, basil is great'),
    ]);

    const decision = resolveFactRouting(
      fact({ text: 'The garden needs more basil.' }),
      routingContext,
      undefined,
      { companionNames: ['Companion'] },
    );

    expect(decision).toEqual({ status: 'skip', reason: 'ambiguous_group_speaker' });
  });
});


describe('canonical direct-message speaker attribution', () => {
  it('uses the turn contact for a structured single-speaker DM and stamps its subject', async () => {
    const routingContext = await buildSpeakerRoutingContext([
      entry(1, 'transport-alex', 'Alex', 'I collect telescopes.'),
    ], async () => undefined);
    expect(resolveFactRouting(fact({
      text: 'Alex collects telescopes.',
      attribution: { sourceMessageIds: [1], sourceSpeakerName: 'Alex', subjectName: 'Alex' },
    }), routingContext, 'contact-alex')).toMatchObject({
      status: 'route', contactId: 'contact-alex', sourceContactId: 'contact-alex',
      subjectContactId: 'contact-alex',
    });
  });

  it('does not use a triggering DM contact to repair unresolved group sources', async () => {
    const routingContext = await buildSpeakerRoutingContext([
      entry(1, 'dragon', 'Example Partner', 'I collect telescopes.', {
        metadata: addressedTo({ authorId: 'current-companion-bot', authorName: 'Lyra' }),
      }),
    ], async () => undefined);
    expect(resolveFactRouting(fact({
      text: 'Example Partner collects telescopes.',
      attribution: { sourceMessageIds: [1], sourceSpeakerName: 'Example Partner',
        subjectName: 'Example Partner', addressMode: 'direct_to_companion' },
    }), routingContext, 'contact-unrelated', { requireStructuredAddressing: true }))
      .toMatchObject({ status: 'skip', reason: 'unresolved_speaker_contact' });
  });

  it('fails closed on conflicting canonical attribution for the same author', async () => {
    await expect(buildSpeakerRoutingContext(['contact-alex', 'contact-other'].map((contactId, index) => (
      entry(index + 1, 'transport-alex', 'Alex', 'I collect telescopes.', {
        metadata: JSON.stringify({ speakerAttribution: { schemaVersion: 1, canonicalContactId: contactId } }),
      })
    )))).rejects.toThrow('Conflicting canonical extraction speaker attribution');
  });

  it('uses canonical entry attribution when transport lookup has no match', async () => {
    const routingContext = await buildSpeakerRoutingContext([
      entry(1, 'transport-alex', 'Alex', 'I collect telescopes.', {
        metadata: JSON.stringify({ speakerAttribution: { schemaVersion: 1, canonicalContactId: 'contact-alex' } }),
      }),
    ], async () => undefined);
    expect(resolveFactRouting(fact({
      text: 'Alex collects telescopes.',
      attribution: { sourceMessageIds: [1], sourceSpeakerName: 'Alex', subjectName: 'Alex' },
    }), routingContext, undefined)).toMatchObject({
      status: 'route', contactId: 'contact-alex', subjectContactId: 'contact-alex',
    });
  });
});

describe('direct conversation subjects and aliases', () => {
  const alex = {
    id: 'contact-alex', displayName: 'Alex', nickname: 'Lex',
    trustLevel: 'trusted' as const, relationshipType: 'friend' as const,
    firstSeen: '', lastSeen: '',
  };
  const robin = { ...alex, id: 'contact-robin', displayName: 'Robin', nickname: 'Rob' };
  const userEntry = entry(1, 'transport-alex', 'Alex', 'My sister Robin loves sailing.');
  const assistantEntry = entry(2, 'assistant-id', 'Lyra', 'I want to learn sailing.', { role: 'assistant' });

  async function directContext(contacts = [alex, robin]) {
    return buildSpeakerRoutingContext([userEntry, assistantEntry], async () => undefined, {
      canonicalContactId: alex.id, contacts, companionName: 'Lyra',
    });
  }

  it('accepts preferred aliases for both the evidence speaker and subject', async () => {
    expect(resolveFactRouting(fact({
      text: 'Lex enjoys sailing.',
      attribution: { sourceMessageIds: [1], sourceSpeakerName: 'Lex', subjectName: 'Lex' },
    }), await directContext(), alex.id)).toMatchObject({
      status: 'route', sourceContactId: alex.id, subjectContactId: alex.id,
    });
  });

  it('keeps group source and subject matching bound to journal names', async () => {
    const routingContext = await buildSpeakerRoutingContext([
      entry(1, 'dragon', 'Example Partner', 'Lex collects telescopes.', {
        metadata: addressedTo({ authorId: 'current-companion-bot', authorName: 'Lyra' }),
      }),
    ], async () => alex.id, { contacts: [alex] });
    for (const [sourceSpeakerName, subjectName, reason] of [
      ['Example Partner', 'Lex', 'unresolved_subject_contact'],
      ['Lex', 'Example Partner', 'conflicting_source_attribution'],
    ]) {
      expect(resolveFactRouting(fact({
        text: `${subjectName} collects telescopes.`,
        attribution: { sourceMessageIds: [1], sourceSpeakerName, subjectName, addressMode: 'direct_to_companion' },
      }), routingContext, alex.id, { requireStructuredAddressing: true }))
        .toMatchObject({ status: 'skip', reason });
    }
  });

  it('uses the sole human in mixed DM citations when the source name is omitted', async () => {
    expect(resolveFactRouting(fact({
      text: 'Alex likes sailing.', attribution: { sourceMessageIds: [1, 2], subjectName: 'Alex' },
    }), await directContext(), alex.id)).toMatchObject({
      status: 'route', sourceContactId: alex.id, subjectContactId: alex.id, sourceMessageIds: [1, 2],
    });
  });

  it.each([{ sourceMessageIds: [1, 2] }, { sourceMessageIds: [1, 2, 3] }])('keeps a multi-human exchange ambiguous for cited IDs $sourceMessageIds', async ({ sourceMessageIds }) => {
    const routingContext = await buildSpeakerRoutingContext([
      userEntry, assistantEntry, entry(3, 'transport-robin', 'Robin', 'I also enjoy sailing.'),
    ], async speaker => speaker.authorId === 'transport-alex' ? alex.id : robin.id,
    { contacts: [alex, robin], companionName: 'Lyra' });
    expect(resolveFactRouting(fact({
      text: 'Alex enjoys sailing.', attribution: { sourceMessageIds, subjectName: 'Alex' },
    }), routingContext, alex.id)).toMatchObject({ status: 'skip', reason: 'ambiguous_source_message_ids' });
  });

  it('resolves a non-speaking contact while preserving the actual source', async () => {
    expect(resolveFactRouting(fact({
      text: 'Robin loves sailing.',
      attribution: { sourceMessageIds: [1], sourceSpeakerName: 'Alex', subjectName: 'Rob' },
    }), await directContext(), alex.id)).toMatchObject({
      status: 'route', contactId: robin.id, sourceContactId: alex.id, subjectContactId: robin.id,
    });
  });

  it('rejects duplicate subject aliases and fabricated contact IDs', async () => {
    const ambiguous = await directContext([alex, robin, { ...robin, id: 'contact-another-robin' }]);
    for (const routingContext of [ambiguous, await directContext()]) {
      expect(resolveFactRouting(fact({
        text: 'Robin loves sailing.',
        attribution: { sourceMessageIds: [1], subjectName: 'Robin', subjectContactId: 'invented' },
      }), routingContext, alex.id)).toMatchObject({ status: 'skip', reason: 'conflicting_subject_contact' });
    }
    expect(resolveFactRouting(fact({
      text: 'Robin loves sailing.', attribution: { sourceMessageIds: [1], subjectName: 'Robin' },
    }), ambiguous, alex.id)).toMatchObject({ status: 'skip', reason: 'conflicting_subject_contact' });
  });

  it('preserves an unknown third-party subject without labelling it as the source contact', async () => {
    const decision = resolveFactRouting(fact({
      text: 'Robin loves sailing.', attribution: { sourceMessageIds: [1], subjectName: 'Robin' },
    }), await directContext([alex]), alex.id);
    expect(decision).toMatchObject({ status: 'route', sourceContactId: alex.id, subjectName: 'Robin' });
    expect(decision).not.toHaveProperty('subjectContactId');
  });

  it.each([
    { sourceMessageIds: [2], sourceSpeakerName: 'Lyra' },
    { sourceMessageIds: [1, 2], sourceSpeakerName: 'Lyra' },
    { sourceMessageIds: [1, 2], sourceSpeakerName: undefined },
  ])('routes companion self-knowledge from cited entries $sourceMessageIds without human ownership', async ({ sourceMessageIds, sourceSpeakerName }) => {
    const decision = resolveFactRouting(fact({
      text: 'Lyra wants to learn sailing.',
      attribution: { sourceMessageIds, sourceSpeakerName, subjectName: 'Lyra' },
    }), await directContext(), alex.id);
    expect(decision).toMatchObject({ status: 'route', reason: 'conversational_companion', subjectName: 'Lyra' });
    expect(decision).not.toHaveProperty('contactId');
    expect(decision).not.toHaveProperty('subjectContactId');
  });

  it('routes human evidence about the companion as companion-owned', async () => {
    expect(resolveFactRouting(fact({
      text: 'Lyra likes sailing.', attribution: { sourceMessageIds: [1], subjectName: 'Lyra' },
    }), await directContext(), alex.id)).toMatchObject({
      status: 'route', reason: 'conversational_companion', sourceContactId: alex.id,
    });
  });

  it('requires human evidence for a companion paraphrase about a human', async () => {
    for (const sourceMessageIds of [[2], [1, 2]]) {
      const decision = resolveFactRouting(fact({
        text: 'Alex enjoys sailing.',
        attribution: { sourceMessageIds, sourceSpeakerName: 'Lyra', subjectName: 'Alex' },
      }), await directContext(), alex.id);
      expect(decision.status).toBe(sourceMessageIds.length === 1 ? 'skip' : 'route');
      if (decision.status === 'route') expect(decision.subjectContactId).toBe(alex.id);
    }
  });
});
