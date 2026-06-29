import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANION_ID } from '../../identity/companion-naming.js';
import { injectPromptRuntimeTokens } from '../../identity/prompt-runtime.js';
import { composeDefaultRuntimePromptTemplate } from '../../identity/runtime-prompt-layers.js';
import { formatActiveConcernsContextBlock } from '../../intention/concerns.js';
import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { ApiHealthResponse, ApiHealthSubsystemStatus } from '../../../channels/api/types.js';
import type { SessionEntry } from '../../session/types.js';
import type { InternalState } from '../../self-model/state.js';
import {
  buildDynamicPromptTemplateVariables,
  buildPromptTemplateVariables,
  buildRuntimeContext,
  buildScratchpadContextBlock,
  getPersonaAdaptation,
  resolveAuthorContext,
  resolveIdentityChannel,
} from './runtime-context.js';
import {
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
} from '../../../shared/telemetry/run-charge.js';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';

afterEach(() => {
  resetRunChargeRollingWindowForTests();
});

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

function makeSessionEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    id: overrides.id ?? 1,
    channelId: overrides.channelId ?? 'discord:group:ops',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hello',
    timestamp: overrides.timestamp ?? 0,
    ...(overrides.authorId !== undefined ? { authorId: overrides.authorId } : {}),
    ...(overrides.authorName !== undefined ? { authorName: overrides.authorName } : {}),
    ...(overrides.discordMessageId !== undefined ? { discordMessageId: overrides.discordMessageId } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
    ...(overrides.originChannelId !== undefined ? { originChannelId: overrides.originChannelId } : {}),
    ...(overrides.channelVisibility !== undefined ? { channelVisibility: overrides.channelVisibility } : {}),
  };
}

const TEST_INTERNAL_STATE: InternalState = {
  emotional: {
    vad: {
      valence: 0.52,
      arousal: -0.18,
      dominance: 0.31,
    },
    mood: {
      valence: 0.24,
      arousal: -0.08,
      dominance: 0.12,
    },
    discreteEmotions: {
      joy: 0.7,
      trust: 0.25,
    },
    confidence: 0.84,
  },
  cognitive: {
    certaintyLevel: 0.66,
    topicEngagement: 0.38,
    processingQuality: 'fluent',
  },
  attention: {
    activeConcerns: [],
    pendingFollowUps: [],
    careReminders: [],
    salientEntities: [],
    conversationTrajectory: 'deepening',
  },
  relational: {
    contactId: 'contact-alex',
    trustLevel: 'trusted',
    baselineValence: 0.18,
    moodDrift: 0.05,
    recentInteractionFrequency: 0.33,
    lastSeenDeltaSeconds: 240,
  },
};

const METACOGNITIVE_FLAG_NAMES = [
  'uncertainty',
  'avoidance',
  'high_engagement',
  'repetition',
  'confabulation_risk',
] as const;

const DEFAULT_RUNTIME_PROMPT_TEMPLATE = composeDefaultRuntimePromptTemplate();
const TEST_RUNTIME_CONTEXT_LOGGER = {
  warn: () => undefined,
  debug: () => undefined,
};

const TEST_CHARGE_POLICY = {
  schemaVersion: 1,
  runChargeQuotaByLane: {
    interactive: 24,
    background: 16,
    maintenance: 0,
    subagent: 6,
    shard: 12,
  },
  surfaceCosts: {
    ownerFileInspection: 0,
    localFilesystem: 0,
    memoryRead: 0,
    memoryWrite: 0,
    localEmbedding: 0,
    externalEmbedding: 0,
    localImageGeneration: 0,
    paidImageGeneration: 6,
    analysisWorkbenchExtensionBand: 4,
    subagentLaunch: 1,
    shardLaunch: 8,
    externalModelConsult: 1,
    moaRoundBase: 1,
  },
  surfaceRationales: {
    paidImageGeneration: 'External image generation spends paid provider credits.',
    analysisWorkbenchExtensionBand: 'Extended analysis workbench loops reserve scarce deep-analysis budget after the first pass.',
    subagentLaunch: 'Spawning a subagent reserves a separate runtime budget.',
    shardLaunch: 'Launching a shard consumes worker coordination overhead.',
    externalModelConsult: 'Consulting an external model uses a paid API boundary.',
    moaRoundBase: 'Each MOA round carries coordination overhead even before model spend.',
  },
  moa: {
    perRoundMultiplierByReferenceModelClass: {
      local: 1,
      subscription: 1,
      cheap_cloud: 1,
      premium_cloud: 2,
    },
  },
  referenceModelClassPricing: {
    local: 0,
    subscription: 0,
    cheap_cloud: 1,
    premium_cloud: 4,
  },
  referenceModelClassPricingRationales: {
    cheap_cloud: 'Cheap cloud models are lightly priced to keep them available for routine use.',
    premium_cloud: 'Premium cloud models are intentionally more expensive to reserve for high-value calls.',
  },
  fatigue: makeTestFatiguePolicyConfig(),
};

function healthySubsystem(meta: Record<string, unknown> = { checkLatencyMs: 8 }): ApiHealthSubsystemStatus {
  return {
    status: 'healthy',
    meta,
  };
}

function makeApiHealthResponse(overrides: {
  subsystems?: Partial<ApiHealthResponse['subsystems']>;
  continuityChecks?: Partial<ApiHealthResponse['continuity']['checks']>;
  checkedAt?: string;
} = {}): ApiHealthResponse {
  const subsystems: ApiHealthResponse['subsystems'] = {
    memory: healthySubsystem({ checkLatencyMs: 7 }),
    llm: healthySubsystem({ probeLatencyMs: 18, checkLatencyMs: 19 }),
    discord: healthySubsystem(),
    embeddings: healthySubsystem({ probeLatencyMs: 11 }),
    scheduler: healthySubsystem(),
    ...(overrides.subsystems ?? {}),
  };
  const checks: ApiHealthResponse['continuity']['checks'] = {
    database: healthySubsystem(),
    gatewayLink: healthySubsystem(),
    schedulerHealthcheck: healthySubsystem(),
    ...(overrides.continuityChecks ?? {}),
  };
  const status = (
    Object.values(subsystems).every(subsystem => subsystem.status === 'healthy')
    && Object.values(checks).every(check => check.status === 'healthy')
  )
    ? 'healthy'
    : 'degraded';

  return {
    status,
    checkedAt: overrides.checkedAt ?? '2026-06-29T10:30:00.000Z',
    uptimeSeconds: 120,
    subsystems,
    continuity: {
      status: Object.values(checks).every(check => check.status === 'healthy') ? 'healthy' : 'degraded',
      checks,
    },
  };
}

function buildRuntimePromptOutputs(
  input: Parameters<typeof buildDynamicPromptTemplateVariables>[0],
): { variables: Record<string, string>; rendered: string } {
  const variables = buildDynamicPromptTemplateVariables(input);
  return {
    variables,
    rendered: injectPromptRuntimeTokens(DEFAULT_RUNTIME_PROMPT_TEMPLATE, {
      now: input.now,
      variables: {
        ...(input.templateVariables ?? {}),
        ...variables,
      },
    }),
  };
}

function renderPromptOwnedRuntimeLayers(
  input: Parameters<typeof buildDynamicPromptTemplateVariables>[0],
): string {
  return buildRuntimePromptOutputs(input).rendered;
}

function buildAtomicAffectTemplateOutput(
  input: Parameters<typeof buildDynamicPromptTemplateVariables>[0],
): string {
  const variables = buildDynamicPromptTemplateVariables(input);
  return injectPromptRuntimeTokens([
    'present={{runtime_affect_snapshot_present}}',
    'mode={{runtime_affect_mode}}',
    'warmth={{runtime_affect_warmth}}',
    'intensity={{runtime_affect_intensity}}',
    'valence={{runtime_affect_valence}}',
    'confidence={{runtime_affect_snapshot_confidence}}',
  ].join(' '), {
    now: input.now,
    variables: {
      ...(input.templateVariables ?? {}),
      ...variables,
    },
  });
}

