import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { composeDefaultFoundationTemplate } from './foundation-sections.js';
import { TEMPORAL_RULES_LAYER_CONTENT } from './temporal-rules-layer.js';
import {
  assertNoRemovedPromptMacros,
  assertStaticPromptLayerMacroVolatility,
  buildPromptMacroManifest,
  collectRemovedPromptMacroReferences,
  getVolatileClockPromptMacroNames,
  PromptRuntimeRenderError,
  REMOVED_PROMPT_MACROS,
  renderFinalPromptSection,
  resolvePromptMacroManifestEntry,
  getPromptRuntimeBlockDefinition,
  getPromptRuntimeBlockIdsByClassification,
  getPromptRuntimeImmutableAnchorDefinitions,
  getPromptRuntimeRequiredBlockIds,
  PROMPT_RUNTIME_MACRO_HINTS,
  injectPromptRuntimeTokens,
  isPromptRuntimeBlockCompanionEditable,
  isPromptRuntimeBlockImmutable,
  isPromptRuntimeBlockRequired,
  orderPromptRuntimeSystemPromptSections,
  PromptRuntimeLayoutStore,
  renderPromptRuntimeTokens,
  validatePromptRuntimeEditableBlockContents,
} from './prompt-runtime.js';
import { resolveCachedPromptRuntimeLayoutStore } from './prompt-runtime-store-cache.js';

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-prompt-runtime-'));
  return tempDir;
}

const RUNTIME_STATE_MACRO_TOKENS = [
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
  '{{runtime_continuity_gap_present}}',
  '{{runtime_continuity_gap_duration}}',
  '{{runtime_continuity_gap_offline_since}}',
  '{{runtime_internal_turn_kind}}',
  '{{runtime_conversation_state_available}}',
  '{{runtime_chat_type}}',
  '{{runtime_room_id}}',
  '{{runtime_current_message_author_xml}}',
  '{{runtime_current_message_author_name}}',
  '{{runtime_current_message_author_id}}',
  '{{runtime_current_message_author_name_xml_attr}}',
  '{{runtime_current_message_author_id_xml_attr}}',
  '{{runtime_current_message_author_timezone}}',
  '{{runtime_current_message_author_local_time}}',
  '{{runtime_recent_active_participants_xml}}',
  '{{runtime_recent_active_participants_count}}',
  '{{runtime_speaking_with_name}}',
  '{{runtime_speaking_with_trust_level}}',
  '{{runtime_channel_type}}',
  '{{runtime_channel_visibility}}',
  '{{runtime_capability_tier}}',
] as const;

const TRUST_MACRO_TOKENS = [
  '{{runtime_trust_is_primary}}',
  '{{runtime_trust_is_trusted}}',
  '{{runtime_trust_is_regular}}',
  '{{runtime_trust_is_public}}',
] as const;

const RESPONSE_STYLE_MACRO_TOKENS = [
  '{{runtime_response_style}}',
  '{{runtime_response_style_name}}',
  '{{runtime_response_style_is_concise}}',
  '{{runtime_response_style_is_expressive}}',
] as const;

const AFFECT_MACRO_TOKENS = [
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
] as const;

const INTERNAL_STATE_MACRO_TOKENS = [
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
] as const;

const ATTENTION_MACRO_TOKENS = [
  '{{runtime_concerns_count}}',
  '{{runtime_concerns_top_lines}}',
  '{{runtime_concerns_top_priorities}}',
  '{{runtime_concerns_omitted_count}}',
  '{{runtime_concerns_omitted_plural_suffix}}',
  '{{runtime_emotion_appraisal_length}}',
  '{{runtime_emotion_appraisal_latest_trigger}}',
  '{{runtime_emotion_appraisal_latest_summary}}',
  '{{runtime_emotion_appraisal_latest_timestamp_iso}}',
  '{{runtime_emotion_appraisal_recent_lines}}',
  '{{runtime_behavioral_notes_count}}',
  '{{runtime_behavioral_notes_body}}',
  '{{runtime_skills_count}}',
  '{{runtime_skills_index_body}}',
] as const;

