// ── Direct unit tests for the runtime-context section producers (E2.6) ──
// Every producer is exercised with fabricated inputs and no runtime
// scaffolding: these tests pin the producer contracts (declared inputs in,
// variable record / rendered block out), not new behavior.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentTool } from '../../../../boundary/pi-agent/index.js';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type { ChargePolicyConfig } from '../../../../shared/contracts/charge-policy.js';
import type { RunChargeSnapshot } from '../../../../shared/telemetry/run-charge.js';
import type { SessionEntry } from '../../../session/types.js';
import type { InternalState } from '../../../self-model/state.js';
import type { AdaptiveLoadedExtendedToolState } from '../../adaptive-tools-telemetry.js';
import { makeTestFatiguePolicyConfig } from '../../../../test-support/charge-policy.js';
import {
  createDmConversationScope,
  createGroupConversationScope,
} from '../../../session/conversation-scope.js';
import type { ContextEnvelope } from '../../../../system/trust/context-envelope.js';
import type { ParticipantRelationshipEdgeInput } from './conversation-state.js';
import {
  buildCurrentDatetimePromptVariables,
  buildLastMessagePromptVariables,
} from './datetime.js';
import { buildConversationStatePromptVariables } from './conversation-state.js';
import { buildTurnBindingPromptVariables } from './turn-binding.js';
import { buildChargePromptVariables, resolveChargePolicyConfig } from './charge.js';
import { buildContinuityGapPromptVariables } from './continuity-gap.js';
import {
  buildInternalStatePromptVariables,
  toEmotionSnapshotFromInternalState,
} from './internal-state.js';
import { buildConcernPromptVariables } from './concerns.js';
import { buildEmotionAppraisalPromptVariables } from './emotion-appraisal.js';
import {
  buildExtendedToolGuide,
  buildExtendedToolPromptVariables,
  buildToolingPromptVariables,
} from './tooling.js';
import {
  buildBehavioralNotesPromptVariables,
  buildSkillsPromptVariables,
} from './notes-and-skills.js';
import {
  buildSelfPresentationPromptVariables,
  resolveAppearanceContextFromTemplateVariables,
} from './self-presentation.js';
import { buildSatelliteEndpointContextBlock } from './satellite.js';

const TEST_TZ = 'America/New_York';
// 2026-07-01T16:00:00Z is Wednesday 12:00 PM in America/New_York.
const FIXED_NOW = new Date('2026-07-01T16:00:00.000Z');

let originalTz: string | undefined;

beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = TEST_TZ;
});

afterAll(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-sections-1',
    channelId: 'discord:group:ops',
    channelType: 'discord',
    authorId: 'user-carol',
    authorName: 'Carol',
    content: 'hello',
    timestamp: FIXED_NOW,
    ...overrides,
  };
}

function makeSessionEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    id: overrides.id ?? 1,
    channelId: overrides.channelId ?? 'discord:group:ops',
    role: overrides.role ?? 'user',
    content: overrides.content ?? 'hi',
    timestamp: overrides.timestamp ?? 0,
    ...(overrides.authorId !== undefined ? { authorId: overrides.authorId } : {}),
    ...(overrides.authorName !== undefined ? { authorName: overrides.authorName } : {}),
  };
}