function buildInternalStateTemplateOutput(
  input: Parameters<typeof buildDynamicPromptTemplateVariables>[0],
): string {
  const variables = buildDynamicPromptTemplateVariables(input);
  return injectPromptRuntimeTokens([
    'cognitive={{runtime_internal_state_cognitive_processing_quality}}/{{runtime_internal_state_cognitive_certainty_label}}/{{runtime_internal_state_cognitive_topic_engagement_label}}',
    'attention={{runtime_internal_state_attention_conversation_trajectory}}/{{runtime_internal_state_attention_active_concern_count}}/{{runtime_internal_state_attention_pending_follow_up_count}}',
    'relational={{runtime_internal_state_relational_trust_level}}/{{runtime_internal_state_relational_recent_interaction_frequency_label}}/{{runtime_internal_state_relational_last_seen_label}}',
    'emotional={{runtime_internal_state_emotional_mood_valence_label}}/{{runtime_internal_state_emotional_mood_arousal_label}}',
  ].join(' '), {
    now: input.now,
    variables: {
      ...(input.templateVariables ?? {}),
      ...variables,
    },
  });
}

function buildAtomicMetacognitionTemplateOutput(
  input: Parameters<typeof buildDynamicPromptTemplateVariables>[0],
): string {
  const variables = buildDynamicPromptTemplateVariables(input);
  return injectPromptRuntimeTokens([
    'uncertainty={{runtime_flag_uncertainty_present}}|{{runtime_flag_uncertainty_confidence}}|{{runtime_flag_uncertainty_evidence}}',
    'avoidance={{runtime_flag_avoidance_present}}|{{runtime_flag_avoidance_confidence}}|{{runtime_flag_avoidance_evidence}}',
    'confabulation={{runtime_flag_confabulation_risk_present}}|{{runtime_flag_confabulation_risk_confidence}}|{{runtime_flag_confabulation_risk_evidence}}',
  ].join(' '), {
    now: input.now,
    variables: {
      ...(input.templateVariables ?? {}),
      ...variables,
    },
  });
}