const TOOLING_MACRO_TOKENS = [
  '{{runtime_analysis_workbench_available}}',
  '{{runtime_tooling_active_count}}',
  '{{runtime_tooling_core_count}}',
  '{{runtime_tooling_promoted_count}}',
  '{{runtime_tooling_loaded_count}}',
  '{{runtime_tooling_autoload_count}}',
  '{{runtime_tooling_deferred_count}}',
  '{{runtime_tooling_available_extended_count}}',
  '{{runtime_appearance_context_body}}',
  '{{runtime_self_image_tool_active}}',
  '{{runtime_extended_tools_total}}',
  '{{runtime_extended_tools_activatable_count}}',
  '{{runtime_extended_tools_blocked_count}}',
  '{{runtime_extended_tool_names}}',
  '{{runtime_extended_tool_directory_lines}}',
  '{{runtime_charge_budget_present}}',
  '{{runtime_charge_lane}}',
  '{{runtime_charge_quota}}',
  '{{runtime_charge_remaining}}',
  '{{runtime_charge_cost_lines}}',
] as const;

const METACOGNITIVE_FLAG_MACRO_TOKENS = [
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
] as const;


describe('runtime prompt block schema', () => {
  it('classifies required, optional, immutable, and editable runtime blocks', () => {
    const persona = getPromptRuntimeBlockDefinition('runtime.persona_adaptation');
    const scratchpad = getPromptRuntimeBlockDefinition('runtime.scratchpad');
    const currentDatetime = getPromptRuntimeBlockDefinition('runtime.current_datetime');
    const currentMessages = getPromptRuntimeBlockDefinition('session.current_messages');

    expect(persona?.schema.classification).toBe('required_runtime_aware');
    expect(isPromptRuntimeBlockRequired(persona!)).toBe(true);
    expect(isPromptRuntimeBlockCompanionEditable(persona!)).toBe(true);

    expect(currentDatetime?.schema.classification).toBe('required_runtime_aware');
    expect(isPromptRuntimeBlockRequired(currentDatetime!)).toBe(true);
    expect(isPromptRuntimeBlockCompanionEditable(currentDatetime!)).toBe(false);
    expect(currentDatetime?.reorderable).toBe(false);

    expect(scratchpad?.schema.classification).toBe('optional_runtime_aware');
    expect(isPromptRuntimeBlockRequired(scratchpad!)).toBe(false);
    expect(isPromptRuntimeBlockImmutable(scratchpad!)).toBe(false);

    expect(currentMessages?.schema.classification).toBe('immutable_provider_managed');
    expect(isPromptRuntimeBlockImmutable(currentMessages!)).toBe(true);
    expect(isPromptRuntimeBlockCompanionEditable(currentMessages!)).toBe(false);
  });

  it('exposes query helpers for follow-on save validation', () => {
    expect(getPromptRuntimeRequiredBlockIds({ includeImmutable: false })).toEqual([
      'runtime.persona_adaptation',
      'runtime.context',
      'memory.core',
      'memory.retrieval',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.orientation',
      'session.continuity',
      'runtime.current_datetime',
    ]);
    expect(getPromptRuntimeBlockIdsByClassification('immutable_provider_managed')).toEqual([
      'session.current_messages',
      'tools.active_schemas',
    ]);
    expect(getPromptRuntimeImmutableAnchorDefinitions().map(anchor => anchor.id)).toEqual([
      'constitution.immutable_human_safety_amendments',
      'foundation.card_backed_sections',
      'persona.card_backed_identity',
    ]);
  });

  it('reports missing and empty required companion-editable runtime blocks distinctly', () => {
    const result = validatePromptRuntimeEditableBlockContents({
      'runtime.persona_adaptation': '   ',
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        id: 'runtime.persona_adaptation',
        label: 'Persona Adaptation',
        reason: 'empty',
      },
      {
        id: 'runtime.context',
        label: 'Runtime Context',
        reason: 'missing',
      },
    ]);
  });
});