const TEST_INTERNAL_STATE: InternalState = {
  emotional: {
    vad: { valence: 0.52, arousal: -0.18, dominance: 0.31 },
    mood: { valence: 0.24, arousal: -0.08, dominance: 0.12 },
    discreteEmotions: { joy: 0.7, trust: 0.25 },
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
  situated: {
    location: null,
  },
};

const TEST_CHARGE_POLICY: ChargePolicyConfig = {
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
  surfaceRationales: {},
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
  referenceModelClassPricingRationales: {},
  fatigue: makeTestFatiguePolicyConfig(),
} as ChargePolicyConfig;

function makeExtendedTool(name: string, description: string): AgentTool<any> {
  return { name, description } as AgentTool<any>;
}

describe('datetime producers', () => {
  it('renders the runtime_current_* group from the injected clock', () => {
    const variables = buildCurrentDatetimePromptVariables(FIXED_NOW);
    expect(variables.runtime_current_weekday).toBe('Wednesday');
    expect(variables.runtime_current_date_human).toBe('July 1, 2026');
    expect(variables.runtime_current_time_human).toBe('12:00 PM');
    expect(variables.runtime_current_today).toBe('2026-07-01');
    expect(variables.runtime_current_yesterday).toBe('2026-06-30');
    expect(variables.runtime_current_tomorrow).toBe('2026-07-02');
    expect(variables.runtime_current_part_of_day).toBe('early afternoon');
    expect(variables.runtime_current_datetime_iso).toContain('2026-07-01T12:00:00');
  });

  it('blanks the last-message group when no timestamp is provided', () => {
    const variables = buildLastMessagePromptVariables({ now: FIXED_NOW, lastMessageReceivedAtMs: null });
    expect(variables.runtime_last_message_received_present).toBe('false');
    expect(variables.runtime_last_message_received_missing).toBe('true');
    expect(variables.runtime_last_message_received_ago).toBe('');
  });

  it('renders elapsed labels from a finite last-message timestamp', () => {
    const variables = buildLastMessagePromptVariables({
      now: FIXED_NOW,
      lastMessageReceivedAtMs: FIXED_NOW.getTime() - 90 * 60_000,
    });
    expect(variables.runtime_last_message_received_present).toBe('true');
    expect(variables.runtime_last_message_received_ago).toBe('1 hour ago');
    expect(variables.runtime_last_message_received_days_hours).toBe('1 hour');
    expect(variables.runtime_last_message_received_timezone).toBe(TEST_TZ);
  });

  it('treats a finite but out-of-range last-message timestamp as missing without throwing', () => {
    // |ms| beyond the 8.64e15 Date range is finite but constructs an Invalid Date.
    const outOfRangeMs = 8.64e15 + 1;
    let variables: Record<string, string> = {};
    expect(() => {
      variables = buildLastMessagePromptVariables({
        now: FIXED_NOW,
        lastMessageReceivedAtMs: outOfRangeMs,
      });
    }).not.toThrow();
    expect(variables.runtime_last_message_received_present).toBe('false');
    expect(variables.runtime_last_message_received_missing).toBe('true');
    expect(variables.runtime_last_message_received_at_iso).toBe('');
    expect(variables.runtime_last_message_received_ago).toBe('');
  });
});

describe('conversation-state producer', () => {
  it('marks conversation state unavailable on internal turns', () => {
    const variables = buildConversationStatePromptVariables({
      message: makeMessage({ channelId: 'internal:heartbeat' }),
      conversationScope: createGroupConversationScope({ channelId: 'internal:heartbeat' }),
      internalTurn: true,
      trustLevel: 'primary',
      now: FIXED_NOW,
    });
    expect(variables.runtime_conversation_state_available).toBe('false');
    expect(variables.runtime_recent_active_participants_count).toBe('0');
  });

  it('renders the author element and deduplicated newest-first participants for group turns', () => {
    const variables = buildConversationStatePromptVariables({
      message: makeMessage(),
      conversationScope: createGroupConversationScope({ channelId: 'discord:group:ops' }),
      internalTurn: false,
      trustLevel: 'trusted',
      relationshipType: 'friend',
      now: FIXED_NOW,
      recentChannelEntries: [
        makeSessionEntry({ id: 1, authorId: 'user-alice', authorName: 'Alice', timestamp: 100 }),
        makeSessionEntry({ id: 2, authorId: 'user-carol', authorName: 'Carol', timestamp: 200 }),
        makeSessionEntry({ id: 3, authorId: 'user-alice', authorName: 'Alice', timestamp: 300 }),
      ],
    });
    expect(variables.runtime_conversation_state_available).toBe('true');
    expect(variables.runtime_chat_type).toBe('group');
    expect(variables.runtime_room_id).toBe('discord:group:ops');
    expect(variables.runtime_current_message_author_xml).toBe(
      '<current_message_author name="Carol" id="user-carol" trust="trusted" relationship="friend" />',
    );
    expect(variables.runtime_recent_active_participants_count).toBe('2');
    expect(variables.runtime_recent_active_participants_xml.indexOf('user-alice'))
      .toBeLessThan(variables.runtime_recent_active_participants_xml.indexOf('user-carol'));
  });

  it('does not render a participant roster for dm turns', () => {
    const variables = buildConversationStatePromptVariables({
      message: makeMessage({ channelId: 'discord:dm:alice', authorId: 'user-alice', authorName: 'Alice' }),
      conversationScope: createDmConversationScope({
        channelId: 'discord:dm:alice',
        contact: { contactId: 'contact-alice', displayName: 'Alice' },
      }),
      internalTurn: false,
      trustLevel: 'trusted',
      now: FIXED_NOW,
      recentChannelEntries: [
        makeSessionEntry({ id: 1, authorId: 'user-alice', authorName: 'Alice', timestamp: 100 }),
      ],
    });
    expect(variables.runtime_chat_type).toBe('direct_message');
    expect(variables.runtime_recent_active_participants_xml).toBe('');
    expect(variables.runtime_recent_active_participants_count).toBe('0');
  });
});

describe('conversation-state producer — participant relationships (E4.4)', () => {
  const GROUP_KNOWN_ENVELOPE: ContextEnvelope = {
    channelPrivacy: 'invite_only',
    audienceScope: 'few',
    audienceKnowledge: 'all_known',
    broadcast: false,
  };

  function makeEdge(overrides: Partial<ParticipantRelationshipEdgeInput> = {}): ParticipantRelationshipEdgeInput {
    return {
      aName: 'Vega',
      bName: 'Iki',
      relationshipType: 'sibling',
      sensitivity: 'personal',
      confidence: 0.9,
      updatedAt: '2026-06-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function renderGroup(
    edges: readonly ParticipantRelationshipEdgeInput[],
    envelope: ContextEnvelope = GROUP_KNOWN_ENVELOPE,
  ): Record<string, string> {
    return buildConversationStatePromptVariables({
      message: makeMessage({ channelId: 'discord:group:ops' }),
      conversationScope: createGroupConversationScope({ channelId: 'discord:group:ops', envelope }),
      internalTurn: false,
      trustLevel: 'trusted',
      now: FIXED_NOW,
      participantRelationshipEdges: edges,
    });
  }

  it('renders one compact rel line for a live edge between two present participants', () => {
    const variables = renderGroup([makeEdge()]);
    expect(variables.runtime_participant_relationships_count).toBe('1');
    expect(variables.runtime_participant_relationships_xml).toBe(
      '\n<participant_relationships>\n<rel a="Vega" b="Iki" type="sibling" />\n</participant_relationships>',
    );
  });

  it('never renders an intimate edge in a room (sensitivity gate)', () => {
    const variables = renderGroup([makeEdge({ sensitivity: 'intimate' })]);
    expect(variables.runtime_participant_relationships_xml).toBe('');
    expect(variables.runtime_participant_relationships_count).toBe('0');
  });

  it('never renders a confidential edge in a room (sensitivity gate)', () => {
    const variables = renderGroup([makeEdge({ sensitivity: 'confidential' })]);
    expect(variables.runtime_participant_relationships_xml).toBe('');
  });

  it('caps at five lines with confidence-desc then most-recent-evidence order', () => {
    const edges: ParticipantRelationshipEdgeInput[] = [
      makeEdge({ aName: 'A', bName: 'B', confidence: 0.71, updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeEdge({ aName: 'C', bName: 'D', confidence: 0.95, updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeEdge({ aName: 'E', bName: 'F', confidence: 0.90, updatedAt: '2026-05-01T00:00:00.000Z' }),
      makeEdge({ aName: 'G', bName: 'H', confidence: 0.90, updatedAt: '2026-03-01T00:00:00.000Z' }),
      makeEdge({ aName: 'I', bName: 'J', confidence: 0.85, updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeEdge({ aName: 'K', bName: 'L', confidence: 0.80, updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const variables = renderGroup(edges);
    expect(variables.runtime_participant_relationships_count).toBe('5');
    const lines = variables.runtime_participant_relationships_xml
      .split('\n')
      .filter(line => line.startsWith('<rel '));
    expect(lines).toEqual([
      '<rel a="C" b="D" type="sibling" />',
      '<rel a="E" b="F" type="sibling" />',
      '<rel a="G" b="H" type="sibling" />',
      '<rel a="I" b="J" type="sibling" />',
      '<rel a="K" b="L" type="sibling" />',
    ]);
    // The 0.71 edge is the lowest-confidence and is dropped by the cap.
    expect(variables.runtime_participant_relationships_xml).not.toContain('a="A"');
  });

  it('renders nothing when there are no qualifying edges (no empty XML shell)', () => {
    const variables = renderGroup([]);
    expect(variables.runtime_participant_relationships_xml).toBe('');
    expect(variables.runtime_participant_relationships_count).toBe('0');
  });

  it('renders nothing for an anonymous audience', () => {
    const variables = renderGroup([makeEdge()], { ...GROUP_KNOWN_ENVELOPE, audienceKnowledge: 'anonymous' });
    expect(variables.runtime_participant_relationships_xml).toBe('');
  });

  it('renders nothing for a broadcast surface', () => {
    const variables = renderGroup([makeEdge()], {
      channelPrivacy: 'public',
      audienceScope: 'unbounded',
      audienceKnowledge: 'all_known',
      broadcast: true,
    });
    expect(variables.runtime_participant_relationships_xml).toBe('');
  });

  it('renders nothing on dm turns (a dm has one participant)', () => {
    const variables = buildConversationStatePromptVariables({
      message: makeMessage({ channelId: 'discord:dm:vega', authorId: 'user-vega', authorName: 'Vega' }),
      conversationScope: createDmConversationScope({
        channelId: 'discord:dm:vega',
        contact: { contactId: 'contact-vega', displayName: 'Vega' },
      }),
      internalTurn: false,
      trustLevel: 'trusted',
      now: FIXED_NOW,
      participantRelationshipEdges: [makeEdge()],
    });
    expect(variables.runtime_participant_relationships_xml).toBe('');
    expect(variables.runtime_participant_relationships_count).toBe('0');
  });

  it('renders nothing on internal turns', () => {
    const variables = buildConversationStatePromptVariables({
      message: makeMessage({ channelId: 'internal:heartbeat' }),
      conversationScope: createGroupConversationScope({ channelId: 'internal:heartbeat' }),
      internalTurn: true,
      trustLevel: 'primary',
      now: FIXED_NOW,
      participantRelationshipEdges: [makeEdge()],
    });
    expect(variables.runtime_participant_relationships_xml).toBe('');
    expect(variables.runtime_participant_relationships_count).toBe('0');
  });
});

describe('turn-binding producer', () => {
  it('binds speaking_with tokens only when the dm binding is active', () => {
    const variables = buildTurnBindingPromptVariables({
      internalTurn: false,
      speakingWithActive: true,
      resolvedUserName: 'Alice',
      trustLevel: 'trusted',
      channelType: 'discord',
      visibility: 'private',
    });
    expect(variables.runtime_internal_turn_kind).toBe('');
    expect(variables.runtime_speaking_with_name).toBe('Alice');
    expect(variables.runtime_speaking_with_trust_level).toBe('trusted');
    expect(variables.runtime_channel_type).toBe('discord');
    expect(variables.runtime_channel_visibility).toBe('private');
  });

  it('blanks channel and speaking_with tokens on internal turns and labels the task kind', () => {
    const variables = buildTurnBindingPromptVariables({
      internalTurn: true,
      taskKind: 'reflection',
      speakingWithActive: false,
      resolvedUserName: 'Companion',
      trustLevel: 'primary',
      channelType: 'terminal',
      visibility: 'private',
    });
    expect(variables.runtime_internal_turn_kind).toBe('reflection');
    expect(variables.runtime_speaking_with_name).toBe('');
    expect(variables.runtime_channel_type).toBe('');
    expect(variables.runtime_channel_visibility).toBe('');
  });
});

describe('charge producer', () => {
  it('marks the budget absent without a valid charge policy', () => {
    expect(resolveChargePolicyConfig({})).toBeNull();
    const variables = buildChargePromptVariables({
      chargePolicy: null,
      chargeSnapshot: undefined,
      analysisWorkbenchAvailable: true,
    });
    expect(variables.runtime_charge_budget_present).toBe('false');
    expect(variables.runtime_charge_cost_lines).toBe('');
  });

  it('renders lane quota, remaining budget, and costed surface lines from the snapshot', () => {
    expect(resolveChargePolicyConfig({ chargePolicy: TEST_CHARGE_POLICY })).toEqual(TEST_CHARGE_POLICY);
    const variables = buildChargePromptVariables({
      chargePolicy: TEST_CHARGE_POLICY,
      chargeSnapshot: {
        lane: 'interactive',
        quotaSpentByLane: { interactive: 5 },
      } as RunChargeSnapshot,
      analysisWorkbenchAvailable: false,
    });
    expect(variables.runtime_charge_budget_present).toBe('true');
    expect(variables.runtime_charge_lane).toBe('interactive');
    expect(variables.runtime_charge_quota).toBe('24');
    expect(variables.runtime_charge_remaining).toBe('19');
    expect(variables.runtime_charge_cost_lines).toContain('- shard launch: 8');
    // Workbench extension band is hidden when analysis_workbench is unavailable.
    expect(variables.runtime_charge_cost_lines).not.toContain('analysis_workbench');
  });

  it('defaults to the interactive lane without a run-charge snapshot', () => {
    const variables = buildChargePromptVariables({
      chargePolicy: TEST_CHARGE_POLICY,
      chargeSnapshot: undefined,
      analysisWorkbenchAvailable: true,
    });
    expect(variables.runtime_charge_lane).toBe('interactive');
    expect(variables.runtime_charge_remaining).toBe('24');
    expect(variables.runtime_charge_cost_lines).toContain('analysis_workbench extension pass after the first iteration: 4');
  });
});

describe('continuity-gap producer', () => {
  it('blanks bare values without a gap', () => {
    expect(buildContinuityGapPromptVariables(null)).toEqual({
      runtime_continuity_gap_present: 'false',
      runtime_continuity_gap_duration: '',
      runtime_continuity_gap_offline_since: '',
    });
  });

  it('formats sub-two-day gaps in hours and longer gaps in days', () => {
    expect(buildContinuityGapPromptVariables({
      gapMs: 5 * 60 * 60 * 1000,
      offlineSince: '2026-06-30T07:00:00.000Z',
    }).runtime_continuity_gap_duration).toBe('5 hours');
    expect(buildContinuityGapPromptVariables({
      gapMs: 72 * 60 * 60 * 1000,
      offlineSince: '2026-06-28T12:00:00.000Z',
    }).runtime_continuity_gap_duration).toBe('3 days');
  });
});

describe('internal-state producer', () => {
  it('blanks every internal-state variable when no state is provided', () => {
    const variables = buildInternalStatePromptVariables(undefined);
    expect(variables.runtime_internal_state_present).toBe('false');
    expect(variables.runtime_internal_state_emotional_mood_valence_label).toBe('');
  });

  it('maps scalar readings to the describe-helper labels', () => {
    const variables = buildInternalStatePromptVariables(TEST_INTERNAL_STATE);
    expect(variables.runtime_internal_state_present).toBe('true');
    expect(variables.runtime_internal_state_cognitive_processing_quality).toBe('fluent');
    expect(variables.runtime_internal_state_cognitive_certainty_label).toBe('steady');
    expect(variables.runtime_internal_state_emotional_mood_valence_label).toBe('warm');
    expect(variables.runtime_internal_state_relational_last_seen_label).toBe('just interacted');
    expect(variables.runtime_internal_state_emotional_secondary_emotions).toBe('joy, trust');
  });

  it('projects the emotion snapshot as copies of the internal-state readings', () => {
    const snapshot = toEmotionSnapshotFromInternalState(TEST_INTERNAL_STATE);
    expect(snapshot.vad).toEqual(TEST_INTERNAL_STATE.emotional.vad);
    expect(snapshot.vad).not.toBe(TEST_INTERNAL_STATE.emotional.vad);
    expect(snapshot.discrete).toEqual(TEST_INTERNAL_STATE.emotional.discreteEmotions);
    expect(snapshot.confidence).toBe(0.84);
  });
});

describe('concerns producer', () => {
  it('renders zero-count defaults without concern data', () => {
    expect(buildConcernPromptVariables(null)).toEqual({
      runtime_concerns_count: '0',
      runtime_concerns_top_lines: '',
      runtime_concerns_top_priorities: '',
      runtime_concerns_omitted_count: '0',
      runtime_concerns_omitted_plural_suffix: 's',
    });
  });

  it('delegates populated concern data to the shared concern variable builder', () => {
    const variables = buildConcernPromptVariables({
      totalCount: 3,
      topLines: ['- Check on the offsite plan', '- Follow up on the vet visit'],
      topPriorities: ['high', 'medium'],
      omittedCount: 1,
    });
    expect(variables.runtime_concerns_count).toBe('3');
    expect(variables.runtime_concerns_top_priorities).toBe('high, medium');
    expect(variables.runtime_concerns_omitted_count).toBe('1');
    expect(variables.runtime_concerns_omitted_plural_suffix).toBe('');
  });
});

describe('emotion-appraisal producer', () => {
  it('renders zero-length defaults for an empty appraisal chain', () => {
    const variables = buildEmotionAppraisalPromptVariables([]);
    expect(variables.runtime_emotion_appraisal_length).toBe('0');
    expect(variables.runtime_emotion_appraisal_latest_trigger).toBe('');
    expect(variables.runtime_emotion_appraisal_recent_lines).toBe('');
  });

  it('renders the latest entry and at most two recent lines', () => {
    const variables = buildEmotionAppraisalPromptVariables([
      { timestamp: FIXED_NOW.getTime() - 120_000, trigger: 'message', summary: 'Warm check-in from Alice.' },
      { timestamp: FIXED_NOW.getTime() - 60_000, trigger: 'reflection', summary: 'Settled after the planning talk.' },
      { timestamp: FIXED_NOW.getTime(), trigger: 'message', summary: 'Excited about the offsite news.' },
    ]);
    expect(variables.runtime_emotion_appraisal_length).toBe('3');
    expect(variables.runtime_emotion_appraisal_latest_trigger).toBe('message');
    expect(variables.runtime_emotion_appraisal_latest_summary).toBe('Excited about the offsite news.');
    expect(variables.runtime_emotion_appraisal_latest_timestamp_iso).toBe(FIXED_NOW.toISOString());
    expect(variables.runtime_emotion_appraisal_recent_lines.split('\n')).toHaveLength(2);
    expect(variables.runtime_emotion_appraisal_recent_lines).not.toContain('Warm check-in');
  });
});

describe('tooling producers', () => {
  it('classifies extended tools into activatable, active, and background-only guide lines', () => {
    const loadedExtended = new Map<string, AdaptiveLoadedExtendedToolState>([
      ['loaded_tool', { toolName: 'loaded_tool', source: 'autoload', activatedAt: 1, lastActivatedAt: 1 }],
    ]);
    const guide = buildExtendedToolGuide({
      capabilityTier: 'nursery',
      extendedTools: [
        makeExtendedTool('fresh_tool', 'Does a thing. With details.'),
        makeExtendedTool('loaded_tool', 'Already active. More details.'),
        makeExtendedTool('background_tool', 'Runs in the background. Extra.'),
      ],
      loadedExtended,
      classifyExtendedToolForTurn: toolName => (toolName === 'background_tool' ? 'background' : 'overlay'),
      promotedExtendedToolNames: new Set(),
    });
    expect(guide.lines).toEqual([
      '- fresh_tool: Does a thing (use toolset action="activate")',
      '- loaded_tool: Already active (autoload active)',
      '- background_tool: Runs in the background (background-only; not callable in-turn)',
    ]);
    expect(guide.activatableCount).toBe(1);
    expect(guide.blockedCount).toBe(0);
  });

  it('renders the tooling count variables from declared counts', () => {
    const variables = buildToolingPromptVariables({
      capabilityTier: 'nursery',
      analysisWorkbenchAvailable: true,
      activeToolCounts: { core: 6, promoted: 2, extendedLoaded: 1, autoload: 1, deferred: 0, total: 10 },
      availableExtendedCount: 7,
    });
    expect(variables.runtime_capability_tier).toBe('nursery');
    expect(variables.runtime_analysis_workbench_available).toBe('true');
    expect(variables.runtime_tooling_active_count).toBe('10');
    expect(variables.runtime_tooling_promoted_count).toBe('2');
    expect(variables.runtime_tooling_available_extended_count).toBe('7');
  });

  it('renders the extended-tool directory variables from the guide', () => {
    const variables = buildExtendedToolPromptVariables({
      extendedTools: [makeExtendedTool('alpha', 'A.'), makeExtendedTool('beta', 'B.')],
      extendedToolGuide: { lines: ['- alpha: A', '- beta: B'], activatableCount: 2, blockedCount: 0 },
    });
    expect(variables.runtime_extended_tools_total).toBe('2');
    expect(variables.runtime_extended_tools_activatable_count).toBe('2');
    expect(variables.runtime_extended_tool_names).toBe('alpha, beta');
    expect(variables.runtime_extended_tool_directory_lines).toBe('- alpha: A\n- beta: B');
  });
});

describe('notes and skills producers', () => {
  it('counts non-empty behavioral note lines and unwraps the section body', () => {
    const variables = buildBehavioralNotesPromptVariables(
      '<behavioral_notes>\n- prefers short answers\n\n- checks in on Tuesdays\n</behavioral_notes>',
    );
    expect(variables.runtime_behavioral_notes_count).toBe('2');
    expect(variables.runtime_behavioral_notes_body).toContain('- prefers short answers');
    expect(buildBehavioralNotesPromptVariables(undefined).runtime_behavioral_notes_count).toBe('0');
  });

  it('counts skill tags in the skills context', () => {
    expect(buildSkillsPromptVariables('<skills>\n<skill id="a" />\n<skill id="b" />\n</skills>').runtime_skills_count).toBe('2');
    expect(buildSkillsPromptVariables(undefined).runtime_skills_count).toBe('0');
  });
});

describe('self-presentation producer', () => {
  it('resolves appearance from the character visual-description variables', () => {
    expect(resolveAppearanceContextFromTemplateVariables({
      'character.visual_description': ' Silver-furred, green-eyed. ',
    })).toBe('Silver-furred, green-eyed.');
    expect(resolveAppearanceContextFromTemplateVariables({})).toBe('');
  });

  it('flags the self-image tool from core, promoted, or loaded state and blanks appearance on internal turns', () => {
    const promoted = buildSelfPresentationPromptVariables({
      internalTurn: false,
      templateVariables: { visual_description: 'A small black cat.' },
      skillsContext: '<skills_index>\nskill list body\n</skills_index>',
      coreToolNames: new Set<string>(),
      loadedExtended: new Map(),
      promotedExtendedToolNames: new Set(['selfie_create']),
    });
    expect(promoted.runtime_self_image_tool_active).toBe('true');
    expect(promoted.runtime_appearance_context_body).toBe('A small black cat.');
    expect(promoted.runtime_skills_index_body).toBe('skill list body');

    // selfie_create registered in the default core stack also flags the tool.
    const core = buildSelfPresentationPromptVariables({
      internalTurn: false,
      templateVariables: { visual_description: 'A small black cat.' },
      coreToolNames: new Set(['selfie_create']),
      loadedExtended: new Map(),
      promotedExtendedToolNames: new Set(),
    });
    expect(core.runtime_self_image_tool_active).toBe('true');

    const internal = buildSelfPresentationPromptVariables({
      internalTurn: true,
      templateVariables: { visual_description: 'A small black cat.' },
      coreToolNames: new Set<string>(),
      loadedExtended: new Map(),
      promotedExtendedToolNames: new Set(),
    });
    expect(internal.runtime_self_image_tool_active).toBe('false');
    expect(internal.runtime_appearance_context_body).toBe('');
  });
});

describe('satellite producer', () => {
  it('renders nothing without satellite routing', () => {
    expect(buildSatelliteEndpointContextBlock(makeMessage())).toBe('');
  });

  it('renders the satellite capability block from routing metadata', () => {
    const block = buildSatelliteEndpointContextBlock(makeMessage({
      channelId: 'satellite:android-mobile:weekend-walk',
      channelType: 'api',
      routing: {
        source: 'satellite',
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
            advertised: ['text', 'audio_input'],
            registryMax: ['text', 'audio_input', 'robotics'],
            effective: ['text', 'audio_input'],
            policyDenied: ['robotics'],
          },
          telemetryScopes: ['location', 'timezone'],
          auth: { mode: 'api_key', principalId: 'api-key-test', certBound: false },
        },
      } as SubstrateMessage['routing'],
    }));
    expect(block).toContain('<runtime_satellite_endpoint>');
    expect(block).toContain('Satellite: Android Mobile Satellite (android-phone)');
    expect(block).toContain('Effective capabilities: text, audio_input');
    expect(block).toContain('Policy-denied or not-yet-modeled capabilities: robotics');
    expect(block).toContain('Mobility: mobile');
  });
});
