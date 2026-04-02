import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPANION_ID } from '../../identity/companion-naming.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import {
  buildDynamicPromptTemplateVariables,
  buildPromptTemplateVariables,
  buildRuntimeContext,
  getPersonaAdaptation,
  resolveAuthorContext,
} from './runtime-context.js';

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-runtime-context-1',
    channelId: 'internal:reflection:whisper',
    channelType: 'terminal',
    authorId: 'scheduler',
    authorName: 'Whisper',
    content: 'Reflect on recent activity.',
    timestamp: new Date('2026-03-17T12:00:00Z'),
    ...overrides,
  };
}

describe('runtime subject identity', () => {
  it('resolves internal reflection turns to the companion subject instead of the scheduler', async () => {
    const authorContext = await resolveAuthorContext({
      message: makeMessage(),
      contactStore: null,
      logger: {
        warn: () => undefined,
        debug: () => undefined,
      },
      companionIdentityKey: DEFAULT_COMPANION_ID,
      companionDisplayName: 'Companion',
    });

    expect(authorContext).toMatchObject({
      trustLevel: 'primary',
      speakerRole: 'system',
      resolvedUserName: 'Companion',
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      continuitySubjectKey: DEFAULT_COMPANION_ID,
    });
    expect(authorContext.canonicalContactKey).toBeUndefined();
  });

  it('uses the companion subject in prompt variables and runtime context for reflection turns', () => {
    const message = makeMessage();
    const { templateVariables } = buildPromptTemplateVariables({
      message,
      resolvedUserName: 'Companion',
      trustLevel: 'primary',
      channelType: 'internal',
      canonicalContactKey: undefined,
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      now: new Date('2026-03-17T12:00:00Z'),
      characterPromptVariables: {
        char_name: 'Companion',
        'character.visual_description': 'Silver eyes and a weathered jacket.',
      },
      modelId: 'test-model',
      fallbackCharacterName: 'Companion',
    });

    expect(templateVariables.user).toBe('Companion');
    expect(templateVariables.user_name).toBe('Companion');
    expect(templateVariables.user_id).toBe(DEFAULT_COMPANION_ID);
    expect(templateVariables.canonical_contact_id).toBe(DEFAULT_COMPANION_ID);

    const runtimeContext = buildRuntimeContext({
      message,
      resolvedUserName: 'Companion',
      trustLevel: 'primary',
      channelType: 'internal',
      canonicalContactKey: undefined,
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      taskKind: 'reflection',
      templateVariables,
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'nursery',
      activeToolCounts: {
        core: 0,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 0,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
    });

    expect(runtimeContext).toContain('<runtime_context>');
    expect(runtimeContext).toContain('This is an internal reflection turn.');
    expect(runtimeContext).not.toContain('userId: scheduler');
    expect(runtimeContext).not.toContain('Channel: internal:reflection:whisper');
    expect(runtimeContext).not.toContain('Appearance context: Silver eyes and a weathered jacket.');
  });

  it('marks ordinary external turns as user speakers', async () => {
    const authorContext = await resolveAuthorContext({
      message: makeMessage({
        channelId: 'api:general',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
      }),
      contactStore: null,
      logger: {
        warn: () => undefined,
        debug: () => undefined,
      },
      companionIdentityKey: DEFAULT_COMPANION_ID,
      companionDisplayName: 'Companion',
    });

    expect(authorContext.speakerRole).toBe('user');
  });

  it('uses the canonical contact key as the continuity subject when contact resolution succeeds', async () => {
    const authorContext = await resolveAuthorContext({
      message: makeMessage({
        channelId: 'discord:dm:alex',
        channelType: 'discord',
        authorId: 'discord-user-1',
        authorName: 'Alex',
      }),
      contactStore: {
        resolveChannelIdentity: () => ({
          id: 'contact-alex',
          discordUserId: 'discord-user-1',
          displayName: 'Alex',
          trustLevel: 'trusted',
          relationshipType: 'friend',
          firstSeen: '2026-03-17T12:00:00Z',
          lastSeen: '2026-03-17T12:00:00Z',
        }),
        getConversationChannelPrivacy: () => undefined,
        updateLastSeen: () => undefined,
        recordChannelActivity: () => undefined,
      } as never,
      logger: {
        warn: () => undefined,
        debug: () => undefined,
      },
      companionIdentityKey: DEFAULT_COMPANION_ID,
      companionDisplayName: 'Companion',
    });

    expect(authorContext).toMatchObject({
      canonicalContactKey: 'contact-alex',
      continuitySubjectKey: 'contact-alex',
      continuityFallbackKeys: ['discord-user-1'],
    });
  });

  it('uses routed channel privacy in prompt variables and runtime context', () => {
    const message = makeMessage({
      channelId: 'api:admin-broadcast',
      channelType: 'api',
      authorId: 'admin-user',
      authorName: 'Admin User',
      routing: {
        source: 'api',
        channelPrivacy: 'broadcast',
      },
    });

    const { templateVariables } = buildPromptTemplateVariables({
      message,
      resolvedUserName: 'Admin User',
      trustLevel: 'regular',
      channelType: 'api',
      canonicalContactKey: 'contact-admin',
      subjectIdentityKey: undefined,
      now: new Date('2026-03-17T12:00:00Z'),
      characterPromptVariables: {
        char_name: 'Companion',
      },
      modelId: 'test-model',
      fallbackCharacterName: 'Companion',
    });

    expect(templateVariables.channel_visibility).toBe('broadcast');

    const runtimeContext = buildRuntimeContext({
      message,
      resolvedUserName: 'Admin User',
      trustLevel: 'regular',
      channelType: 'api',
      canonicalContactKey: 'contact-admin',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      templateVariables,
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'nursery',
      activeToolCounts: {
        core: 0,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 0,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
    });

    expect(runtimeContext).toContain('Speaking with: Admin User (regular trust).');
    expect(runtimeContext).toContain('Channel: api (broadcast).');
  });

  it('does not expose appearance context for generic image tools', () => {
    const message = makeMessage({
      channelId: 'discord:dm:alex',
      channelType: 'discord',
      authorId: 'user-alex',
      authorName: 'Alex',
      content: 'send me a selfie',
    });

    const { templateVariables } = buildPromptTemplateVariables({
      message,
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      subjectIdentityKey: undefined,
      now: new Date('2026-03-17T12:00:00Z'),
      characterPromptVariables: {
        char_name: 'Companion',
        'character.visual_description': 'Silver eyes and a weathered jacket.',
      },
      modelId: 'test-model',
      fallbackCharacterName: 'Companion',
    });

    const runtimeContext = buildRuntimeContext({
      message,
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      templateVariables,
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'nursery',
      activeToolCounts: {
        core: 0,
        promoted: 0,
        extendedLoaded: 2,
        autoload: 2,
        deferred: 0,
        total: 2,
      },
      extendedTools: [],
      loadedExtended: new Map([
        ['image_create', {
          toolName: 'image_create',
          source: 'autoload',
          activatedAt: 1,
          lastActivatedAt: 1,
        }],
      ]),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
    });

    expect(runtimeContext).not.toContain('Appearance context: Silver eyes and a weathered jacket.');
    expect(runtimeContext).not.toContain('[Self-Image Tool Guidance]');
    expect(runtimeContext).not.toContain('Use selfie_create for a brand new selfie or self-portrait featuring you.');
  });

  it('exposes appearance context when the explicit selfie tool is active', () => {
    const message = makeMessage({
      channelId: 'discord:dm:alex',
      channelType: 'discord',
      authorId: 'user-alex',
      authorName: 'Alex',
      content: 'send me a selfie',
    });

    const { templateVariables } = buildPromptTemplateVariables({
      message,
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      subjectIdentityKey: undefined,
      now: new Date('2026-03-17T12:00:00Z'),
      characterPromptVariables: {
        char_name: 'Companion',
        'character.visual_description': 'Silver eyes and a weathered jacket.',
      },
      modelId: 'test-model',
      fallbackCharacterName: 'Companion',
    });

    const runtimeContext = buildRuntimeContext({
      message,
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      templateVariables,
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'nursery',
      activeToolCounts: {
        core: 0,
        promoted: 0,
        extendedLoaded: 2,
        autoload: 2,
        deferred: 0,
        total: 2,
      },
      extendedTools: [],
      loadedExtended: new Map([
        ['selfie_create', {
          toolName: 'selfie_create',
          source: 'autoload',
          activatedAt: 1,
          lastActivatedAt: 1,
        }],
      ]),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
    });

    expect(runtimeContext).toContain('<appearance_context>');
    expect(runtimeContext).toContain('Silver eyes and a weathered jacket.');
    expect(runtimeContext).toContain('<self_image_tool_guidance>');
    expect(runtimeContext).toContain('Use selfie_create for a brand new selfie or self-portrait featuring you.');
  });

  it('surfaces attention counts for pending whispers and active concerns', () => {
    const runtimeContext = buildRuntimeContext({
      message: makeMessage({
        channelId: 'internal:reflection:whisper',
        authorId: 'scheduler',
        authorName: 'Whisper',
        content: 'Review follow-ups before the next turn.',
      }),
      resolvedUserName: 'Companion',
      trustLevel: 'primary',
      channelType: 'internal',
      canonicalContactKey: undefined,
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      taskKind: 'heartbeat',
      templateVariables: {
        char_name: 'Companion',
      },
      internalState: {
        emotional: {
          vad: { valence: 0, arousal: 0, dominance: 0 },
          mood: { valence: 0, arousal: 0, dominance: 0 },
          discreteEmotions: {},
          confidence: 0,
        },
        cognitive: {
          certaintyLevel: 0,
          topicEngagement: 0,
          processingQuality: 'fluent',
        },
        attention: {
          activeConcerns: [
            {
              id: 'concern-1',
              text: 'Check whether the contact summary is stale.',
              priority: 'medium',
              source: 'heartbeat',
              createdAt: '2026-03-17T11:50:00.000Z',
              expiresAt: '2026-03-17T13:50:00.000Z',
            },
            {
              id: 'concern-2',
              text: 'Avoid re-surfacing the same cleanup task repeatedly.',
              priority: 'low',
              source: 'heartbeat',
              createdAt: '2026-03-17T11:55:00.000Z',
              expiresAt: '2026-03-17T19:55:00.000Z',
            },
          ],
          pendingFollowUps: [
            {
              id: 'follow-up-1',
              content: 'Check back on the unresolved follow-up.',
              priority: 'medium',
              timing: 'soon',
              channelId: 'internal:reflection:whisper',
              channelType: 'terminal',
              authorId: 'scheduler',
              authorName: 'Whisper',
              createdAt: '2026-03-17T11:58:00.000Z',
            },
          ],
          salientEntities: ['contact summary', 'follow-up'],
          conversationTrajectory: 'deepening',
        },
        relational: {
          contactId: DEFAULT_COMPANION_ID,
          trustLevel: 'primary',
          baselineValence: 0,
          moodDrift: 0,
          recentInteractionFrequency: 0.5,
          lastSeenDeltaSeconds: 42,
        },
      },
      activeToolCounts: {
        core: 0,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 0,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
    });

    expect(runtimeContext).toContain('<internal_state>');
    expect(runtimeContext).toContain('Attention: deepening, 2 open threads, 1 pending follow-up.');
    expect(runtimeContext).toContain('Relationship baseline: primary trust');
  });

  it('appends companion runtime guidance overrides when present', () => {
    const personaAdaptation = getPersonaAdaptation({
      trustLevel: 'trusted',
      internalState: {
        emotional: {
          vad: { valence: 0, arousal: 0, dominance: 0 },
          mood: { valence: 0, arousal: 0, dominance: 0 },
          discreteEmotions: {},
          confidence: 0,
        },
        cognitive: {
          certaintyLevel: 0,
          topicEngagement: 0,
          processingQuality: 'fluent',
        },
        attention: {
          activeConcerns: [],
          pendingFollowUps: [],
          salientEntities: [],
          conversationTrajectory: 'steady',
        },
        relational: {
          contactId: DEFAULT_COMPANION_ID,
          trustLevel: 'trusted',
          baselineValence: 0,
          moodDrift: 0,
          recentInteractionFrequency: 0,
          lastSeenDeltaSeconds: 0,
        },
      },
      metacognitiveFlags: [],
      templateVariables: {
        runtime_persona_adaptation_extra: 'Companion personality override.',
      },
      config: {},
    });

    expect(personaAdaptation).toContain('<companion_persona_adaptation>');
    expect(personaAdaptation).toContain('Companion personality override.');

    const runtimeContext = buildRuntimeContext({
      message: makeMessage(),
      resolvedUserName: 'Companion',
      trustLevel: 'trusted',
      channelType: 'internal',
      canonicalContactKey: undefined,
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      taskKind: 'reflection',
      templateVariables: {
        runtime_context_extra: 'Companion runtime context override.',
      },
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'nursery',
      activeToolCounts: {
        core: 0,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 0,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
    });

    expect(runtimeContext).toContain('<companion_runtime_context>');
    expect(runtimeContext).toContain('Companion runtime context override.');
  });

  it('exposes granular runtime prompt variables for editable prompt-owned phrasing', () => {
    const variables = buildDynamicPromptTemplateVariables({
      message: makeMessage({
        channelId: 'discord:dm:alex',
        channelType: 'discord_text',
        authorId: 'alex',
        authorName: 'Alex',
        content: 'hey',
      }),
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      responseStyle: 'expressive',
      now: new Date('2026-03-18T13:30:00Z'),
      templateVariables: {},
      modelId: 'test-model',
      capabilityTier: 'autonomous',
      activeToolCounts: {
        core: 2,
        promoted: 1,
        extendedLoaded: 1,
        autoload: 1,
        deferred: 0,
        total: 5,
      },
      extendedTools: [{ name: 'generate_image', description: 'Generate an image.' }] as any,
      loadedExtended: new Map([['generate_image', { source: 'autoload' }]]),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(['selfie_create']),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      lastMessageReceivedAtMs: new Date('2026-03-16T09:15:00Z').getTime(),
      config: {},
    });

    expect(variables.runtime_current_datetime_iso).toBe('2026-03-18T09:30:00.000-04:00');
    expect(variables.runtime_last_message_received_weekday).toBe('Monday');
    expect(variables.runtime_last_message_received_date_human).toBe('March 16, 2026');
    expect(variables.runtime_last_message_received_time_human).toBe('5:15 AM');
    expect(variables.runtime_last_message_received_days_hours).toBe('2 days 4 hours');
    expect(variables.runtime_response_style_name).toBe('Expressive');
    expect(variables.runtime_response_style_guidance_body).toBe(variables.runtime_response_style_guidance);
    expect(variables.runtime_tooling_active_count).toBe('5');
    expect(variables.runtime_tooling_available_extended_count).toBe('1');
  });

  it('uses persisted conversation-channel privacy and records it on activity', async () => {
    const recordedCalls: Array<{
      contactId: string;
      channel: string;
      channelId: string;
      privacyLevel?: string;
    }> = [];
    const authorContext = await resolveAuthorContext({
      message: makeMessage({
        channelId: '1313001762793197678',
        channelType: 'discord',
        authorId: '388908766306893854',
        authorName: 'Alex',
        content: 'hi',
      }),
      contactStore: {
        resolveChannelIdentity: () => ({
          id: 'contact-alex',
          displayName: 'Alex',
          trustLevel: 'trusted',
          relationshipType: 'partner',
          firstSeen: '2026-03-18T00:00:00.000Z',
          lastSeen: '2026-03-18T00:00:00.000Z',
        }),
        getConversationChannelPrivacy: () => 'private',
        recordChannelActivity: (
          contactId: string,
          channel: string,
          channelId: string,
          privacyLevel?: string,
        ) => {
          recordedCalls.push({ contactId, channel, channelId, privacyLevel });
        },
      } as any,
      logger: {
        warn: () => undefined,
        debug: () => undefined,
      },
      companionIdentityKey: DEFAULT_COMPANION_ID,
      companionDisplayName: 'Companion',
    });

    expect(authorContext.channelPrivacyLevel).toBe('private');
    expect(recordedCalls).toEqual([{
      contactId: 'contact-alex',
      channel: 'discord',
      channelId: '1313001762793197678',
      privacyLevel: 'private',
    }]);
  });
});