describe('injectPromptRuntimeTokens', () => {
  const fixedNow = new Date('2026-02-20T13:45:27.000Z');

  it('injects datetime/date/time/timestamp tokens', () => {
    const input = [
      'Now: {{current_datetime}}',
      'Date: {{current_date}}',
      'Time: {{current_time}}',
      'Unix: {{unix_timestamp}}',
    ].join('\n');

    const output = injectPromptRuntimeTokens(input, { now: fixedNow });

    expect(output).toContain('Now: 2026-02-20T08:45:27.000-05:00');
    expect(output).toContain('Date: 2026-02-20');
    expect(output).toContain('Time: 08:45:27-05:00');
    expect(output).toContain('Unix: 1771595127');
  });

  it('no longer resolves removed clock alias spellings (clean break, no runtime alias)', () => {
    const input = 'A={{now()}} B={{date()}} C={{time()}} D={{timestamp()}} E={{current_datetime_iso}}';
    const result = renderPromptRuntimeTokens(input, { now: fixedNow });

    // Removed aliases stay literal and are reported unresolved; the persisted
    // layer safety valve rejects them upstream with the canonical replacement.
    expect(result.text).toBe(input);
    expect(result.unresolvedTokens.sort()).toEqual([
      'current_datetime_iso',
      'date',
      'now',
      'time',
      'timestamp',
    ]);
  });

  it('leaves unknown placeholders untouched', () => {
    const input = 'Keep {{unknown_token}} unchanged';
    const output = injectPromptRuntimeTokens(input, { now: fixedNow });

    expect(output).toBe('Keep {{unknown_token}} unchanged');
  });

  it('reports unresolved macro tokens explicitly', () => {
    const input = 'Known={{user}} Unknown={{unknown_token}}';
    const unresolved: string[] = [];
    const output = renderPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: { user: 'PrimaryUser' },
      onUnresolvedToken: (token) => unresolved.push(token),
    });

    expect(output.text).toBe('Known=PrimaryUser Unknown={{unknown_token}}');
    expect(output.unresolvedTokens).toEqual(['unknown_token']);
    expect(unresolved).toEqual(['unknown_token']);
  });

  it('reports unresolved missing dotted keys once', () => {
    const unresolved: string[] = [];
    const output = renderPromptRuntimeTokens(
      'Missing={{character.extensions.voice_style}} Repeat={{character.extensions.voice_style}}',
      {
        now: fixedNow,
        variables: {
          character: {
            name: 'Companion',
          },
        },
        onUnresolvedToken: (token) => unresolved.push(token),
      },
    );

    expect(output.text).toBe(
      'Missing={{character.extensions.voice_style}} Repeat={{character.extensions.voice_style}}',
    );
    expect(output.unresolvedTokens).toEqual(['character.extensions.voice_style']);
    expect(unresolved).toEqual(['character.extensions.voice_style']);
  });

  it('injects simple prompt variables', () => {
    const input = 'Hello {{user}}, you are speaking with {{char}} in {{channel_id}}';
    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        user: 'PrimaryUser',
        char: 'Companion',
        channel_id: 'discord:dm:primary-user',
      },
    });

    expect(output).toBe('Hello PrimaryUser, you are speaking with Companion in discord:dm:primary-user');
  });

  it('supports dotted and snake-case aliases for variables', () => {
    const input = 'Model={{model_id}} Trust={{trust_level}} Canonical={{contact.canonicalId}}';
    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        modelId: 'moonshotai/kimi-k2.5',
        trustLevel: 'primary',
        contact: {
          canonicalId: 'contact-123',
        },
      },
    });

    expect(output).toBe('Model=moonshotai/kimi-k2.5 Trust=primary Canonical=contact-123');
  });

  it('resolves nested runtime tokens introduced by variable substitution', () => {
    const input = '{{description}}';
    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        description: 'Hello {{user}}, this is {{char}}.',
        user: 'Anon',
        char: 'Companion',
      },
    });

    expect(output).toBe('Hello Anon, this is Companion.');
  });

  it('renders simple conditional blocks from runtime variables', () => {
    const input = [
      '{{#if runtime_trust_is_trusted}}Trusted guidance.{{/if}}',
      '{{#if runtime_trust_is_public}}Public guidance.{{/if}}',
    ].join('\n');

    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        runtime_trust_is_trusted: 'true',
        runtime_trust_is_public: 'false',
      },
    });

    expect(output).toBe('Trusted guidance.');
  });

  it('drops wrapped prompt sections whose body resolves to empty content', () => {
    const input = [
      '<current_datetime>',
      '{{runtime_current_datetime_human}}',
      '</current_datetime>',
      '',
      '<appearance_context>',
      '{{runtime_appearance_context_body}}',
      '</appearance_context>',
    ].join('\n');

    const output = injectPromptRuntimeTokens(input, {
      now: fixedNow,
      variables: {
        runtime_current_datetime_human: 'Thursday, February 20, 2026 at 8:45 AM',
        runtime_appearance_context_body: '',
      },
    });

    expect(output).toContain('<current_datetime>');
    expect(output).not.toContain('<appearance_context>');
  });

  it('persists and applies runtime system-prompt block ordering', () => {
    const root = makeTempDir();
    const store = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));

    store.reorderSystemPromptBlocks([
      'session.continuity',
      'session.cogsec_notices',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.orientation',
    ], 'admin');

    const reloadedStore = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));
    expect(reloadedStore.getSystemPromptBlockOrder()).toEqual([
      'session.continuity',
      'session.cogsec_notices',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.orientation',
    ]);

    const ordered = orderPromptRuntimeSystemPromptSections([
      { id: 'runtime.context' as const, content: 'runtime' },
      { id: 'session.continuity' as const, content: 'continuity' },
      { id: 'memory.retrieval' as const, content: 'retrieval' },
    ], reloadedStore);

    expect(ordered.map(section => section.id)).toEqual([
      'session.continuity',
      'memory.retrieval',
      'runtime.context',
    ]);
  });

  it('reuses the same cached runtime layout store for repeated config resolution', () => {
    const root = makeTempDir();
    const firstStore = resolveCachedPromptRuntimeLayoutStore({ companionDataDir: root });

    firstStore.reorderSystemPromptBlocks([
      'session.continuity',
      'session.cogsec_notices',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.orientation',
    ], 'admin');

    const secondStore = resolveCachedPromptRuntimeLayoutStore({ companionDataDir: root });
    expect(secondStore).toBe(firstStore);
    expect(secondStore.getSystemPromptBlockOrder()).toEqual([
      'session.continuity',
      'session.cogsec_notices',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.orientation',
    ]);
  });

  it('persists companion-editable runtime block content across reloads and reorder operations', () => {
    const root = makeTempDir();
    const store = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));

    store.setEditableBlockContent(
      'runtime.context',
      'Companion-specific runtime guidance.',
      'admin',
    );
    store.reorderSystemPromptBlocks([
      'session.continuity',
      'session.cogsec_notices',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.orientation',
    ], 'admin');

    const reloadedStore = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));
    expect(reloadedStore.getEditableBlockContent('runtime.context')).toBe('Companion-specific runtime guidance.');
    expect(reloadedStore.getEditableBlockContentMap()).toMatchObject({
      'runtime.context': 'Companion-specific runtime guidance.',
    });
  });

  it('preserves saved runtime order while inserting newly added reorderable blocks', () => {
    const root = makeTempDir();
    writeFileSync(join(root, 'prompt-runtime-layout.json'), JSON.stringify({
      version: 1,
      systemPromptBlockOrder: [
        'session.continuity',
        'memory.core',
        'memory.retrieval',
        'runtime.persona_adaptation',
        'runtime.context',
        'runtime.scratchpad',
        'session.compaction_summary',
        'session.focus_knowledge',
      ],
      editableBlockContent: {},
      updatedAt: '2026-06-16T00:00:00.000Z',
      updatedBy: 'admin',
    }));

    const store = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));
    expect(store.getSystemPromptBlockOrder()).toEqual([
      'session.orientation',
      'session.continuity',
      'session.cogsec_notices',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
    ]);
  });

  it('rejects invalid runtime block orders that do not include the full reorderable set', () => {
    const root = makeTempDir();
    const store = new PromptRuntimeLayoutStore(join(root, 'prompt-runtime-layout.json'));

    const invalidOrder = [
      'runtime.context',
      'runtime.scratchpad',
    ] as unknown as Parameters<typeof store.reorderSystemPromptBlocks>[0];
    expect(() => store.reorderSystemPromptBlocks(invalidOrder, 'admin')).toThrow(
      'systemPromptBlockOrder must include each reorderable runtime block exactly once',
    );
  });
});

