import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { injectPromptRuntimeTokens } from './prompt-runtime.js';
import { PromptLayerStore } from './prompt-store.js';
import { EMOTIONAL_AFFECT_BODY_TEMPLATE } from '../emotion/persona-adaptation.js';
import { OPEN_THREADS_BODY_TEMPLATE } from '../intention/concerns.js';
import { METACOGNITIVE_PERSONA_GUIDANCE_BODY_TEMPLATE } from '../self-model/metacognition.js';
import {
  ANALYSIS_WORKBENCH_GUIDANCE_BODY_TEMPLATE,
  EXTENDED_TOOLS_BODY_TEMPLATE,
  INTERNAL_STATE_BODY_TEMPLATE,
  RESPONSE_STYLE_GUIDANCE_BODY_TEMPLATE,
  SELF_IMAGE_TOOL_GUIDANCE_BODY_TEMPLATE,
  TRUST_GUIDANCE_BODY_TEMPLATE,
} from '../agent/substrate-agent/runtime-prompt-templates.js';
import {
  ensureRuntimePromptLayers,
  getRequiredRuntimePromptSignalManifest,
  getRuntimePromptLayerDefinition,
  getRuntimePromptLayerDefinitions,
  isRequiredRuntimePromptLayer,
  validateRuntimePromptLayerCoverage,
} from './runtime-prompt-layers.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-runtime-prompt-layers-'));
  return tempDir;
}

