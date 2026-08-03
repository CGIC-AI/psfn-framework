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
    ['vega', 'contact-vega'],
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
    schemaVersion: 1,
    mentionedTargets: targets,
  });
}

describe('structured group fact routing', () => {
  it('routes source speaker from source message metadata', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MrDragonFox', 'Lyra, remember that I hate blue cheese.'),
      entry(2, 'vega', 'Vega', 'lol'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'MrDragonFox hates blue cheese.',
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
      sourceSpeakerName: 'MrDragonFox',
      addressMode: 'direct_to_companion',
      sourceMessageIds: [1],
      sourceSpanStartMessageId: 1,
      sourceSpanEndMessageId: 1,
      reason: 'structured_source_metadata',
    });
  });

  it('routes a subject contact separately from the source speaker', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MrDragonFox', 'Vega is helping run moderation tonight.'),
      entry(2, 'vega', 'Vega', 'I can do it after dinner.'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'Vega is helping run moderation tonight.',
        attribution: {
          sourceMessageIds: [1],
          subjectName: 'Vega',
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'] },
    );

    expect(decision).toMatchObject({
      status: 'route',
      contactId: 'contact-vega',
      sourceContactId: 'contact-dragon',
      sourceSpeakerName: 'MrDragonFox',
      subjectContactId: 'contact-vega',
      subjectName: 'Vega',
      addressMode: 'overheard_room_context',
      reason: 'structured_subject_metadata',
    });
  });

  it('skips a named subject whose contact is unresolved instead of routing to the source', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MrDragonFox', 'Robin is helping run moderation tonight.'),
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
      sourceSpeakerName: 'MrDragonFox',
    });
  });

  it('routes room-level facts to a conversation scope instead of a contact', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MrDragonFox', 'The room gets noisy whenever launch planning starts.'),
      entry(2, 'vega', 'Vega', 'That is true.'),
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
      sourceSpeakerName: 'MrDragonFox',
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
      entry(1, 'dragon', 'MrDragonFox', 'I hate blue cheese.'),
      entry(2, 'vega', 'Vega', 'I love blue cheese.'),
    ]);

    const decision = resolveFactRouting(
      fact({
        text: 'Vega hates blue cheese.',
        attribution: {
          sourceMessageIds: [1],
          sourceSpeakerName: 'Vega',
        },
      }),
      routingContext,
      undefined,
    );

    expect(decision).toEqual({
      status: 'skip',
      reason: 'conflicting_source_attribution',
      sourceSpeakerName: 'MrDragonFox',
    });
  });

  it('rejects unresolved source IDs and ambiguous multi-speaker spans', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MrDragonFox', 'I hate blue cheese.'),
      entry(2, 'vega', 'Vega', 'I love blue cheese.'),
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
      entry(1, 'dragon', 'MrDragonFox', 'I think Lyra should stream later.'),
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
      entry(1, 'dragon', 'MrDragonFox', '<@other-bot> hello there', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'MrDragonFox affectionately greeted Lyra.',
        type: 'relational',
        attribution: {
          sourceMessageIds: [1],
          addressMode: 'direct_to_companion',
        },
      }),
      routingContext,
      undefined,
      { companionNames: ['Lyra'], requireStructuredAddressing: true },
    )).toEqual({
      status: 'skip',
      reason: 'unverified_direct_address',
      sourceSpeakerName: 'MrDragonFox',
    });
  });

  it('keeps another participant address as observer context and trusts transport over the model', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MrDragonFox', '<@other-bot> hello there', {
        metadata: addressedTo({ authorId: 'other-bot', authorName: 'Other Companion' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'MrDragonFox greeted Other Companion.',
        attribution: {
          sourceMessageIds: [1],
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
      entry(1, 'dragon', 'MrDragonFox', 'hello there', {
        metadata: addressedTo({ authorId: 'lyra-bot', authorName: 'Lyra' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'MrDragonFox greeted Lyra.',
        attribution: {
          sourceMessageIds: [1],
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
      entry(1, 'dragon', 'MrDragonFox', 'hello there', {
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
        text: 'MrDragonFox greeted Lyra.',
        attribution: {
          sourceMessageIds: [1],
          addressMode: 'direct_to_companion',
        },
      }),
      routingContext,
      undefined,
      options,
    )).toEqual({
      status: 'skip',
      reason: 'unverified_direct_address',
      sourceSpeakerName: 'MrDragonFox',
    });

    expect(resolveFactRouting(
      fact({
        text: 'MrDragonFox greeted the participant using Lyra as a display name.',
        attribution: {
          sourceMessageIds: [1],
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
      entry(1, 'dragon', 'MrDragonFox', 'hello Lyra', {
        metadata: addressedTo({
          authorId: 'current-companion-bot',
          authorName: 'Room Nickname',
        }),
      }),
      entry(2, 'dragon', 'MrDragonFox', 'hello Other Companion', {
        metadata: addressedTo({ authorId: 'imposter-bot', authorName: 'Lyra' }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'MrDragonFox addressed Lyra directly.',
        attribution: {
          sourceMessageIds: [1, 2],
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
      reason: 'unverified_direct_address',
      sourceSpeakerName: 'MrDragonFox',
    });
  });

  it('recognizes the current companion by transport author id when its room display name differs', async () => {
    const routingContext = await context([
      entry(1, 'dragon', 'MrDragonFox', 'hello there', {
        metadata: addressedTo({
          authorId: 'current-companion-bot',
          authorName: 'Room Nickname',
        }),
      }),
    ]);

    expect(resolveFactRouting(
      fact({
        text: 'MrDragonFox greeted Lyra.',
        attribution: {
          sourceMessageIds: [1],
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
