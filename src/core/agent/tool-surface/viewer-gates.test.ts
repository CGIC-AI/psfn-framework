import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { PROMPT_RUNTIME_MACRO_HINTS } from '../../identity/prompt-runtime/macro-hints.js';
import { listCanonicalToolSurfaces } from './registry.js';
import { TOOL_VIEWER_GATE_DECISIONS, TOOL_WITHOUT_ACTIONS } from './viewer-gates.js';
import { withViewerReadGate } from './viewer-read-gate.js';

/**
 * Companion-wide state sweep (psfn-framework-o5wf5): every tool action and
 * every prompt template token must carry an explicit viewer-gate decision.
 * Adding a tool action or a prompt token without deciding how a lower-trust
 * room is kept from another room's material fails here.
 */

type PromptTokenDecision = { decision: 'gated' | 'content_free' | 'current_conversation' | 'identity_by_design'; reason: string; tokens: readonly string[] };

const PROMPT_TOKEN_GATE_DECISIONS: readonly PromptTokenDecision[] = [
  {
    decision: 'gated',
    reason: 'open threads: filterConcernsForViewer (xz8m1)',
    tokens: [
      '{{runtime_concerns_count}}',
      '{{runtime_concerns_top_lines}}',
      '{{runtime_concerns_top_priorities}}',
      '{{runtime_concerns_omitted_count}}',
      '{{runtime_concerns_omitted_plural_suffix}}',
    ],
  },
  {
    decision: 'gated',
    reason: 'relationship edges: group-only, envelope and viewer-trust filtered',
    tokens: [
      '{{runtime_participant_relationships_xml}}',
      '{{runtime_participant_relationships_count}}',
    ],
  },
  {
    decision: 'gated',
    reason: 'companion physical place: rendered only where personal material is admitted (o5wf5 sweep)',
    tokens: [
      '{{runtime_situated_location_present}}',
      '{{runtime_situated_location_label}}',
      '{{runtime_situated_location_kind}}',
      '{{runtime_situated_location_place_id}}',
      '{{runtime_situated_location_site_id}}',
      '{{runtime_situated_location_updated_at}}',
      '{{runtime_situated_location_age_label}}',
      '{{runtime_situated_location_is_stale}}',
    ],
  },
  {
    decision: 'content_free',
    reason: 'labels, numbers, counts, or content-free evidence (qblju)',
    tokens: [
      '{{runtime_recent_active_participants_count}}',
      '{{runtime_affect_snapshot_present}}',
      '{{runtime_affect_mode}}',
      '{{runtime_affect_mode_label}}',
      '{{runtime_affect_mode_is_honne}}',
      '{{runtime_affect_mode_is_tatemae}}',
      '{{runtime_affect_warmth}}',
      '{{runtime_affect_formality}}',
      '{{runtime_affect_energy}}',
      '{{runtime_affect_assertiveness}}',
      '{{runtime_affect_expressiveness}}',
      '{{runtime_affect_intensity}}',
      '{{runtime_affect_variability}}',
      '{{runtime_affect_control}}',
      '{{runtime_affect_display_range_min}}',
      '{{runtime_affect_display_range_max}}',
      '{{runtime_affect_valence}}',
      '{{runtime_affect_arousal}}',
      '{{runtime_affect_dominance}}',
      '{{runtime_affect_snapshot_mood_valence}}',
      '{{runtime_affect_snapshot_mood_arousal}}',
      '{{runtime_affect_snapshot_mood_dominance}}',
      '{{runtime_affect_snapshot_confidence}}',
      '{{runtime_affect_guidance_warmth_label}}',
      '{{runtime_affect_guidance_formality_label}}',
      '{{runtime_affect_guidance_energy_label}}',
      '{{runtime_affect_guidance_assertiveness_label}}',
      '{{runtime_affect_guidance_expressiveness_label}}',
      '{{runtime_flag_uncertainty_present}}',
      '{{runtime_flag_uncertainty_confidence}}',
      '{{runtime_flag_uncertainty_evidence}}',
      '{{runtime_flag_avoidance_present}}',
      '{{runtime_flag_avoidance_confidence}}',
      '{{runtime_flag_avoidance_evidence}}',
      '{{runtime_flag_high_engagement_present}}',
      '{{runtime_flag_high_engagement_confidence}}',
      '{{runtime_flag_high_engagement_evidence}}',
      '{{runtime_flag_repetition_present}}',
      '{{runtime_flag_repetition_confidence}}',
      '{{runtime_flag_repetition_evidence}}',
      '{{runtime_flag_confabulation_risk_present}}',
      '{{runtime_flag_confabulation_risk_confidence}}',
      '{{runtime_flag_confabulation_risk_evidence}}',
      '{{runtime_internal_state_present}}',
      '{{runtime_internal_state_cognitive_processing_quality}}',
      '{{runtime_internal_state_cognitive_certainty_label}}',
      '{{runtime_internal_state_cognitive_topic_engagement_label}}',
      '{{runtime_internal_state_attention_conversation_trajectory}}',
      '{{runtime_internal_state_attention_active_concern_count}}',
      '{{runtime_internal_state_attention_active_concern_plural_suffix}}',
      '{{runtime_internal_state_attention_pending_follow_up_count}}',
      '{{runtime_internal_state_attention_pending_follow_up_plural_suffix}}',
      '{{runtime_internal_state_relational_trust_level}}',
      '{{runtime_internal_state_relational_recent_interaction_frequency_label}}',
      '{{runtime_internal_state_relational_last_seen_label}}',
      '{{runtime_internal_state_emotional_mood_valence_label}}',
      '{{runtime_internal_state_emotional_mood_arousal_label}}',
      '{{runtime_internal_state_emotional_secondary_emotions}}',
      '{{runtime_internal_state_emotional_telemetry_status}}',
      '{{runtime_internal_state_emotional_telemetry_reasons}}',
      '{{runtime_behavioral_notes_count}}',
      '{{runtime_skills_count}}',
      '{{runtime_analysis_workbench_available}}',
      '{{runtime_tooling_active_count}}',
      '{{runtime_tooling_core_count}}',
      '{{runtime_tooling_extended_count}}',
      '{{runtime_tooling_registered_extended_count}}',
      '{{runtime_self_image_tool_active}}',
      '{{runtime_extended_tools_total}}',
      '{{runtime_extended_tools_callable_count}}',
      '{{runtime_extended_tools_blocked_count}}',
      '{{runtime_extended_tool_names}}',
      '{{runtime_extended_tool_directory_lines}}',
      '{{runtime_charge_budget_present}}',
      '{{runtime_charge_lane}}',
      '{{runtime_charge_quota}}',
      '{{runtime_charge_remaining}}',
      '{{runtime_charge_cost_lines}}',
    ],
  },
  {
    decision: 'identity_by_design',
    reason: 'character card, companion skills/appearance, operator guidance, model and timezone',
    tokens: [
      '{{char}}',
      '{{name}}',
      '{{description}}',
      '{{personality}}',
      '{{scenario}}',
      '{{system_prompt}}',
      '{{mes_example}}',
      '{{post_history_instructions}}',
      '{{first_mes}}',
      '{{creator}}',
      '{{creator_notes}}',
      '{{tags}}',
      '{{alternate_greetings}}',
      '{{visual_description}}',
      '{{model}}',
      '{{active_timezone}}',
      '{{runtime_persona_adaptation_extra}}',
      '{{runtime_context_extra}}',
      '{{runtime_skills_index_body}}',
      '{{runtime_appearance_context_body}}',
    ],
  },
  {
    decision: 'current_conversation',
    reason: 'the current turn, author, channel, trust, time, or this conversation\'s own appraisal chain',
    tokens: [
      '{{current_datetime}}',
      '{{current_date}}',
      '{{current_time}}',
      '{{unix_timestamp}}',
      '{{user}}',
      '{{user_id}}',
      '{{channel_id}}',
      '{{channel_type}}',
      '{{channel_visibility}}',
      '{{trust_level}}',
      '{{canonical_contact_id}}',
      '{{runtime_current_datetime_human}}',
      '{{runtime_current_datetime_iso}}',
      '{{runtime_current_weekday}}',
      '{{runtime_current_date_human}}',
      '{{runtime_current_time_human}}',
      '{{runtime_current_today}}',
      '{{runtime_current_yesterday}}',
      '{{runtime_current_tomorrow}}',
      '{{runtime_current_part_of_day}}',
      '{{runtime_last_message_received_at_iso}}',
      '{{runtime_last_message_received_weekday}}',
      '{{runtime_last_message_received_date_human}}',
      '{{runtime_last_message_received_time_human}}',
      '{{runtime_last_message_received_timezone}}',
      '{{runtime_last_message_received_ago}}',
      '{{runtime_last_message_received_days_hours}}',
      '{{runtime_last_message_received_present}}',
      '{{runtime_last_message_received_missing}}',
      '{{runtime_speaking_with_is_machine_intelligence}}',
      '{{runtime_internal_turn_kind}}',
      '{{runtime_continuity_gap_present}}',
      '{{runtime_continuity_gap_duration}}',
      '{{runtime_continuity_gap_offline_since}}',
      '{{runtime_conversation_state_available}}',
      '{{runtime_chat_type}}',
      '{{runtime_room_id}}',
      '{{runtime_current_message_author_xml}}',
      '{{runtime_current_message_author_name}}',
      '{{runtime_current_message_author_id}}',
      '{{runtime_current_message_author_name_xml_attr}}',
      '{{runtime_current_message_author_id_xml_attr}}',
      '{{runtime_current_message_author_trust_level}}',
      '{{runtime_current_message_author_relationship}}',
      '{{runtime_current_message_author_timezone}}',
      '{{runtime_current_message_author_local_time}}',
      '{{runtime_recent_active_participants_xml}}',
      '{{runtime_speaking_with_name}}',
      '{{runtime_speaking_with_trust_level}}',
      '{{runtime_channel_type}}',
      '{{runtime_channel_visibility}}',
      '{{runtime_channel_privacy}}',
      '{{runtime_broadcast}}',
      '{{runtime_audience_scope}}',
      '{{runtime_audience_knowledge}}',
      '{{runtime_capability_tier}}',
      '{{runtime_trust_is_primary}}',
      '{{runtime_trust_is_trusted}}',
      '{{runtime_trust_is_regular}}',
      '{{runtime_trust_is_public}}',
      '{{runtime_response_style}}',
      '{{runtime_response_style_name}}',
      '{{runtime_response_style_is_concise}}',
      '{{runtime_response_style_is_expressive}}',
      '{{runtime_response_style_is_concise_voice}}',
      '{{runtime_emotion_appraisal_length}}',
      '{{runtime_emotion_appraisal_latest_trigger}}',
      '{{runtime_emotion_appraisal_latest_summary}}',
      '{{runtime_emotion_appraisal_latest_timestamp_iso}}',
      '{{runtime_emotion_appraisal_recent_lines}}',
      '{{runtime_behavioral_notes_body}}',
    ],
  },
];