const LEGACY_RUNTIME_LAYER_SEEDS = [
  {
    identifier: 'runtime.last_message_received',
    name: 'Last Message Received',
    priority: 100,
    content: "<last_message_received>\n<weekday>{{runtime_last_message_received_weekday}}</weekday>\n<date>{{runtime_last_message_received_date_human}}</date>\n<time>{{runtime_last_message_received_time_human}}</time>\n<timezone>{{runtime_last_message_received_timezone}}</timezone>\n<elapsed_time_since_last>{{runtime_last_message_received_ago}}</elapsed_time_since_last>\n<status>{{runtime_last_message_received_missing_notice}}</status>\n</last_message_received>",
  },
  {
    identifier: 'runtime.internal_turn_context',
    name: 'Internal Turn Context',
    priority: 110,
    content: "<internal_turn_context>\n<kind>{{runtime_internal_turn_kind}}</kind>\n</internal_turn_context>",
  },
  {
    identifier: 'runtime.speaking_with',
    name: 'Speaking With',
    priority: 120,
    content: "<speaking_with>\n<name>{{runtime_speaking_with_name}}</name>\n<trust_level>{{runtime_speaking_with_trust_level}}</trust_level>\n</speaking_with>",
  },
  {
    identifier: 'runtime.channel_context',
    name: 'Channel Context',
    priority: 130,
    content: "<channel_context>\n<type>{{runtime_channel_type}}</type>\n<visibility>{{runtime_channel_visibility}}</visibility>\n</channel_context>",
  },
  {
    identifier: 'runtime.model_context',
    name: 'Model Context',
    priority: 140,
    content: "<model_context>\n<identifier>{{model}}</identifier>\n</model_context>",
  },
  {
    identifier: 'runtime.capability_tier',
    name: 'Capability Tier',
    priority: 150,
    content: "<capability_tier>\n<tier>{{runtime_capability_tier}}</tier>\n</capability_tier>",
  },
  {
    identifier: 'runtime.tooling',
    name: 'Tooling',
    priority: 160,
    content: `<tooling>\n<active_count>{{runtime_tooling_active_count}}</active_count>\n<core_count>{{runtime_tooling_core_count}}</core_count>\n<promoted_count>{{runtime_tooling_promoted_count}}</promoted_count>\n<loaded_count>{{runtime_tooling_loaded_count}}</loaded_count>\n<autoload_count>{{runtime_tooling_autoload_count}}</autoload_count>\n<deferred_count>{{runtime_tooling_deferred_count}}</deferred_count>\n<available_extended_count>{{runtime_tooling_available_extended_count}}</available_extended_count>\n</tooling>\n<analysis_workbench_guidance>\n${ANALYSIS_WORKBENCH_GUIDANCE_BODY_TEMPLATE}\n</analysis_workbench_guidance>`,
  },
  {
    identifier: 'runtime.trust',
    name: 'Trust Guidance',
    priority: 170,
    content: `<trust>\n${TRUST_GUIDANCE_BODY_TEMPLATE}\n</trust>`,
  },
  {
    identifier: 'runtime.emotional_affect',
    name: 'Emotional Affect',
    priority: 180,
    content: `<emotional_affect>\n${EMOTIONAL_AFFECT_BODY_TEMPLATE}\n</emotional_affect>`,
  },
  {
    identifier: 'runtime.metacognitive_guidance',
    name: 'Metacognitive Guidance',
    priority: 190,
    content: `<metacognitive_persona_guidance>\n${METACOGNITIVE_PERSONA_GUIDANCE_BODY_TEMPLATE}\n</metacognitive_persona_guidance>`,
  },
  {
    identifier: 'runtime.response_style_guidance',
    name: 'Response Style Guidance',
    priority: 200,
    content: `<response_style_guidance>\n${RESPONSE_STYLE_GUIDANCE_BODY_TEMPLATE}\n</response_style_guidance>`,
  },
  {
    identifier: 'runtime.internal_state',
    name: 'Internal State',
    priority: 210,
    content: `<internal_state>\n${INTERNAL_STATE_BODY_TEMPLATE}\n</internal_state>`,
  },
  {
    identifier: 'runtime.emotion_appraisal_chain',
    name: 'Emotion Appraisal Chain',
    priority: 220,
    content: "<emotion_appraisal_chain>\n{{runtime_emotion_appraisal_body}}\n</emotion_appraisal_chain>",
  },
  {
    identifier: 'runtime.open_threads',
    name: 'Open Threads',
    priority: 230,
    content: `<open_threads>\n${OPEN_THREADS_BODY_TEMPLATE}\n</open_threads>`,
  },
  {
    identifier: 'runtime.behavioral_notes',
    name: 'Behavioral Notes',
    priority: 240,
    content: "<behavioral_notes>\n{{runtime_behavioral_notes_body}}\n</behavioral_notes>",
  },
  {
    identifier: 'runtime.skills_index',
    name: 'Skills Index',
    priority: 250,
    content: "<skills_index>\n{{runtime_skills_index_body}}\n</skills_index>",
  },
  {
    identifier: 'runtime.appearance_context',
    name: 'Appearance Context',
    priority: 260,
    content: "<appearance_context>\n{{runtime_appearance_context_body}}\n</appearance_context>",
  },
  {
    identifier: 'runtime.self_image_tool_guidance',
    name: 'Self-Image Tool Guidance',
    priority: 270,
    content: `<self_image_tool_guidance>\n${SELF_IMAGE_TOOL_GUIDANCE_BODY_TEMPLATE}\n</self_image_tool_guidance>`,
  },
  {
    identifier: 'runtime.extended_tools',
    name: 'Extended Tools',
    priority: 280,
    content: `<extended_tools>\n${EXTENDED_TOOLS_BODY_TEMPLATE}\n</extended_tools>`,
  },
  {
    identifier: 'runtime.current_datetime',
    name: 'Current Date & Time',
    priority: 290,
    content: '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,continuity_anchor,wake_orientation,cross_channel_continuity">\n<iso>{{runtime_current_datetime_iso}}</iso>\n<timezone>{{active_timezone}}</timezone>\n<weekday>{{runtime_current_weekday}}</weekday>\n<date>{{runtime_current_date_human}}</date>\n<time>{{runtime_current_time_human}}</time>\n<today>{{runtime_current_today}}</today>\n<yesterday>{{runtime_current_yesterday}}</yesterday>\n<tomorrow>{{runtime_current_tomorrow}}</tomorrow>\n<part_of_day>{{runtime_current_part_of_day}}</part_of_day>\n</runtime.current_datetime>',
  },
] as const;