describe('prompt runtime macro hints', () => {
  it('groups runtime state, trust, and response-style macros for prompt authors', () => {
    const hintsByToken = new Map(PROMPT_RUNTIME_MACRO_HINTS.map(entry => [entry.token, entry]));

    for (const token of RUNTIME_STATE_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('runtime_state');
    }

    for (const token of TRUST_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('trust');
    }

    for (const token of RESPONSE_STYLE_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('response_style');
    }
  });

  it('documents the atomic affect macros with descriptions and examples', () => {
    const hintsByToken = new Map(PROMPT_RUNTIME_MACRO_HINTS.map(entry => [entry.token, entry]));

    for (const token of AFFECT_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('affect');
      expect(hint?.description).toBeTruthy();
      expect(hint?.example).toBeTruthy();
    }
  });

  it('documents the atomic internal-state macros with descriptions and examples', () => {
    const hintsByToken = new Map(PROMPT_RUNTIME_MACRO_HINTS.map(entry => [entry.token, entry]));

    for (const token of INTERNAL_STATE_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('internal_state');
      expect(hint?.description).toBeTruthy();
      expect(hint?.example).toBeTruthy();
    }
  });

  it('documents the atomic attention and tooling macros with descriptions and examples', () => {
    const hintsByToken = new Map(PROMPT_RUNTIME_MACRO_HINTS.map(entry => [entry.token, entry]));

    for (const token of ATTENTION_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('attention');
      expect(hint?.description).toBeTruthy();
      expect(hint?.example).toBeTruthy();
    }

    for (const token of TOOLING_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('tooling');
      expect(hint?.description).toBeTruthy();
      expect(hint?.example).toBeTruthy();
    }
  });

  it('documents the atomic metacognition flag macros with descriptions and examples', () => {
    const hintsByToken = new Map(PROMPT_RUNTIME_MACRO_HINTS.map(entry => [entry.token, entry]));

    for (const token of METACOGNITIVE_FLAG_MACRO_TOKENS) {
      const hint = hintsByToken.get(token);
      expect(hint).toBeDefined();
      expect(hint?.group).toBe('metacognition');
      expect(hint?.description).toBeTruthy();
      expect(hint?.example).toBeTruthy();
    }
  });
});