describe('companion-wide state gate decisions (o5wf5)', () => {
  it('has a decision for every canonical tool action and no stale entries', () => {
    const surfaces = listCanonicalToolSurfaces();
    const missing: string[] = [];
    for (const surface of surfaces) {
      const decisions = TOOL_VIEWER_GATE_DECISIONS[surface.name];
      const actions = surface.actions && surface.actions.length > 0 ? surface.actions : [TOOL_WITHOUT_ACTIONS];
      for (const action of actions) {
        if (!decisions || !Object.prototype.hasOwnProperty.call(decisions, action)) missing.push(`${surface.name}.${action}`);
      }
    }
    expect(missing).toEqual([]);

    const stale: string[] = [];
    for (const [toolName, decisions] of Object.entries(TOOL_VIEWER_GATE_DECISIONS)) {
      const surface = surfaces.find(entry => entry.name === toolName);
      const actions = surface?.actions && surface.actions.length > 0 ? surface.actions : [TOOL_WITHOUT_ACTIONS];
      for (const action of Object.keys(decisions)) {
        if (!surface || !actions.includes(action)) stale.push(`${toolName}.${action}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('has exactly one decision for every prompt template token', () => {
    const decided = PROMPT_TOKEN_GATE_DECISIONS.flatMap(entry => entry.tokens);
    const tokens = PROMPT_RUNTIME_MACRO_HINTS.map(hint => hint.token);
    expect(tokens.filter(token => !decided.includes(token))).toEqual([]);
    expect(decided.filter(token => !tokens.includes(token))).toEqual([]);
    expect(new Set(decided).size).toBe(decided.length);
  });
});

describe('central viewer read gate (o5wf5)', () => {
  function fakeTool(name: string) {
    const calls: unknown[] = [];
    return {
      calls,
      tool: withViewerReadGate({
        name,
        label: name,
        description: name,
        parameters: {},
        execute: async (_id: string, params: unknown) => {
          calls.push(params);
          return { content: [{ type: 'text' as const, text: 'contact records' }], details: {} };
        },
      } as never) as { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }> },
    };
  }
  const asViewer = <T,>(trust: 'primary' | 'trusted' | 'public', fn: () => Promise<T>) => runWithRequestContext({
    callType: 'tool', purpose: 'agent.turn', channelId: `api:${trust}-room`,
    viewerTrustLevel: trust, viewerChannelPrivacy: 'private',
  }, fn);

  it('withholds contact records from a public-trust room and allows a trusted room', async () => {
    const { tool, calls } = fakeTool('contact');
    const publicResult = await asViewer('public', () => tool.execute('c1', { action: 'list' }));
    expect(publicResult.content[0]?.text).toContain('withheld by visibility gating');
    expect(calls).toHaveLength(0);
    const trustedResult = await asViewer('trusted', () => tool.execute('c2', { action: 'lookup' }));
    expect(trustedResult.content[0]?.text).toBe('contact records');
  });

  it('keeps private letters to primary trust and holds an unknown action to the strictest level', async () => {
    const { tool, calls } = fakeTool('letter');
    expect((await asViewer('trusted', () => tool.execute('l1', { action: 'read' }))).content[0]?.text)
      .toContain('withheld by visibility gating');
    expect((await asViewer('trusted', () => tool.execute('l2', {}))).content[0]?.text)
      .toContain('withheld by visibility gating');
    expect((await asViewer('primary', () => tool.execute('l3', { action: 'read' }))).content[0]?.text)
      .toBe('contact records');
    expect(calls).toHaveLength(1);
  });

  it('does not gate writes', async () => {
    const { tool, calls } = fakeTool('contact');
    await asViewer('public', () => tool.execute('w1', { action: 'note', contactId: 'c', notes: 'x' }));
    expect(calls).toHaveLength(1);
  });
});