function seedLegacyRuntimeLayers(
  store: PromptLayerStore,
  overrides: Partial<Record<(typeof LEGACY_RUNTIME_LAYER_SEEDS)[number]['identifier'], Partial<{
    name: string;
    content: string;
    enabled: boolean;
    role: 'system';
    promptOrder: number;
    priority: number;
  }>>> = {},
): void {
  for (const seed of LEGACY_RUNTIME_LAYER_SEEDS) {
    const override = overrides[seed.identifier] ?? {};
    store.create({
      type: 'runtime',
      name: override.name ?? seed.name,
      identifier: seed.identifier,
      role: override.role ?? 'system',
      promptOrder: override.promptOrder ?? seed.priority,
      priority: override.priority ?? seed.priority,
      enabled: override.enabled ?? true,
      content: override.content ?? seed.content,
      updatedBy: 'system',
    });
  }
}

function createMigrationLogger() {
  const events: Array<{ message: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    logger: {
      info: (message: string, payload: Record<string, unknown>) => {
        events.push({ message, payload });
      },
    },
  };
}

const REQUIRED_RUNTIME_SIGNAL_SECTIONS: Record<string, string> = {
  'runtime.last_message_received': '<last_message_received>{{runtime_last_message_received_weekday}}</last_message_received>',
  'runtime.internal_turn_context': '<internal_turn_context>{{runtime_internal_turn_kind}}</internal_turn_context>',
  'runtime.speaking_with': '<speaking_with>{{runtime_speaking_with_name}}</speaking_with>',
  'runtime.channel_context': '<channel_context>{{runtime_channel_visibility}}</channel_context>',
  'runtime.conversation_state': '<conversation_state>{{runtime_chat_type}}{{runtime_current_message_author_name}}</conversation_state>',
  'runtime.model_context': '<model_context>{{model}}</model_context>',
  'runtime.capability_tier': '<capability_tier>{{runtime_capability_tier}}</capability_tier>',
  'runtime.current_datetime': '<runtime.current_datetime>{{runtime_current_datetime_iso}}</runtime.current_datetime>',
  'runtime.trust': '<trust>{{#if runtime_trust_is_primary}}primary{{/if}}</trust>',
  'runtime.emotional_affect': '<emotional_affect>{{runtime_affect_mode_label}}</emotional_affect>',
  'runtime.metacognitive_guidance': '<metacognitive_persona_guidance>{{runtime_flag_uncertainty_present}}</metacognitive_persona_guidance>',
  'runtime.response_style_guidance': '<response_style_guidance>{{runtime_response_style}}</response_style_guidance>',
  'runtime.internal_state': '<internal_state>{{runtime_internal_state_cognitive_processing_quality}}</internal_state>',
  'runtime.tooling': '<tooling>{{runtime_tooling_active_count}}</tooling>',
};