describe('prompt macro manifest', () => {
  it('registers every hint with a volatility class and a producer', () => {
    for (const hint of PROMPT_RUNTIME_MACRO_HINTS) {
      expect(['static', 'session_stable', 'turn']).toContain(hint.volatility);
      expect(hint.producer).toBeTruthy();
    }
  });

  it('throws on duplicate macro registration (fail closed)', () => {
    const hint = {
      group: 'global_aliases' as const,
      token: '{{user}}',
      description: 'dup',
      example: 'dup',
      volatility: 'session_stable' as const,
      producer: 'test:dup',
    };
    expect(() => buildPromptMacroManifest([hint, hint]))
      .toThrow(/Duplicate prompt macro registration: "user"/);
  });

  it('resolves compatibility aliases and prefix rules through the manifest', () => {
    // SillyTavern-compatible card-field aliases remain an external
    // compatibility surface (documented compatibility group).
    expect(resolvePromptMacroManifestEntry('user_name')?.volatility).toBe('session_stable');
    expect(resolvePromptMacroManifestEntry('char_name')?.volatility).toBe('static');
    expect(resolvePromptMacroManifestEntry('character_name')?.volatility).toBe('static');
    expect(resolvePromptMacroManifestEntry('extensions_visual_description')?.volatility).toBe('static');
    expect(resolvePromptMacroManifestEntry('character.extensions.likes')?.volatility).toBe('static');
    expect(resolvePromptMacroManifestEntry('extensions_anything')?.volatility).toBe('static');
    expect(resolvePromptMacroManifestEntry('runtime_not_a_real_macro')).toBeNull();
  });

  it('no longer resolves removed alias spellings through the manifest (clean break)', () => {
    for (const removed of [
      'now',
      'now()',
      'current_datetime_iso',
      'date',
      'time',
      'timestamp',
      'current_timestamp',
      'now_iso',
      'channel',
      'model_id',
      'runtime_trust_level',
      'runtime_tooling_summary',
      'runtime_affect_privacy_guidance',
      'runtime_last_message_received_human',
      'runtime_last_message_received_missing_notice',
    ]) {
      expect(resolvePromptMacroManifestEntry(removed), removed).toBeNull();
    }
  });

  it('derives the volatile clock token set from the manifest (canonical spellings only)', () => {
    const clockNames = new Set(getVolatileClockPromptMacroNames());
    expect([...clockNames].sort()).toEqual([
      'current_date',
      'current_datetime',
      'current_time',
      'unix_timestamp',
    ]);
    // Non-clock turn macros are enforced by static-layer validation, not by the
    // clock-volatility cacheability classification.
    expect(clockNames.has('runtime_current_datetime_iso')).toBe(false);
  });

  it('registers every macro used by the seeded runtime prompt layers', () => {
    const seedPath = join(process.cwd(), 'config', 'runtime-prompt-layers.seed.json');
    const seed = JSON.parse(readFileSync(seedPath, 'utf-8')) as {
      layers: Array<{ identifier: string; content: string }>;
    };
    expect(seed.layers.length).toBeGreaterThan(0);

    const tokenPattern = /\{\{\s*(?:#if\s+)?([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g;
    for (const layer of seed.layers) {
      for (const match of layer.content.matchAll(tokenPattern)) {
        const name = match[1];
        if (name === '/if') continue;
        expect(
          resolvePromptMacroManifestEntry(name),
          `Unregistered macro {{${name}}} in seeded layer ${layer.identifier}`,
        ).not.toBeNull();
      }
    }
  });

  it('keeps the seeded static-class layers free of turn-volatile macros', () => {
    expect(() => assertStaticPromptLayerMacroVolatility(composeDefaultFoundationTemplate(), 'foundation'))
      .not.toThrow();
    expect(() => assertStaticPromptLayerMacroVolatility(TEMPORAL_RULES_LAYER_CONTENT, 'operator.temporal_rules'))
      .not.toThrow();
  });

  it('fails validation with a clear error when a static layer references a turn-volatile macro', () => {
    expect(() => assertStaticPromptLayerMacroVolatility(
      'Today is {{runtime_current_datetime_iso}}.',
      'base.identity',
    )).toThrow(/Static prompt layer "base.identity" references turn-volatile macro\(s\): \{\{runtime_current_datetime_iso\}\}/);

    expect(() => assertStaticPromptLayerMacroVolatility('The time is {{current_datetime}}.', 'base.identity'))
      .toThrow(/turn-volatile/);

    // Static and session-stable macros stay legal in static-class layers.
    expect(() => assertStaticPromptLayerMacroVolatility(
      'You are {{char}}, speaking with {{user}} on {{channel_type}}. {{description}}',
      'base.identity',
    )).not.toThrow();
  });
});

describe('removed prompt macros (E2.5 safety valve)', () => {
  it('keeps the removed-macro table disjoint from the live manifest', () => {
    for (const removedName of REMOVED_PROMPT_MACROS.keys()) {
      expect(resolvePromptMacroManifestEntry(removedName), removedName).toBeNull();
    }
  });

  it('collects removed macro references including {{#if}} conditions', () => {
    const references = collectRemovedPromptMacroReferences(
      'Time {{now}} + {{#if runtime_trust_level}}gated{{/if}} + {{runtime_tooling_summary}} + ok {{current_datetime}}',
    );
    expect(references.map(reference => reference.name).sort()).toEqual([
      'now',
      'runtime_tooling_summary',
      'runtime_trust_level',
    ]);
    expect(references.find(reference => reference.name === 'now')?.canonical).toBe('{{current_datetime}}');
  });

  it('fails a persisted layer that references a removed alias with the canonical replacement', () => {
    expect(() => assertNoRemovedPromptMacros('Today is {{now}}.', 'operator.custom'))
      .toThrow(/Prompt layer "operator\.custom" references removed prompt macro\(s\): \{\{now\}\} \(removed; use \{\{current_datetime\}\}\)/);
    expect(() => assertNoRemovedPromptMacros('Today is {{current_datetime}}.', 'operator.custom'))
      .not.toThrow();
  });
});

describe('renderFinalPromptSection (E2.5 no-silent-leak invariant)', () => {
  const fixedNow = new Date('2026-02-20T13:45:27.000Z');

  it('renders a fully-resolved required section', () => {
    const output = renderFinalPromptSection('Hello {{user}} at {{current_datetime}}', {
      now: fixedNow,
      variables: { user: 'PrimaryUser' },
      sectionLabel: 'runtime.state',
      required: true,
    });
    expect(output).toBe('Hello PrimaryUser at 2026-02-20T08:45:27.000-05:00');
    expect(output).not.toContain('{{');
  });

  it('fails loudly when a required section has an unresolved token', () => {
    expect(() => renderFinalPromptSection('<state>{{runtime_not_produced}}</state>x', {
      now: fixedNow,
      variables: {},
      sectionLabel: 'runtime.state',
      required: true,
    })).toThrow(PromptRuntimeRenderError);

    try {
      renderFinalPromptSection('<state>{{runtime_not_produced}}</state>x', {
        now: fixedNow,
        variables: {},
        sectionLabel: 'runtime.state',
        required: true,
      });
      expect.unreachable('required section with unresolved token must throw');
    } catch (error) {
      const renderError = error as PromptRuntimeRenderError;
      expect(renderError.sectionLabel).toBe('runtime.state');
      expect(renderError.unresolvedTokens).toEqual(['runtime_not_produced']);
      expect(renderError.message).toContain('required prompt section "runtime.state"');
    }
  });

  it('names the canonical replacement when the unresolved token is a removed macro', () => {
    expect(() => renderFinalPromptSection('Trust: {{runtime_trust_level}}!', {
      now: fixedNow,
      variables: {},
      sectionLabel: 'runtime.self',
      required: true,
    })).toThrow(/\{\{runtime_trust_level\}\} \(removed macro; use \{\{trust_level\}\}\)/);
  });

  it('drops an optional section with telemetry instead of leaking tokens', () => {
    const drops: Array<{ sectionLabel: string; unresolvedTokens: string[] }> = [];
    const output = renderFinalPromptSection('<attention>{{runtime_not_produced}}</attention>keep-me?', {
      now: fixedNow,
      variables: {},
      sectionLabel: 'runtime.attention',
      required: false,
      onSectionDrop: (drop) => drops.push(drop),
    });
    expect(output).toBe('');
    expect(drops).toEqual([
      { sectionLabel: 'runtime.attention', unresolvedTokens: ['runtime_not_produced'] },
    ]);
  });

  it('never emits an unresolved token into final output (required or optional)', () => {
    const template = '<a>{{resolved}}</a>\n<b>{{ghost_token}}</b>';
    // Optional: drops.
    const optional = renderFinalPromptSection(template, {
      now: fixedNow,
      variables: { resolved: 'value' },
      sectionLabel: 'section',
      required: false,
    });
    expect(optional).not.toContain('{{');
    // Required: throws (nothing emitted).
    expect(() => renderFinalPromptSection(template, {
      now: fixedNow,
      variables: { resolved: 'value' },
      sectionLabel: 'section',
      required: true,
    })).toThrow(PromptRuntimeRenderError);
  });

  it('treats unbalanced conditional markers as a leak (fail closed)', () => {
    expect(() => renderFinalPromptSection('broken {{#if some_flag}} block without close', {
      now: fixedNow,
      variables: { some_flag: 'true' },
      sectionLabel: 'section',
      required: true,
    })).toThrow(PromptRuntimeRenderError);
  });
});

describe('single-pass renderer semantics (E2.5)', () => {
  const fixedNow = new Date('2026-02-20T13:45:27.000Z');

  it('preserves the self-referential template idiom (user -> literal {{user}}) without recursing', () => {
    const result = renderPromptRuntimeTokens('Hello {{user}} from {{char}}', {
      now: fixedNow,
      variables: { user: '{{user}}', char: 'Companion' },
    });
    expect(result.text).toBe('Hello {{user}} from Companion');
    expect(result.unresolvedTokens).toEqual(['user']);
  });

  it('expands macros nested several values deep in one template pass', () => {
    const result = renderPromptRuntimeTokens('{{outer}}', {
      now: fixedNow,
      variables: {
        outer: 'o({{middle}})',
        middle: 'm({{inner}})',
        inner: 'time={{current_datetime}}',
      },
    });
    expect(result.text).toBe('o(m(time=2026-02-20T08:45:27.000-05:00))');
    expect(result.unresolvedTokens).toEqual([]);
  });

  it('resolves conditionals introduced by substituted values', () => {
    const result = renderPromptRuntimeTokens('{{wrapper}}', {
      now: fixedNow,
      variables: {
        wrapper: '{{#if flag}}shown {{name}}{{/if}}',
        flag: 'true',
        name: 'Companion',
      },
    });
    expect(result.text).toBe('shown Companion');
  });

  it('prunes nested wrappers that only empty after inner pruning (fixpoint)', () => {
    const result = renderPromptRuntimeTokens('<outer>\n<inner>{{empty}}</inner>\n</outer>', {
      now: fixedNow,
      variables: { empty: '' },
    });
    expect(result.text).toBe('');
  });
});