function buildMinimalRuntimeContextInput() {
  return {
    message: makeMessage({ channelId: 'api:general', channelType: 'api' as const }),
    resolvedUserName: 'User',
    trustLevel: 'primary' as const,
    channelType: 'api',
    canonicalContactKey: undefined,
    subjectIdentityKey: 'user-1',
    responseStyle: 'concise' as const,
    now: new Date('2026-06-10T12:00:00Z'),
    taskKind: 'chat',
    templateVariables: {},
    modelId: 'test-model',
    contextWindow: 4096,
    capabilityTier: 'nursery' as const,
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
    classifyExtendedToolForTurn: () => 'overlay' as const,
    promotedExtendedToolNames: new Set<string>(),
    formatTopEmotions: () => '',
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

  it('binds routed internal reflection turns to the canonical contact while keeping the companion subject', async () => {
    const authorContext = await resolveAuthorContext({
      message: makeMessage({
        authorId: 'contact-primary',
        routing: {
          canonicalContactId: 'contact-primary',
        },
      }),
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
      canonicalContactKey: 'contact-primary',
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      continuitySubjectKey: DEFAULT_COMPANION_ID,
    });
  });

  it('renders prompt-owned runtime layers for reflection turns against the companion subject', () => {
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

    const { rendered, variables } = buildRuntimePromptOutputs({
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
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    });

    expect(variables.runtime_internal_turn_kind).toBe('reflection');
    expect(variables.runtime_speaking_with_name).toBe('');
    expect(variables.runtime_appearance_context_body).toBe('');
    expect(rendered).toContain('<internal_turn_context>');
    expect(rendered).toContain('<kind>reflection</kind>');
    expect(rendered).not.toContain('userId: scheduler');
    expect(rendered).not.toContain('Channel: internal:reflection:whisper');
    expect(rendered).not.toContain('<appearance_context>');
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
    expect(runtimeContext).not.toContain('<runtime_substrate_health>');
    expect(runtimeContext).not.toContain('<companion_runtime_context>');
    expect(runtimeContext).not.toContain('userId: scheduler');
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

  it('marks system-prefixed external turns as system speakers even without provenance', async () => {
    const authorContext = await resolveAuthorContext({
      message: makeMessage({
        channelId: 'api:general',
        channelType: 'api',
        authorId: 'system:subagent-task',
        authorName: 'SubagentTask',
      }),
      contactStore: null,
      logger: {
        warn: () => undefined,
        debug: () => undefined,
      },
      companionIdentityKey: DEFAULT_COMPANION_ID,
      companionDisplayName: 'Companion',
    });

    expect(authorContext).toMatchObject({
      trustLevel: 'regular',
      speakerRole: 'system',
      resolvedUserName: 'SubagentTask',
      continuitySubjectKey: 'system:subagent-task',
      continuityFallbackKeys: [],
    });
  });

  it('resolves generated handoff trust from source provenance without treating it as user speech', async () => {
    const getByChannelIdentity = vi.fn(() => ({
      id: 'contact-v',
      discordUserId: undefined,
      displayName: 'V',
      trustLevel: 'trusted',
      relationshipType: 'partner',
      firstSeen: '2026-03-17T12:00:00Z',
      lastSeen: '2026-03-17T12:00:00Z',
      channelIdentities: [{ channel: 'api', userId: 'api-user-1' }],
    }));
    const getConversationChannelPrivacy = vi.fn(() => 'private');
    const updateLastSeen = vi.fn();
    const recordChannelActivity = vi.fn();

    const authorContext = await resolveAuthorContext({
      message: makeMessage({
        id: 'deferred-tool-handoff:action-1',
        channelId: 'api:session-1',
        channelType: 'api',
        authorId: 'system:tool_handoff',
        authorName: 'Tool Handoff',
        routing: {
          generated: {
            kind: 'deferred_tool_handoff',
            sourceMessageId: 'source-turn-1',
            sourceChannelId: 'api:session-1',
            sourceAuthorId: 'api-user-1',
            sourceAuthorName: 'V',
          },
        },
      }),
      contactStore: {
        getById: () => undefined,
        getByChannelIdentity,
        getConversationChannelPrivacy,
        updateLastSeen,
        recordChannelActivity,
      } as never,
      logger: {
        warn: () => undefined,
        debug: () => undefined,
      },
      companionIdentityKey: DEFAULT_COMPANION_ID,
      companionDisplayName: 'Companion',
    });

    expect(authorContext).toMatchObject({
      trustLevel: 'trusted',
      speakerRole: 'system',
      resolvedUserName: 'Tool Handoff',
      canonicalContactKey: 'contact-v',
      continuitySubjectKey: 'contact-v',
      channelPrivacyLevel: 'private',
      continuityFallbackKeys: ['api-user-1'],
    });
    expect(getByChannelIdentity).toHaveBeenCalledWith('api', 'api-user-1');
    expect(getConversationChannelPrivacy).toHaveBeenCalledWith('contact-v', 'api', 'api:session-1');
    expect(updateLastSeen).not.toHaveBeenCalled();
    expect(recordChannelActivity).not.toHaveBeenCalled();
  });

  it('renders charge budget guidance outside the static prompt prefix', () => {
    const message = makeMessage({
      channelId: 'api:general',
      channelType: 'api',
      authorId: 'user-1',
      authorName: 'User',
    });

    const runtimeContext = buildRuntimeContext({
      message,
      resolvedUserName: 'User',
      trustLevel: 'primary',
      channelType: 'api',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'autonomous',
      activeToolCounts: {
        core: 6,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 6,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
      config: { chargePolicy: TEST_CHARGE_POLICY },
    });

    expect(runtimeContext).toContain('<runtime_charge_budget>');
    expect(runtimeContext).toContain('You have 24 of 24 run-charge units left for the interactive lane/window.');
    expect(runtimeContext).toContain('Available charge action costs:');
    expect(runtimeContext).toContain('paid image/video generation: 6');
    expect(runtimeContext).not.toContain('analysis_workbench extension pass after the first iteration: 4');
    expect(runtimeContext).not.toContain('analysis_workbench first pass: 0 charge units');
    expect(runtimeContext).not.toContain('Use analysis_workbench only');
    expect(runtimeContext).not.toContain('visible in Garden Charge / Budget');
    expect(runtimeContext).not.toContain('think');
  });

  it('lists Workbench extension cost only when analysis_workbench is available', async () => {
    const runtimeContext = await runWithChargeContext({
      chargePolicy: TEST_CHARGE_POLICY,
      lane: 'interactive',
      runId: 'charge-workbench-available',
    }, async () => buildRuntimeContext({
      message: makeMessage({
        channelId: 'api:general',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
      }),
      resolvedUserName: 'User',
      trustLevel: 'primary',
      channelType: 'api',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'autonomous',
      activeToolCounts: {
        core: 6,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 6,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
      config: { chargePolicy: TEST_CHARGE_POLICY },
      analysisWorkbenchAvailable: true,
    }));

    expect(runtimeContext).toContain('analysis_workbench extension pass after the first iteration: 4');
    expect(runtimeContext).not.toContain('analysis_workbench first pass: 0 charge units');
    expect(runtimeContext).not.toContain('Use analysis_workbench only');
  });

  it('renders satellite endpoint capability context for registered mobile speech turns', () => {
    const message = makeMessage({
      channelId: 'satellite:android-mobile:weekend-walk',
      channelType: 'api',
      authorId: 'primary-user',
      authorName: 'Primary User',
      routing: {
        source: 'satellite',
        channelPrivacy: 'private',
        canonicalContactId: 'contact-primary-user',
        satellite: {
          schemaVersion: 1,
          satelliteId: 'android-phone',
          satelliteDisplayName: 'Android Mobile Satellite',
          endpointId: 'companion-app',
          endpointDisplayName: 'Companion App',
          claimType: 'android-mobile',
          sessionId: 'weekend-walk',
          mobility: 'mobile',
          promptChannelType: 'mobile_satellite',
          capabilities: {
            advertised: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech', 'vision'],
            registryMax: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech', 'vision', 'robotics'],
            effective: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech', 'vision'],
            policyDenied: ['robotics'],
          },
          telemetryScopes: ['location', 'timezone'],
          auth: {
            mode: 'api_key',
            principalId: 'api-key-test',
            certBound: false,
          },
        },
      },
    });

    const runtimeContext = buildRuntimeContext({
      message,
      resolvedUserName: 'Primary User',
      trustLevel: 'primary',
      channelType: 'api',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'autonomous',
      activeToolCounts: {
        core: 6,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 6,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      formatTopEmotions: () => '',
      config: {},
    });

    expect(runtimeContext).toContain('<runtime_satellite_endpoint>');
    expect(runtimeContext).toContain('Effective capabilities: text, audio_input, speech_to_text, audio_output, text_to_speech, vision');
    expect(runtimeContext).toContain('Policy-denied or not-yet-modeled capabilities: robotics');
    expect(runtimeContext).toContain('ordinary replies may be spoken by the satellite');
    expect(resolveIdentityChannel(message)).toBe('satellite:android-mobile');
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
        getEmotionalTimeSeries: () => [],
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

  it('renders routed channel privacy through the prompt-owned runtime layers', () => {
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

    const renderedRuntimeLayers = renderPromptOwnedRuntimeLayers({
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
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    });

    expect(renderedRuntimeLayers).toContain('<conversation_state>');
    expect(renderedRuntimeLayers).toContain('<chat_type>group</chat_type>');
    expect(renderedRuntimeLayers).toContain('<channel_id>api:admin-broadcast</channel_id>');
    expect(renderedRuntimeLayers).toContain('<channel_type>api</channel_type>');
    expect(renderedRuntimeLayers).toContain('<channel_visibility>broadcast</channel_visibility>');
    expect(renderedRuntimeLayers).toContain('<current_message_author name="Admin User" id="admin-user" trust="regular" />');
    expect(renderedRuntimeLayers).not.toContain('<speaking_with>');
  });

  it('keeps appearance variables available for chat when generic media tools are active', () => {
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

    const { rendered, variables } = buildRuntimePromptOutputs({
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
        ['media', {
          toolName: 'media',
          source: 'autoload',
          activatedAt: 1,
          lastActivatedAt: 1,
        }],
      ]),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    });

    expect(variables.runtime_self_image_tool_active).toBe('false');
    expect(variables.runtime_appearance_context_body).toBe(
      templateVariables['character.visual_description'],
    );
    expect(rendered).not.toContain('<appearance_context>');
    expect(rendered).not.toContain('<self_image_tool_guidance>');
  });

  it('keeps appearance variables available for chat when the unified media tool is active', () => {
    const message = makeMessage({
      channelId: 'discord:dm:alex',
      channelType: 'discord',
      authorId: 'user-alex',
      authorName: 'Alex',
      content: 'send me a portrait',
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

    const { rendered, variables } = buildRuntimePromptOutputs({
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
        extendedLoaded: 1,
        autoload: 1,
        deferred: 0,
        total: 1,
      },
      extendedTools: [],
      loadedExtended: new Map([
        ['media', {
          toolName: 'media',
          source: 'autoload',
          activatedAt: 1,
          lastActivatedAt: 1,
        }],
      ]),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    });

    expect(variables.runtime_self_image_tool_active).toBe('false');
    expect(variables.runtime_appearance_context_body).toBe(
      templateVariables['character.visual_description'],
    );
    expect(rendered).not.toContain('<appearance_context>');
    expect(rendered).not.toContain('<self_image_tool_guidance>');
  });

  it('activates selfie guidance while appearance stays in static foundation context', () => {
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

    const { rendered, variables } = buildRuntimePromptOutputs({
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
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    });

    expect(variables.runtime_self_image_tool_active).toBe('true');
    expect(variables.runtime_appearance_context_body).toBe(
      templateVariables['character.visual_description'],
    );
    expect(rendered).not.toContain('<appearance_context>');
    expect(rendered).toContain('<self_image_tool_guidance>');
    expect(rendered).toContain('character appearance section');
  });

  it('surfaces attention counts for pending whispers and active concerns through prompt-owned layers', () => {
    const { rendered, variables } = buildRuntimePromptOutputs({
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
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    });

    expect(variables.runtime_internal_state_attention_conversation_trajectory).toBe('deepening');
    expect(variables.runtime_internal_state_attention_active_concern_count).toBe('2');
    expect(variables.runtime_internal_state_attention_pending_follow_up_count).toBe('1');
    expect(variables.runtime_internal_state_relational_trust_level).toBe('primary');
    expect(rendered).not.toContain('<internal_state>');
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

  it('caps scratchpad prompt context and keeps stale omitted notes as metadata only', () => {
    const recentUsefulNote = 'Recent useful note: preserve PSFN-h00b acceptance context.';
    const staleFullText = 'STALE_FULL_TEXT_SHOULD_NOT_APPEAR '.repeat(80);
    const entries = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `recent-${index}`,
        content: index === 0
          ? recentUsefulNote
          : `Recent useful note ${index}: keep prompt-visible scratchpad context concise.`,
        createdAt: Date.parse('2026-05-11T04:00:00.000Z') + index,
        updatedAt: Date.parse('2026-05-11T04:10:00.000Z') + index,
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `stale-${index}`,
        content: `${staleFullText}${index}`,
        createdAt: Date.parse('2026-05-10T04:00:00.000Z') + index,
        updatedAt: Date.parse('2026-05-10T04:10:00.000Z') + index,
      })),
    ];

    const block = buildScratchpadContextBlock({
      scratchpadProvider: {
        listScratchpadEntries: (limit?: number) => {
          expect(limit).toBe(64);
          return entries;
        },
      },
      logger: TEST_RUNTIME_CONTEXT_LOGGER,
    });

    expect(block).toContain(recentUsefulNote);
    expect(block).toContain('additional notes omitted for context budget');
    expect(block).toContain('Older/stale metadata');
    expect(block).toContain('newest omitted updated');
    expect(block).not.toContain('STALE_FULL_TEXT_SHOULD_NOT_APPEAR');
    expect(block.length).toBeLessThan(2_000);
  });

  it('keeps recent useful scratchpad notes visible while total chars stop stale bloat', () => {
    const stalePayload = 'outdated bulk scratchpad source text '.repeat(120);
    const entries = [
      {
        id: 'recent-actionable',
        content: 'Recent useful note: run targeted runtime-context and core-memory tests.',
        createdAt: Date.parse('2026-05-11T04:00:00.000Z'),
        updatedAt: Date.parse('2026-05-11T04:15:00.000Z'),
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `recent-budget-${index}`,
        content: `Recent budget filler ${index}: ${'keep only fresh scratchpad context '.repeat(12)}`,
        createdAt: Date.parse('2026-05-11T04:01:00.000Z') + index,
        updatedAt: Date.parse('2026-05-11T04:14:00.000Z') + index,
      })),
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `old-bulk-${index}`,
        content: stalePayload,
        createdAt: Date.parse('2026-05-09T04:00:00.000Z') + index,
        updatedAt: Date.parse('2026-05-09T04:10:00.000Z') + index,
      })),
    ];

    const block = buildScratchpadContextBlock({
      scratchpadProvider: {
        listScratchpadEntries: () => entries,
      },
      logger: TEST_RUNTIME_CONTEXT_LOGGER,
    });
    const visibleEntries = block
      .split('\n')
      .filter(line => line.startsWith('- ') && !line.includes('omitted for context budget'));

    expect(block).toContain('Recent useful note: run targeted runtime-context and core-memory tests.');
    expect(visibleEntries.length).toBeLessThanOrEqual(8);
    expect(block).toContain('additional notes omitted for context budget');
    expect(block).not.toContain(stalePayload);
    expect(block.length).toBeLessThan(2_000);
  });

  it('exposes granular runtime prompt variables for editable prompt-owned phrasing', () => {
    const variables = buildDynamicPromptTemplateVariables({
      message: makeMessage({
        channelId: 'discord:dm:alex',
        channelType: 'discord_text',
        isDirectMessage: true,
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
    expect(variables.runtime_current_today).toBe('2026-03-18');
    expect(variables.runtime_current_yesterday).toBe('2026-03-17');
    expect(variables.runtime_current_tomorrow).toBe('2026-03-19');
    expect(variables.runtime_current_part_of_day).toBe('late morning');
    expect(variables.runtime_last_message_received_weekday).toBe('Monday');
    expect(variables.runtime_last_message_received_date_human).toBe('March 16, 2026');
    expect(variables.runtime_last_message_received_time_human).toBe('5:15 AM');
    expect(variables.runtime_last_message_received_timezone).toBe('America/New_York');
    expect(variables.runtime_last_message_received_days_hours).toBe('2 days 4 hours');
    expect(variables.runtime_last_message_received_missing_notice).toBe('');
    expect(variables.runtime_speaking_with_trust_level).toBe('trusted');
    expect(variables.runtime_chat_type).toBe('direct_message');
    expect(variables.runtime_room_id).toBe('discord:dm:alex');
    expect(variables.runtime_current_message_author_name).toBe('Alex');
    expect(variables.runtime_current_message_author_id).toBe('alex');
    expect(variables.runtime_current_message_author_trust_level).toBe('trusted');
    expect(variables.runtime_current_message_author_relationship).toBe('');
    expect(variables.runtime_current_message_author_xml).toBe('<current_message_author name="Alex" id="alex" trust="trusted" />');
    expect(variables.runtime_current_message_author_timezone).toBe('');
    expect(variables.runtime_current_message_author_local_time).toBe('');
    expect(variables.runtime_recent_active_participants_xml).toBe('');
    expect(variables.runtime_recent_active_participants_count).toBe('0');
    expect(variables.runtime_channel_visibility).toBe('private');
    expect(variables.runtime_response_style).toBe('expressive');
    expect(variables.runtime_response_style_name).toBe('Expressive');
    expect('runtime_response_style_guidance_body' in variables).toBe(false);
    expect('runtime_response_style_delivery_guidance' in variables).toBe(false);
    expect('runtime_response_style_expansion_guidance' in variables).toBe(false);
    expect(variables.runtime_tooling_active_count).toBe('5');
    expect(variables.runtime_tooling_available_extended_count).toBe('1');
  });

  it('renders group conversation_state with five recent active participants newest-first', () => {
    const { rendered, variables } = buildRuntimePromptOutputs({
      message: makeMessage({
        channelId: 'discord:group:ops',
        channelType: 'discord',
        isDirectMessage: false,
        authorId: 'discord:u-current',
        authorName: 'Vega "Pilot"',
        content: 'status?',
      }),
      resolvedUserName: 'Vega',
      trustLevel: 'trusted',
      relationshipType: 'friend',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-vega',
      responseStyle: 'concise',
      now: new Date('2026-03-18T13:30:00Z'),
      templateVariables: {},
      modelId: 'test-model',
      capabilityTier: 'autonomous',
      activeToolCounts: {
        core: 2,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 2,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      currentUserRuntimeProfile: {
        user_id: 'discord:u-current',
        display_name: 'Vega',
        timezone: 'America/Chicago',
      },
      recentActiveParticipantRuntimeProfiles: [
        { user_id: 'discord:u-b', display_name: 'Basil', timezone: 'Europe/London' },
        { user_id: 'discord:u-g', display_name: 'Gale', timezone: 'Asia/Tokyo' },
        { user_id: 'discord:u-f', display_name: 'Fenn', timezone: 'Not/AZone' },
      ],
      recentChannelEntries: [
        makeSessionEntry({ id: 1, authorId: 'discord:u-a', authorName: 'Aster', timestamp: 1000 }),
        makeSessionEntry({ id: 2, authorId: 'discord:u-b', authorName: 'Basil old', timestamp: 2000 }),
        makeSessionEntry({ id: 3, authorId: 'discord:u-c', authorName: 'Cyra', timestamp: 3000 }),
        makeSessionEntry({ id: 4, authorId: 'discord:u-d', authorName: 'Dax', timestamp: 4000 }),
        makeSessionEntry({ id: 5, authorId: 'discord:u-e', authorName: 'Echo', timestamp: 5000 }),
        makeSessionEntry({ id: 6, authorId: 'discord:u-f', authorName: 'Fenn', timestamp: 6000 }),
        makeSessionEntry({ id: 7, authorId: 'discord:u-g', authorName: 'Gale', timestamp: 7000 }),
        makeSessionEntry({ id: 8, authorId: 'discord:u-b', authorName: 'Basil', timestamp: 8000 }),
        makeSessionEntry({ id: 9, role: 'assistant', authorId: 'companion', authorName: 'Companion', timestamp: 9000 }),
      ],
      config: {},
    });

    expect(variables.runtime_chat_type).toBe('group');
    expect(variables.runtime_room_id).toBe('discord:group:ops');
    expect(variables.runtime_current_message_author_name).toBe('Vega "Pilot"');
    expect(variables.runtime_current_message_author_name_xml_attr).toBe('Vega &quot;Pilot&quot;');
    expect(variables.runtime_current_message_author_timezone).toBe('America/Chicago');
    expect(variables.runtime_current_message_author_local_time).toBe('8:30 AM');
    expect(variables.runtime_current_message_author_trust_level).toBe('trusted');
    expect(variables.runtime_current_message_author_relationship).toBe('friend');
    expect(variables.runtime_current_message_author_xml).toBe(
      '<current_message_author name="Vega &quot;Pilot&quot;" id="discord:u-current" trust="trusted" relationship="friend" timezone="America/Chicago" local_time="8:30 AM" />',
    );
    expect(variables.runtime_recent_active_participants_count).toBe('5');
    expect(variables.runtime_recent_active_participants_xml.match(/<participant\b/gu)).toHaveLength(5);
    expect(variables.runtime_recent_active_participants_xml).toContain(
      '<participant name="Basil" id="discord:u-b" timezone="Europe/London" local_time="1:30 PM" />',
    );
    expect(variables.runtime_recent_active_participants_xml).toContain(
      '<participant name="Gale" id="discord:u-g" timezone="Asia/Tokyo" local_time="10:30 PM" />',
    );
    expect(variables.runtime_recent_active_participants_xml).toContain('<participant name="Fenn" id="discord:u-f" />');
    expect(variables.runtime_recent_active_participants_xml).toContain('<participant name="Echo" id="discord:u-e" />');
    expect(variables.runtime_recent_active_participants_xml).toContain('<participant name="Dax" id="discord:u-d" />');
    expect(variables.runtime_recent_active_participants_xml).not.toContain('Cyra');
    expect(variables.runtime_recent_active_participants_xml).not.toContain('Aster');
    expect(variables.runtime_recent_active_participants_xml).not.toContain('Companion');

    const participantXml = variables.runtime_recent_active_participants_xml;
    expect(participantXml.indexOf('Basil')).toBeLessThan(participantXml.indexOf('Gale'));
    expect(participantXml.indexOf('Gale')).toBeLessThan(participantXml.indexOf('Fenn'));
    expect(participantXml.indexOf('Fenn')).toBeLessThan(participantXml.indexOf('Echo'));
    expect(participantXml.indexOf('Echo')).toBeLessThan(participantXml.indexOf('Dax'));
    expect(rendered).toContain('<conversation_state>');
    expect(rendered).toContain('<chat_type>group</chat_type>');
    expect(rendered).toContain('<channel_id>discord:group:ops</channel_id>');
    expect(rendered).toContain('<current_message_author name="Vega &quot;Pilot&quot;" id="discord:u-current" trust="trusted" relationship="friend" timezone="America/Chicago" local_time="8:30 AM" />');
    expect(rendered).toContain('<recent_active_participants max="5">');
  });

  it('does not render a fake participant list for direct messages', () => {
    const { rendered, variables } = buildRuntimePromptOutputs({
      message: makeMessage({
        channelId: 'discord:dm:alex',
        channelType: 'discord',
        isDirectMessage: true,
        authorId: 'discord:u-alex',
        authorName: 'Alex',
        content: 'ping',
      }),
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      responseStyle: 'concise',
      now: new Date('2026-03-18T13:30:00Z'),
      templateVariables: {},
      modelId: 'test-model',
      capabilityTier: 'autonomous',
      activeToolCounts: {
        core: 2,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 2,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      currentUserRuntimeProfile: {
        user_id: 'discord:u-alex',
        display_name: 'Alex',
        timezone: 'America/Los_Angeles',
      },
      recentChannelEntries: [
        makeSessionEntry({ channelId: 'discord:dm:alex', id: 1, authorId: 'discord:u-alex', authorName: 'Alex', timestamp: 1000 }),
      ],
      config: {},
    });

    expect(variables.runtime_chat_type).toBe('direct_message');
    expect(variables.runtime_current_message_author_timezone).toBe('America/Los_Angeles');
    expect(variables.runtime_current_message_author_local_time).toBe('6:30 AM');
    expect(variables.runtime_recent_active_participants_xml).toBe('');
    expect(variables.runtime_recent_active_participants_count).toBe('0');
    expect(rendered).toContain('<chat_type>direct_message</chat_type>');
    expect(rendered).toContain('<current_message_author name="Alex" id="discord:u-alex" trust="trusted" timezone="America/Los_Angeles" local_time="6:30 AM" />');
    expect(rendered).not.toContain('<recent_active_participants');
  });

  it('does not render hardcoded Analyst Workbench guidance from default runtime layers', () => {
    const baseInput = {
      message: makeMessage({
        channelId: 'api:worker',
        channelType: 'api',
        authorId: 'worker',
        authorName: 'Worker',
        content: 'analyze this evidence set',
      }),
      resolvedUserName: 'Worker',
      trustLevel: 'regular' as const,
      channelType: 'api',
      responseStyle: 'concise' as const,
      now: new Date('2026-03-18T13:30:00Z'),
      templateVariables: {},
      modelId: 'test-model',
      capabilityTier: 'autonomous' as const,
      activeToolCounts: {
        core: 2,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 2,
      },
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay' as const,
      promotedExtendedToolNames: new Set<string>(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    };

    const unavailable = buildRuntimePromptOutputs({
      ...baseInput,
      analysisWorkbenchAvailable: false,
    });
    const available = buildRuntimePromptOutputs({
      ...baseInput,
      analysisWorkbenchAvailable: true,
    });

    expect(unavailable.variables.runtime_analysis_workbench_available).toBe('false');
    expect(available.variables.runtime_analysis_workbench_available).toBe('true');
    expect(unavailable.rendered).not.toContain('<analysis_workbench_guidance>');
    expect(available.rendered).not.toContain('<analysis_workbench_guidance>');
    expect(available.rendered).not.toContain('analysis_workbench is a large-evidence escalation surface only.');
  });

  it('substitutes atomic affect macros under both honne and tatemae trust tiers', () => {
    const baseInput = {
      message: makeMessage({
        channelId: 'discord:dm:alex',
        channelType: 'discord_text',
        authorId: 'alex',
        authorName: 'Alex',
        content: 'hey',
      }),
      resolvedUserName: 'Alex',
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
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay' as const,
      promotedExtendedToolNames: new Set<string>(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
      internalState: TEST_INTERNAL_STATE,
    };

    const honneOutput = buildAtomicAffectTemplateOutput({
      ...baseInput,
      trustLevel: 'primary',
    });
    const tatemaeOutput = buildAtomicAffectTemplateOutput({
      ...baseInput,
      trustLevel: 'trusted',
    });

    expect(honneOutput).toContain('present=true');
    expect(honneOutput).toContain('mode=honne');
    expect(honneOutput).not.toContain('{{');

    expect(tatemaeOutput).toContain('present=true');
    expect(tatemaeOutput).toContain('mode=tatemae');
    expect(tatemaeOutput).not.toContain('{{');
  });

  it('substitutes atomic internal-state macros using the existing describe helper labels', () => {
    const baseInput = {
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
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay' as const,
      promotedExtendedToolNames: new Set<string>(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
      internalState: TEST_INTERNAL_STATE,
    };

    const output = buildInternalStateTemplateOutput(baseInput);

    expect(output).toBe(
      'cognitive=fluent/steady/engaged attention=deepening/0/0 relational=trusted/occasional/just interacted emotional=warm/calm',
    );
  });

  it('substitutes atomic concern, tooling, behavioral-note, skills, and appraisal macros', () => {
    const emotionAppraisalChain = [
      {
        timestamp: '2026-03-17T09:00:00.000Z',
        trigger: 'user_checkin',
        summary: 'She opened cautiously and needed a little grounding before discussing the plan.',
      },
      {
        timestamp: '2026-03-17T10:30:00.000Z',
        trigger: 'shared_joke',
        summary: 'A quick joke lightened the mood and brought her energy back up.',
      },
      {
        timestamp: '2026-03-17T12:00:00.000Z',
        trigger: 'repair',
        summary: 'Latest summary',
      },
    ] as const;
    const variables = buildDynamicPromptTemplateVariables({
      message: makeMessage({
        channelId: 'api:test',
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Focus.',
      }),
      resolvedUserName: 'User',
      trustLevel: 'regular',
      channelType: 'api',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      templateVariables: {},
      modelId: 'test-model',
      capabilityTier: 'nursery',
      activeToolCounts: {
        core: 1,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 1,
      },
      extendedTools: [
        {
          name: 'web',
          description: 'Fetch a web page.',
          parameters: {} as any,
          execute: () => { throw new Error('not used'); },
        } as any,
        {
          name: 'notify',
          description: 'Notify the operator.',
          parameters: {} as any,
          execute: () => { throw new Error('not used'); },
        } as any,
        {
          name: 'background_probe',
          description: 'Observe long-running background state.',
          parameters: {} as any,
          execute: () => { throw new Error('not used'); },
        } as any,
      ],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: (toolName) => (toolName === 'background_probe' ? 'background' : 'overlay'),
      promotedExtendedToolNames: new Set(),
      skillsContext: '<skills_index><skill name="conversation" /><skill name="memory" /></skills_index>',
      activeConcernsBlock: formatActiveConcernsContextBlock([
        {
          id: 'concern-1',
          text: 'medication reminder logistics',
          priority: 'high',
          source: 'agent',
          createdAt: '2026-02-01T10:00:00.000Z',
          expiresAt: '2026-02-01T11:00:00.000Z',
        },
        {
          id: 'concern-2',
          text: 'sleep schedule drift',
          priority: 'low',
          source: 'agent',
          createdAt: '2026-02-01T10:00:00.000Z',
          expiresAt: '2026-02-01T12:00:00.000Z',
        },
        {
          id: 'concern-3',
          text: 'hydration routine check',
          priority: 'low',
          source: 'agent',
          createdAt: '2026-02-01T10:00:00.000Z',
          expiresAt: '2026-02-01T13:00:00.000Z',
        },
      ], 2),
      behavioralNotesBlock: [
        '<behavioral_notes>',
        '- validation: avg +0.45 over 1 outcome sample(s), 100% positive',
        '- curiosity: avg +0.30 over 2 outcome sample(s), 100% positive',
        '</behavioral_notes>',
      ].join('\n'),
      emotionAppraisalChain,
      config: {},
    });

    expect(variables.runtime_concerns_count).toBe('3');
    expect(variables.runtime_concerns_top_priorities).toBe('high, low');
    expect(variables.runtime_concerns_omitted_count).toBe('1');
    expect(variables.runtime_concerns_top_lines).toContain('medication reminder logistics');
    expect(variables.runtime_concerns_top_lines).toContain('sleep schedule drift');
    expect(variables.runtime_behavioral_notes_count).toBe('2');
    expect(variables.runtime_skills_count).toBe('2');
    expect(variables.runtime_extended_tools_total).toBe('3');
    expect(variables.runtime_extended_tools_activatable_count).toBe('1');
    expect(variables.runtime_extended_tools_blocked_count).toBe('1');
    expect(variables.runtime_extended_tool_names).toBe('web, notify, background_probe');
    expect(variables.runtime_extended_tool_directory_lines).toContain(
      '- web: Fetch a web page (use toolset action="activate")',
    );
    expect(variables.runtime_extended_tool_directory_lines).toContain(
      '- notify: Notify the operator (blocked by current tier: external.web, external.discord, external.email)',
    );
    expect(variables.runtime_extended_tool_directory_lines).toContain(
      '- background_probe: Observe long-running background state (background-only; not callable in-turn)',
    );
    expect(variables.runtime_emotion_appraisal_length).toBe(String(emotionAppraisalChain.length));
    expect(variables.runtime_emotion_appraisal_latest_trigger).toBe(
      emotionAppraisalChain[emotionAppraisalChain.length - 1]?.trigger ?? '',
    );
    expect(variables.runtime_emotion_appraisal_latest_summary).toBe(
      emotionAppraisalChain[emotionAppraisalChain.length - 1]?.summary ?? '',
    );
    expect(variables.runtime_emotion_appraisal_latest_timestamp_iso).toBe(
      emotionAppraisalChain[emotionAppraisalChain.length - 1]?.timestamp ?? '',
    );
    const appraisalLines = variables.runtime_emotion_appraisal_recent_lines.split('\n');
    expect(appraisalLines).toHaveLength(2);
    expect(appraisalLines[0]).toContain(`(${emotionAppraisalChain[1].trigger}):`);
    expect(appraisalLines[1]).toContain(`(${emotionAppraisalChain[2].trigger}):`);
  });

  it('substitutes atomic metacognition macros while preserving wrapped persona guidance', () => {
    const baseInput = {
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
      extendedTools: [],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay' as const,
      promotedExtendedToolNames: new Set<string>(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
      internalState: TEST_INTERNAL_STATE,
      metacognitiveFlags: [
        {
          flag: 'uncertainty' as const,
          confidence: 0.583,
          evidence: 'certainty=0.220 (<0.400); contradictory_memory_signals=2',
        },
        {
          flag: 'confabulation_risk' as const,
          confidence: 0.65,
          evidence: 'assertions=2; supporting_memories=0',
        },
      ],
    };

    const output = buildAtomicMetacognitionTemplateOutput(baseInput);
    const variables = buildDynamicPromptTemplateVariables(baseInput);

    expect(output).toBe(
      'uncertainty=true|0.583|certainty=0.220 (<0.400); contradictory_memory_signals=2'
      + ' avoidance=false||'
      + ' confabulation=true|0.650|assertions=2; supporting_memories=0',
    );
    expect(variables.runtime_flag_uncertainty_present).toBe('true');
    expect(variables.runtime_flag_confabulation_risk_present).toBe('true');
    expect('runtime_metacognitive_persona_guidance_body' in variables).toBe(false);
  });

  it('preserves structured runtime sections while sourcing prose from atomic prompt variables', () => {
    const message = makeMessage({
      channelId: 'discord:dm:alex',
      channelType: 'discord_text',
      isDirectMessage: true,
      authorId: 'alex',
      authorName: 'Alex',
      content: 'hey',
    });
    const now = new Date('2026-03-18T13:30:00Z');
    const characterPromptVariables = {
      char_name: 'Companion',
      'character.visual_description': 'Silver eyes and a weathered jacket.',
    };
    const emotionAppraisalChain = [
      {
        timestamp: '2026-03-17T09:00:00.000Z',
        trigger: 'user_checkin',
        summary: 'She opened cautiously and needed a little grounding before discussing the plan.',
      },
      {
        timestamp: '2026-03-17T10:30:00.000Z',
        trigger: 'shared_joke',
        summary: 'A quick joke lightened the mood and brought her energy back up.',
      },
      {
        timestamp: '2026-03-17T12:00:00.000Z',
        trigger: 'repair',
        summary: 'Latest summary',
      },
    ] as const;
    const { templateVariables } = buildPromptTemplateVariables({
      message,
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      now,
      characterPromptVariables,
      modelId: 'test-model',
      fallbackCharacterName: 'Companion',
    });

    const { rendered, variables } = buildRuntimePromptOutputs({
      message,
      resolvedUserName: 'Alex',
      trustLevel: 'trusted',
      channelType: 'discord_text',
      canonicalContactKey: 'contact-alex',
      responseStyle: 'expressive',
      now,
      templateVariables,
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
      extendedTools: [
        { name: 'generate_image', description: 'Generate an image.' } as any,
        { name: 'web', description: 'Fetch a web page.' } as any,
        { name: 'background_probe', description: 'Observe long-running background state.' } as any,
      ],
      loadedExtended: new Map([
        ['generate_image', { source: 'autoload' }],
        ['selfie_create', { source: 'autoload' }],
      ]),
      classifyExtendedToolForTurn: (toolName) => (toolName === 'background_probe' ? 'background' : 'overlay'),
      promotedExtendedToolNames: new Set(['selfie_create']),
      skillsContext: '<skills_index><skill name="conversation" /><skill name="memory" /></skills_index>',
      activeConcernsBlock: formatActiveConcernsContextBlock([
        {
          id: 'concern-1',
          text: 'medication reminder logistics',
          priority: 'high',
          source: 'agent',
          createdAt: '2026-02-01T10:00:00.000Z',
          expiresAt: '2026-02-01T11:00:00.000Z',
        },
        {
          id: 'concern-2',
          text: 'sleep schedule drift',
          priority: 'low',
          source: 'agent',
          createdAt: '2026-02-01T10:00:00.000Z',
          expiresAt: '2026-02-01T12:00:00.000Z',
        },
        {
          id: 'concern-3',
          text: 'hydration routine check',
          priority: 'low',
          source: 'agent',
          createdAt: '2026-02-01T10:00:00.000Z',
          expiresAt: '2026-02-01T13:00:00.000Z',
        },
      ], 2),
      behavioralNotesBlock: [
        '<behavioral_notes>',
        '- validation: avg +0.45 over 1 outcome sample(s), 100% positive',
        '- curiosity: avg +0.30 over 2 outcome sample(s), 100% positive',
        '</behavioral_notes>',
      ].join('\n'),
      emotionAppraisalChain,
      config: {},
      internalState: {
        emotional: TEST_INTERNAL_STATE.emotional,
        cognitive: {
          certaintyLevel: 0.22,
          topicEngagement: 0.8,
          processingQuality: 'deliberate',
        },
        attention: {
          ...TEST_INTERNAL_STATE.attention,
          activeConcerns: [
            {
              id: 'concern-1',
              text: 'Confirm rollback owner and escalation plan',
              priority: 'high',
              source: 'agent',
              createdAt: '2026-03-01T10:00:00.000Z',
              expiresAt: '2026-03-03T10:00:00.000Z',
            },
          ],
        },
        relational: TEST_INTERNAL_STATE.relational,
      },
      metacognitiveFlags: [
        {
          flag: 'uncertainty',
          confidence: 0.583,
          evidence: 'certainty=0.220 (<0.400); contradictory_memory_signals=2',
        },
        {
          flag: 'confabulation_risk',
          confidence: 0.65,
          evidence: 'assertions=2; supporting_memories=0',
        },
      ],
      lastMessageReceivedAtMs: new Date('2026-03-16T09:15:00Z').getTime(),
    });

    expect(variables.runtime_last_message_received_weekday).toBe('Monday');
    expect(variables.runtime_last_message_received_date_human).toBe('March 16, 2026');
    expect(variables.runtime_last_message_received_time_human).toBe('5:15 AM');
    expect(variables.runtime_last_message_received_ago).toBe('2 days ago');
    expect(variables.runtime_speaking_with_name).toBe('Alex');
    expect(variables.runtime_speaking_with_trust_level).toBe('trusted');
    expect(variables.runtime_chat_type).toBe('direct_message');
    expect(variables.runtime_room_id).toBe('discord:dm:alex');
    expect(variables.runtime_current_message_author_name).toBe('Alex');
    expect(variables.runtime_current_message_author_id).toBe('alex');
    expect(variables.runtime_recent_active_participants_xml).toBe('');
    expect(variables.runtime_channel_type).toBe('discord_text');
    expect(variables.runtime_channel_visibility).toBe('private');
    expect(variables.runtime_capability_tier).toBe('autonomous');
    expect(variables.runtime_response_style).toBe('expressive');
    expect(variables.runtime_internal_state_attention_conversation_trajectory).toBe('deepening');
    expect(variables.runtime_internal_state_attention_active_concern_count).toBe('1');
    expect(variables.runtime_internal_state_relational_trust_level).toBe('trusted');
    expect(variables.runtime_emotion_appraisal_length).toBe(String(emotionAppraisalChain.length));
    expect(variables.runtime_emotion_appraisal_latest_trigger).toBe(
      emotionAppraisalChain[emotionAppraisalChain.length - 1]?.trigger ?? '',
    );
    expect(variables.runtime_extended_tools_total).toBe('3');
    expect(variables.runtime_tooling_active_count).toBe('5');
    expect(variables.runtime_tooling_available_extended_count).toBe('3');
    expect(variables.runtime_self_image_tool_active).toBe('true');
    expect(variables.runtime_appearance_context_body).toBe(
      characterPromptVariables['character.visual_description'],
    );
    expect(rendered).toContain('<runtime_state>');
    expect(rendered).not.toContain('<runtime_self>');
    expect(rendered).toContain('<runtime_attention>');
    expect(rendered).toContain('<runtime_tooling>');
    expect(rendered).toContain('<conversation_state>');
    expect(rendered).toContain('<chat_type>direct_message</chat_type>');
    expect(rendered).toContain('<channel_id>discord:dm:alex</channel_id>');
    expect(rendered).toContain('<channel_type>discord_text</channel_type>');
    expect(rendered).toContain('<channel_visibility>private</channel_visibility>');
    expect(rendered).toContain('<current_message_author name="Alex" id="alex" trust="trusted" />');
    expect(rendered).not.toContain('<speaking_with>');
    expect(rendered).not.toContain('<model_context>');
    expect(rendered).not.toContain('<identifier>test-model</identifier>');
    expect(rendered).not.toContain('<capability_tier>');
    expect(rendered).not.toContain('<tier>autonomous</tier>');
    expect(rendered).not.toContain('<active_count>');
    expect(rendered).not.toContain('<available_extended_count>');
    expect(rendered).not.toContain('<analysis_workbench_guidance>');
    expect(rendered).not.toContain('analysis_workbench is a large-evidence escalation surface only.');
    expect(rendered).toContain('<self_image_tool_guidance>');
    expect(rendered).toContain('<extended_tools>');
    expect(rendered).not.toContain('{{');
  });

  it('fails closed with structured fallback variables when prior-message context is unavailable', () => {
    const variables = buildDynamicPromptTemplateVariables({
      message: makeMessage(),
      resolvedUserName: 'Companion',
      trustLevel: 'primary',
      channelType: 'internal',
      canonicalContactKey: undefined,
      subjectIdentityKey: DEFAULT_COMPANION_ID,
      responseStyle: 'concise',
      now: new Date('2026-03-18T13:30:00Z'),
      taskKind: 'heartbeat',
      templateVariables: {},
      modelId: 'test-model',
      capabilityTier: 'autonomous',
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
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      lastMessageReceivedAtMs: null,
      config: {},
    });

    expect(variables.runtime_affect_snapshot_present).toBe('false');
    expect(variables.runtime_affect_mode).toBe('');
    expect(variables.runtime_affect_warmth).toBe('');
    expect(variables.runtime_affect_formality).toBe('');
    expect(variables.runtime_affect_energy).toBe('');
    expect(variables.runtime_affect_assertiveness).toBe('');
    expect(variables.runtime_affect_expressiveness).toBe('');
    expect(variables.runtime_affect_intensity).toBe('');
    expect(variables.runtime_affect_variability).toBe('');
    expect(variables.runtime_affect_control).toBe('');
    expect(variables.runtime_affect_display_range_min).toBe('');
    expect(variables.runtime_affect_display_range_max).toBe('');
    expect(variables.runtime_affect_profile_intensity).toBe('');
    expect(variables.runtime_affect_profile_variability).toBe('');
    expect(variables.runtime_affect_profile_control).toBe('');
    expect(variables.runtime_affect_profile_display_range_min).toBe('');
    expect(variables.runtime_affect_profile_display_range_max).toBe('');
    expect(variables.runtime_affect_valence).toBe('');
    expect(variables.runtime_affect_arousal).toBe('');
    expect(variables.runtime_affect_dominance).toBe('');
    expect(variables.runtime_affect_snapshot_vad_valence).toBe('');
    expect(variables.runtime_affect_snapshot_vad_arousal).toBe('');
    expect(variables.runtime_affect_snapshot_vad_dominance).toBe('');
    expect(variables.runtime_affect_snapshot_mood_valence).toBe('');
    expect(variables.runtime_affect_snapshot_mood_arousal).toBe('');
    expect(variables.runtime_affect_snapshot_mood_dominance).toBe('');
    expect(variables.runtime_affect_snapshot_confidence).toBe('');
    expect(variables.runtime_internal_state_cognitive_processing_quality).toBe('');
    expect(variables.runtime_internal_state_present).toBe('false');
    expect(variables.runtime_internal_state_cognitive_certainty_label).toBe('');
    expect(variables.runtime_internal_state_cognitive_topic_engagement_label).toBe('');
    expect(variables.runtime_internal_state_attention_conversation_trajectory).toBe('');
    expect(variables.runtime_internal_state_attention_active_concern_count).toBe('');
    expect(variables.runtime_internal_state_attention_pending_follow_up_count).toBe('');
    expect(variables.runtime_internal_state_relational_trust_level).toBe('');
    expect(variables.runtime_internal_state_relational_recent_interaction_frequency_label).toBe('');
    expect(variables.runtime_internal_state_relational_last_seen_label).toBe('');
    expect(variables.runtime_internal_state_emotional_mood_valence_label).toBe('');
    expect(variables.runtime_internal_state_emotional_mood_arousal_label).toBe('');
    expect(variables.runtime_concerns_count).toBe('0');
    expect(variables.runtime_concerns_top_lines).toBe('');
    expect(variables.runtime_concerns_top_priorities).toBe('');
    expect(variables.runtime_concerns_omitted_count).toBe('0');
    expect(variables.runtime_concerns_omitted_plural_suffix).toBe('s');
    expect(variables.runtime_emotion_appraisal_length).toBe('0');
    expect(variables.runtime_emotion_appraisal_latest_trigger).toBe('');
    expect(variables.runtime_emotion_appraisal_latest_summary).toBe('');
    expect(variables.runtime_emotion_appraisal_latest_timestamp_iso).toBe('');
    expect(variables.runtime_emotion_appraisal_recent_lines).toBe('');
    expect(variables.runtime_behavioral_notes_count).toBe('0');
    expect(variables.runtime_behavioral_notes_body_raw).toBe('');
    expect(variables.runtime_skills_count).toBe('0');
    expect(variables.runtime_extended_tools_total).toBe('0');
    expect(variables.runtime_extended_tools_activatable_count).toBe('0');
    expect(variables.runtime_extended_tools_blocked_count).toBe('0');
    expect(variables.runtime_extended_tool_names).toBe('');
    expect(variables.runtime_extended_tool_directory_lines).toBe('');
    expect(variables.runtime_self_image_tool_active).toBe('false');
    for (const flagName of METACOGNITIVE_FLAG_NAMES) {
      expect(variables[`runtime_flag_${flagName}_present`]).toBe('false');
      expect(variables[`runtime_flag_${flagName}_confidence`]).toBe('');
      expect(variables[`runtime_flag_${flagName}_evidence`]).toBe('');
    }
    expect('runtime_emotional_affect_body' in variables).toBe(false);
    expect('runtime_metacognitive_persona_guidance_body' in variables).toBe(false);
    expect('runtime_internal_state_body' in variables).toBe(false);
    expect(variables.runtime_internal_turn_kind).toBe('heartbeat');
    expect(variables.runtime_speaking_with_name).toBe('');
    expect(variables.runtime_speaking_with_trust_level).toBe('');
    expect(variables.runtime_channel_type).toBe('');
    expect(variables.runtime_channel_visibility).toBe('');
    expect(variables.runtime_last_message_received_weekday).toBe('');
    expect(variables.runtime_last_message_received_ago).toBe('');
    expect(variables.runtime_last_message_received_missing_notice).toBe(
      'No earlier message is loaded for this channel.',
    );
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
        getEmotionalTimeSeries: () => [],
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

  it('labels blocked extended tools clearly in the prompt-owned runtime layers', () => {
    const message = makeMessage({
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'user-1',
      authorName: 'User',
      content: 'Try web and notify.',
    });

    const renderedRuntimeLayers = renderPromptOwnedRuntimeLayers({
      message,
      resolvedUserName: 'User',
      trustLevel: 'regular',
      channelType: 'api',
      responseStyle: 'concise',
      now: new Date('2026-03-17T12:00:00Z'),
      modelId: 'test-model',
      contextWindow: 4096,
      capabilityTier: 'nursery',
      activeToolCounts: {
        core: 1,
        promoted: 0,
        extendedLoaded: 0,
        autoload: 0,
        deferred: 0,
        total: 1,
      },
      extendedTools: [
        {
          name: 'web',
          description: 'Fetch a web page.',
          parameters: {} as any,
          execute: () => { throw new Error('not used'); },
        } as any,
        {
          name: 'notify',
          description: 'Notify the operator.',
          parameters: {} as any,
          execute: () => { throw new Error('not used'); },
        } as any,
      ],
      loadedExtended: new Map(),
      classifyExtendedToolForTurn: () => 'overlay',
      promotedExtendedToolNames: new Set(),
      skillsContext: '',
      activeConcernsBlock: '',
      behavioralNotesBlock: '',
      config: {},
    });

    expect(renderedRuntimeLayers).toContain('Never claim a tool executed, failed, or was denied unless this turn contains the actual tool call and tool result.');
    expect(renderedRuntimeLayers).toContain('blocked by current tier: external.web');
    expect(renderedRuntimeLayers).not.toContain('<available_extended_count>');
  });
});

describe('companion-facing substrate health context', () => {
  it('does not render backend health telemetry into default prompt context', async () => {
    const rendered = await runWithChargeContext({
      chargePolicy: TEST_CHARGE_POLICY,
      lane: 'interactive',
      runId: 'health-omitted',
    }, async () => buildRuntimeContext({
      ...buildMinimalRuntimeContextInput(),
      config: { chargePolicy: TEST_CHARGE_POLICY },
      substrateHealth: {
        apiHealth: makeApiHealthResponse({
          subsystems: {
            memory: {
              status: 'degraded',
              detail: 'Postgres check failed at /var/lib/psfn/runtime using DATABASE_URL',
              meta: { checkLatencyMs: 44 },
            },
          },
        }),
      },
    }));

    expect(rendered).not.toContain('<runtime_substrate_health>');
    expect(rendered).not.toContain('Overall: healthy');
    expect(rendered).not.toContain('Memory store: degraded');
    expect(rendered).not.toContain('/var/lib/psfn');
    expect(rendered).not.toContain('DATABASE_URL');
  });
});

describe('internal state continuity gap context', () => {
  it('renders a continuity notice when a gap is present', () => {
    const rendered = buildRuntimeContext({
      ...buildMinimalRuntimeContextInput(),
      internalStateContinuityGap: {
        offlineSince: '2026-06-07T12:00:00.000Z',
        gapMs: 3 * 24 * 60 * 60 * 1000,
      },
    });

    expect(rendered).toContain('<runtime_continuity_notice>');
    expect(rendered).toContain('offline for about 3 days');
    expect(rendered).toContain('2026-06-07T12:00:00.000Z');
    expect(rendered).toContain('ask what happened');
  });

  it('formats sub-two-day gaps in hours', () => {
    const rendered = buildRuntimeContext({
      ...buildMinimalRuntimeContextInput(),
      internalStateContinuityGap: {
        offlineSince: '2026-06-10T01:00:00.000Z',
        gapMs: 11 * 60 * 60 * 1000,
      },
    });

    expect(rendered).toContain('offline for about 11 hours');
  });

  it('omits the continuity notice without a gap', () => {
    const rendered = buildRuntimeContext(buildMinimalRuntimeContextInput());
    expect(rendered).not.toContain('runtime_continuity_notice');
    expect(rendered).not.toContain('<runtime_substrate_health>');
  });
});