function buildCustomRuntimeSignalLayer(
  omittedSignalIdentifiers: readonly string[] = [],
): {
  type: 'runtime';
  identifier: string;
  content: string;
  enabled: boolean;
} {
  return {
    type: 'runtime',
    identifier: 'runtime.custom',
    content: getRequiredRuntimePromptSignalManifest()
      .filter(signal => !omittedSignalIdentifiers.includes(signal.identifier))
      .map(signal => REQUIRED_RUNTIME_SIGNAL_SECTIONS[signal.identifier])
      .join('\n\n'),
    enabled: true,
  };
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('runtime prompt layer schema', () => {
  it('marks the umbrella runtime state/self/tooling layers as required runtime-aware sections', () => {
    expect(isRequiredRuntimePromptLayer('runtime.state')).toBe(true);
    expect(isRequiredRuntimePromptLayer('runtime.self')).toBe(true);
    expect(isRequiredRuntimePromptLayer('runtime.tooling')).toBe(true);
    expect(getRuntimePromptLayerDefinition('runtime.state')?.schema.classification).toBe('required_runtime_aware');
    expect(getRuntimePromptLayerDefinition('runtime.self')?.schema.classification).toBe('required_runtime_aware');
  });

  it('marks the umbrella runtime attention layer as optional', () => {
    expect(isRequiredRuntimePromptLayer('runtime.attention')).toBe(false);
    expect(getRuntimePromptLayerDefinition('runtime.attention')?.schema.classification).toBe('optional_runtime_aware');
  });

  it('returns cloned schema metadata for callers', () => {
    const definitions = getRuntimePromptLayerDefinitions();
    expect(definitions.map(definition => definition.identifier)).toEqual([
      'runtime.self',
      'runtime.attention',
      'runtime.tooling',
      'runtime.state',
    ]);
    definitions[0]!.schema.required = false;
    expect(getRuntimePromptLayerDefinition('runtime.state')?.schema.required).toBe(true);
  });

  it('returns cloned required runtime signal metadata for callers', () => {
    const manifest = getRequiredRuntimePromptSignalManifest();

    expect(manifest.map(signal => signal.identifier)).toEqual([
      'runtime.last_message_received',
      'runtime.internal_turn_context',
      'runtime.conversation_state',
      'runtime.trust',
      'runtime.emotional_affect',
      'runtime.metacognitive_guidance',
      'runtime.response_style_guidance',
      'runtime.internal_state',
      'runtime.tooling',
    ]);
    manifest[0]!.required = false;

    expect(getRequiredRuntimePromptSignalManifest()[0]?.required).toBe(true);
  });

  it('uses atomic macros and moved prose inside the umbrella templates', () => {
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).not.toContain('<current_datetime>');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).not.toContain('{{runtime_current_weekday}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_last_message_received_timezone}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_last_message_received_missing_notice}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_internal_turn_kind}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('<conversation_state>');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_chat_type}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_current_message_author_name_xml_attr}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_recent_active_participants_xml}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_channel_visibility}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).not.toContain('<model_context>');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).not.toContain('<capability_tier>');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).not.toContain('<speaking_with>');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).not.toContain('{{runtime_tooling_active_count}}');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).toContain('<analysis_workbench_guidance>');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).toContain('{{#if runtime_analysis_workbench_available}}');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).toContain('large files, codebases, logs, transcripts, datasets, or evidence sets');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).toContain('Do not use analysis_workbench for routine orient actions, concern maintenance, scheduler or schedule work, simple lookup');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).toContain('{{runtime_appearance_context_body}}');
    expect(getRuntimePromptLayerDefinition('runtime.self')?.content).toContain('{{runtime_response_style}}');
    expect(getRuntimePromptLayerDefinition('runtime.self')?.content).toContain('{{#if runtime_response_style_is_concise}}');
    expect(getRuntimePromptLayerDefinition('runtime.self')?.content).toContain('{{#if runtime_trust_is_trusted}}');
    expect(getRuntimePromptLayerDefinition('runtime.self')?.content).toContain('{{runtime_affect_mode_label}}');
    expect(getRuntimePromptLayerDefinition('runtime.self')?.content).toContain('runtime_flag_uncertainty_present');
    expect(getRuntimePromptLayerDefinition('runtime.self')?.content).toContain('{{runtime_internal_state_cognitive_processing_quality}}');
    expect(getRuntimePromptLayerDefinition('runtime.attention')?.content).toContain('{{runtime_emotion_appraisal_body}}');
    expect(getRuntimePromptLayerDefinition('runtime.attention')?.content).toContain('{{runtime_behavioral_notes_body}}');
    expect(getRuntimePromptLayerDefinition('runtime.attention')?.content).toContain('{{runtime_skills_index_body}}');
  });

  it('renders structured runtime metadata and prunes unavailable nested fields', () => {
    const template = [
      getRuntimePromptLayerDefinition('runtime.state')?.content ?? '',
      getRuntimePromptLayerDefinition('runtime.self')?.content ?? '',
    ].join('\n\n');

    const rendered = injectPromptRuntimeTokens(template, {
      variables: {
        runtime_last_message_received_weekday: '',
        runtime_last_message_received_date_human: '',
        runtime_last_message_received_time_human: '',
        runtime_last_message_received_timezone: '',
        runtime_last_message_received_ago: '',
        runtime_last_message_received_missing_notice: 'No earlier message is loaded for this channel.',
        runtime_internal_turn_kind: '',
        runtime_response_style: 'concise',
        runtime_response_style_is_concise: 'true',
        runtime_response_style_is_expressive: 'false',
      },
    });

    expect(rendered).toContain('<runtime_state>');
    expect(rendered).toContain('<runtime_self>');
    expect(rendered).toContain('<status>No earlier message is loaded for this channel.</status>');
    expect(rendered).not.toContain('<weekday></weekday>');
    expect(rendered).not.toContain('<kind>');
    expect(rendered).toContain('<style>concise</style>');
    expect(rendered).toContain('<delivery>Answer directly and keep wording tight.</delivery>');
  });

  it('treats the umbrella runtime defaults as valid required signal coverage', () => {
    const layers = getRuntimePromptLayerDefinitions().map(definition => ({
      type: 'runtime' as const,
      identifier: definition.identifier,
      content: definition.content,
      enabled: true,
    }));

    const result = validateRuntimePromptLayerCoverage(layers);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts a single custom runtime layer when it references every required signal', () => {
    const result = validateRuntimePromptLayerCoverage([
      buildCustomRuntimeSignalLayer(),
    ]);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports missing, disabled, and empty required runtime signals distinctly', () => {
    const result = validateRuntimePromptLayerCoverage([
      buildCustomRuntimeSignalLayer([
        'runtime.last_message_received',
        'runtime.trust',
        'runtime.tooling',
      ]),
      {
        type: 'runtime',
        identifier: 'runtime.trust',
        content: REQUIRED_RUNTIME_SIGNAL_SECTIONS['runtime.trust'],
        enabled: false,
      },
      {
        type: 'runtime',
        identifier: 'runtime.tooling',
        content: '   ',
        enabled: true,
      },
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        identifier: 'runtime.last_message_received',
        name: 'Last Message Received',
        reason: 'missing',
      },
      {
        identifier: 'runtime.trust',
        name: 'Trust Guidance',
        reason: 'disabled',
      },
      {
        identifier: 'runtime.tooling',
        name: 'Tooling',
        reason: 'empty',
      },
    ]);
  });

  it('treats legacy granular runtime layers as valid coverage for customized companions', () => {
    const legacyLayers = [
      'runtime.last_message_received',
      'runtime.internal_turn_context',
      'runtime.speaking_with',
      'runtime.channel_context',
      'runtime.conversation_state',
      'runtime.model_context',
      'runtime.capability_tier',
      'runtime.trust',
      'runtime.emotional_affect',
      'runtime.metacognitive_guidance',
      'runtime.response_style_guidance',
      'runtime.internal_state',
      'runtime.tooling',
    ].map(identifier => ({
      type: 'runtime' as const,
      identifier,
      content: REQUIRED_RUNTIME_SIGNAL_SECTIONS[identifier],
      enabled: true,
    }));

    const result = validateRuntimePromptLayerCoverage(legacyLayers);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('seeds fresh companions with only the umbrella runtime layers', () => {
    const root = makeTempDir();
    const store = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const { events, logger } = createMigrationLogger();

    const summary = ensureRuntimePromptLayers(store, { logger });

    expect(store.getByType('runtime').map(layer => layer.identifier)).toEqual([
      'runtime.self',
      'runtime.attention',
      'runtime.tooling',
      'runtime.state',
    ]);
    expect(summary).toMatchObject({
      outcome: 'seeded_umbrella_defaults',
      createdUmbrellaIdentifiers: ['runtime.self', 'runtime.attention', 'runtime.tooling', 'runtime.state'],
    });
    expect(events).toEqual([
      {
        message: 'runtime_prompt_layer_migration',
        payload: expect.objectContaining({
          outcome: 'seeded_umbrella_defaults',
        }),
      },
    ]);
  });

  it('migrates untouched legacy runtime layers to the umbrella defaults', () => {
    const root = makeTempDir();
    const store = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const { events, logger } = createMigrationLogger();
    seedLegacyRuntimeLayers(store);

    const summary = ensureRuntimePromptLayers(store, { logger });
    const migratedLayers = store.getByType('runtime')
      .map(layer => layer.identifier)
      .sort();

    expect(migratedLayers).toEqual([
      'runtime.attention',
      'runtime.self',
      'runtime.state',
      'runtime.tooling',
    ]);
    expect(store.getByType('runtime').find(layer => layer.identifier === 'runtime.tooling')?.content)
      .toBe(getRuntimePromptLayerDefinition('runtime.tooling')?.content);
    expect(summary).toMatchObject({
      outcome: 'migrated_legacy_defaults',
      upgradedLegacyIdentifiers: ['runtime.tooling'],
      retainedLegacyIdentifiers: [],
      blockedUmbrellaIdentifiers: [],
    });
    expect(summary.removedLegacyIdentifiers).toContain('runtime.last_message_received');
    expect(summary.removedLegacyIdentifiers).toContain('runtime.appearance_context');
    expect(events.at(0)).toMatchObject({
      message: 'runtime_prompt_layer_migration',
      payload: expect.objectContaining({
        outcome: 'migrated_legacy_defaults',
      }),
    });
  });

  it('retains customized legacy layers while adding umbrella defaults alongside them', () => {
    const root = makeTempDir();
    const store = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const { events, logger } = createMigrationLogger();
    seedLegacyRuntimeLayers(store, {
      'runtime.trust': {
        content: '<trust>Custom legacy trust guidance.</trust>',
      },
      'runtime.open_threads': {
        content: '<open_threads>Custom legacy open threads.</open_threads>',
      },
    });

    const summary = ensureRuntimePromptLayers(store, { logger });
    const runtimeIdentifiers = store.getByType('runtime')
      .map(layer => layer.identifier)
      .sort();

    expect(runtimeIdentifiers).toContain('runtime.self');
    expect(runtimeIdentifiers).toContain('runtime.attention');
    expect(runtimeIdentifiers).toContain('runtime.trust');
    expect(runtimeIdentifiers).toContain('runtime.open_threads');
    expect(runtimeIdentifiers).not.toContain('runtime.last_message_received');
    expect(store.getByType('runtime').find(layer => layer.identifier === 'runtime.trust')?.content)
      .toBe('<trust>Custom legacy trust guidance.</trust>');
    expect(store.getByType('runtime').find(layer => layer.identifier === 'runtime.open_threads')?.content)
      .toBe('<open_threads>Custom legacy open threads.</open_threads>');
    expect(summary).toMatchObject({
      outcome: 'migrated_legacy_defaults_with_custom_retention',
      retainedCustomizedLegacyIdentifiers: ['runtime.open_threads', 'runtime.trust'],
      blockedUmbrellaIdentifiers: [],
    });
    expect(events.at(0)).toMatchObject({
      message: 'runtime_prompt_layer_migration',
      payload: expect.objectContaining({
        outcome: 'migrated_legacy_defaults_with_custom_retention',
      }),
    });
  });
});
