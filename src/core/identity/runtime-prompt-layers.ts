import type { PromptLayerStatePort } from './prompt-state-port.js';
import type { PromptLayer } from './prompt-types.js';
import { createComponentLogger } from '../../shared/logger.js';
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

export type RuntimePromptLayerSchemaClassification =
  | 'required_runtime_aware'
  | 'optional_runtime_aware';

export interface RuntimePromptLayerSchema {
  classification: RuntimePromptLayerSchemaClassification;
  required: boolean;
}

export interface RuntimePromptLayerDefinition {
  identifier: string;
  name: string;
  content: string;
  priority: number;
  schema: RuntimePromptLayerSchema;
}

export type RuntimePromptMigrationOutcome =
  | 'seeded_umbrella_defaults'
  | 'migrated_legacy_defaults'
  | 'migrated_legacy_defaults_with_custom_retention'
  | 'partial_legacy_retention'
  | 'normalized_runtime_umbrellas'
  | 'no_changes';

export interface RuntimePromptLayerMigrationSummary {
  outcome: RuntimePromptMigrationOutcome;
  createdUmbrellaIdentifiers: string[];
  normalizedUmbrellaIdentifiers: string[];
  upgradedLegacyIdentifiers: string[];
  removedLegacyIdentifiers: string[];
  retainedLegacyIdentifiers: string[];
  retainedCustomizedLegacyIdentifiers: string[];
  blockedUmbrellaIdentifiers: string[];
}

export interface RequiredRuntimePromptSignalManifestEntry {
  identifier: string;
  name: string;
  classification: RuntimePromptLayerSchemaClassification;
  required: boolean;
}

interface RequiredRuntimePromptSignalDefinitionInternal extends RequiredRuntimePromptSignalManifestEntry {
  ownerLayerIdentifiers: readonly string[];
  coverageAnchors: readonly string[];
}

export interface RuntimePromptLayerCoverageIssue {
  identifier: string;
  name: string;
  reason: 'missing' | 'disabled' | 'empty';
}

export interface RuntimePromptLayerCoverageValidationResult {
  ok: boolean;
  issues: RuntimePromptLayerCoverageIssue[];
}

const REQUIRED_RUNTIME_LAYER_SCHEMA: RuntimePromptLayerSchema = Object.freeze({
  classification: 'required_runtime_aware',
  required: true,
});

const OPTIONAL_RUNTIME_LAYER_SCHEMA: RuntimePromptLayerSchema = Object.freeze({
  classification: 'optional_runtime_aware',
  required: false,
});

const log = createComponentLogger('RuntimePromptLayers');

const RUNTIME_STATE_LEGACY_IDENTIFIERS = [
  'runtime.last_message_received',
  'runtime.internal_turn_context',
  'runtime.speaking_with',
  'runtime.channel_context',
  'runtime.model_context',
  'runtime.capability_tier',
  'runtime.current_datetime',
] as const;

const RUNTIME_SELF_LEGACY_IDENTIFIERS = [
  'runtime.trust',
  'runtime.emotional_affect',
  'runtime.metacognitive_guidance',
  'runtime.response_style_guidance',
  'runtime.internal_state',
] as const;

const LEGACY_RUNTIME_LAYER_IDENTIFIERS = [
  ...RUNTIME_STATE_LEGACY_IDENTIFIERS,
  ...RUNTIME_SELF_LEGACY_IDENTIFIERS,
  'runtime.tooling',
  'runtime.emotion_appraisal_chain',
  'runtime.open_threads',
  'runtime.behavioral_notes',
  'runtime.skills_index',
  'runtime.appearance_context',
  'runtime.self_image_tool_guidance',
  'runtime.extended_tools',
] as const;

type LegacyRuntimeLayerIdentifier = typeof LEGACY_RUNTIME_LAYER_IDENTIFIERS[number];

const LEGACY_RUNTIME_LAYER_IDENTIFIER_SET = new Set<LegacyRuntimeLayerIdentifier>(LEGACY_RUNTIME_LAYER_IDENTIFIERS);

const RUNTIME_TOOLING_LEGACY_IDENTIFIERS = [
  'runtime.tooling',
  'runtime.appearance_context',
  'runtime.self_image_tool_guidance',
  'runtime.extended_tools',
] as const;

function createRequiredRuntimePromptSignalDefinition(
  identifier: string,
  name: string,
  ownerLayerIdentifiers: readonly string[],
  coverageAnchors: readonly string[],
): RequiredRuntimePromptSignalDefinitionInternal {
  return Object.freeze({
    identifier,
    name,
    classification: REQUIRED_RUNTIME_LAYER_SCHEMA.classification,
    required: true,
    ownerLayerIdentifiers: Object.freeze([identifier, ...ownerLayerIdentifiers]),
    coverageAnchors: Object.freeze([...coverageAnchors]),
  });
}

function wrapRuntimeUmbrella(tag: string, sections: readonly string[]): string {
  return `<${tag}>\n${sections.map(section => section.trim()).join('\n\n')}\n</${tag}>`;
}

const CURRENT_DATETIME_LAYER_CONTENT = '<runtime.current_datetime authority="canonical" overrides="memory,conversation_history,wake_orientation,cross_channel_continuity">\n<iso>{{runtime_current_datetime_iso}}</iso>\n<timezone>{{active_timezone}}</timezone>\n<weekday>{{runtime_current_weekday}}</weekday>\n<date>{{runtime_current_date_human}}</date>\n<time>{{runtime_current_time_human}}</time>\n<today>{{runtime_current_today}}</today>\n<yesterday>{{runtime_current_yesterday}}</yesterday>\n<tomorrow>{{runtime_current_tomorrow}}</tomorrow>\n<part_of_day>{{runtime_current_part_of_day}}</part_of_day>\n</runtime.current_datetime>';

const RUNTIME_STATE_LAYER_SECTIONS = [
  "<last_message_received>\n<weekday>{{runtime_last_message_received_weekday}}</weekday>\n<date>{{runtime_last_message_received_date_human}}</date>\n<time>{{runtime_last_message_received_time_human}}</time>\n<timezone>{{runtime_last_message_received_timezone}}</timezone>\n<elapsed_time_since_last>{{runtime_last_message_received_ago}}</elapsed_time_since_last>\n<status>{{runtime_last_message_received_missing_notice}}</status>\n</last_message_received>",
  "<internal_turn_context>\n<kind>{{runtime_internal_turn_kind}}</kind>\n</internal_turn_context>",
  "<speaking_with>\n<name>{{runtime_speaking_with_name}}</name>\n<trust_level>{{runtime_speaking_with_trust_level}}</trust_level>\n</speaking_with>",
  "<channel_context>\n<type>{{runtime_channel_type}}</type>\n<visibility>{{runtime_channel_visibility}}</visibility>\n</channel_context>",
  "<model_context>\n<identifier>{{model}}</identifier>\n</model_context>",
  "<capability_tier>\n<tier>{{runtime_capability_tier}}</tier>\n</capability_tier>",
] as const;

const LEGACY_RUNTIME_STATE_LAYER_CONTENT_WITH_CURRENT_DATETIME = wrapRuntimeUmbrella('runtime_state', [
  ...RUNTIME_STATE_LAYER_SECTIONS,
  CURRENT_DATETIME_LAYER_CONTENT,
]);

const RUNTIME_STATE_LAYER_CONTENT = wrapRuntimeUmbrella('runtime_state', RUNTIME_STATE_LAYER_SECTIONS);

const RUNTIME_SELF_LAYER_CONTENT = wrapRuntimeUmbrella('runtime_self', [
  `<trust>\n${TRUST_GUIDANCE_BODY_TEMPLATE}\n</trust>`,
  `<emotional_affect>\n${EMOTIONAL_AFFECT_BODY_TEMPLATE}\n</emotional_affect>`,
  `<metacognitive_persona_guidance>\n${METACOGNITIVE_PERSONA_GUIDANCE_BODY_TEMPLATE}\n</metacognitive_persona_guidance>`,
  `<response_style_guidance>\n${RESPONSE_STYLE_GUIDANCE_BODY_TEMPLATE}\n</response_style_guidance>`,
  `<internal_state>\n${INTERNAL_STATE_BODY_TEMPLATE}\n</internal_state>`,
]);

const RUNTIME_ATTENTION_LAYER_CONTENT = wrapRuntimeUmbrella('runtime_attention', [
  "<emotion_appraisal_chain>\n{{runtime_emotion_appraisal_body}}\n</emotion_appraisal_chain>",
  `<open_threads>\n${OPEN_THREADS_BODY_TEMPLATE}\n</open_threads>`,
  "<behavioral_notes>\n{{runtime_behavioral_notes_body}}\n</behavioral_notes>",
  "<skills_index>\n{{runtime_skills_index_body}}\n</skills_index>",
]);

const RUNTIME_TOOLING_LAYER_CONTENT = wrapRuntimeUmbrella('runtime_tooling', [
  "<tooling>\n<active_count>{{runtime_tooling_active_count}}</active_count>\n<core_count>{{runtime_tooling_core_count}}</core_count>\n<promoted_count>{{runtime_tooling_promoted_count}}</promoted_count>\n<loaded_count>{{runtime_tooling_loaded_count}}</loaded_count>\n<autoload_count>{{runtime_tooling_autoload_count}}</autoload_count>\n<deferred_count>{{runtime_tooling_deferred_count}}</deferred_count>\n<available_extended_count>{{runtime_tooling_available_extended_count}}</available_extended_count>\n</tooling>",
  `<analysis_workbench_guidance>\n${ANALYSIS_WORKBENCH_GUIDANCE_BODY_TEMPLATE}\n</analysis_workbench_guidance>`,
  "<appearance_context>\n{{runtime_appearance_context_body}}\n</appearance_context>",
  `<self_image_tool_guidance>\n${SELF_IMAGE_TOOL_GUIDANCE_BODY_TEMPLATE}\n</self_image_tool_guidance>`,
  `<extended_tools>\n${EXTENDED_TOOLS_BODY_TEMPLATE}\n</extended_tools>`,
]);

const LEGACY_RUNTIME_PROMPT_LAYER_DEFINITIONS = [
  {
    identifier: 'runtime.last_message_received',
    name: 'Last Message Received',
    priority: 100,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<last_message_received>\n<weekday>{{runtime_last_message_received_weekday}}</weekday>\n<date>{{runtime_last_message_received_date_human}}</date>\n<time>{{runtime_last_message_received_time_human}}</time>\n<timezone>{{runtime_last_message_received_timezone}}</timezone>\n<elapsed_time_since_last>{{runtime_last_message_received_ago}}</elapsed_time_since_last>\n<status>{{runtime_last_message_received_missing_notice}}</status>\n</last_message_received>",
  },
  {
    identifier: 'runtime.internal_turn_context',
    name: 'Internal Turn Context',
    priority: 110,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<internal_turn_context>\n<kind>{{runtime_internal_turn_kind}}</kind>\n</internal_turn_context>",
  },
  {
    identifier: 'runtime.speaking_with',
    name: 'Speaking With',
    priority: 120,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<speaking_with>\n<name>{{runtime_speaking_with_name}}</name>\n<trust_level>{{runtime_speaking_with_trust_level}}</trust_level>\n</speaking_with>",
  },
  {
    identifier: 'runtime.channel_context',
    name: 'Channel Context',
    priority: 130,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<channel_context>\n<type>{{runtime_channel_type}}</type>\n<visibility>{{runtime_channel_visibility}}</visibility>\n</channel_context>",
  },
  {
    identifier: 'runtime.model_context',
    name: 'Model Context',
    priority: 140,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<model_context>\n<identifier>{{model}}</identifier>\n</model_context>",
  },
  {
    identifier: 'runtime.capability_tier',
    name: 'Capability Tier',
    priority: 150,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<capability_tier>\n<tier>{{runtime_capability_tier}}</tier>\n</capability_tier>",
  },
  {
    identifier: 'runtime.tooling',
    name: 'Tooling',
    priority: 160,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: `<tooling>\n<active_count>{{runtime_tooling_active_count}}</active_count>\n<core_count>{{runtime_tooling_core_count}}</core_count>\n<promoted_count>{{runtime_tooling_promoted_count}}</promoted_count>\n<loaded_count>{{runtime_tooling_loaded_count}}</loaded_count>\n<autoload_count>{{runtime_tooling_autoload_count}}</autoload_count>\n<deferred_count>{{runtime_tooling_deferred_count}}</deferred_count>\n<available_extended_count>{{runtime_tooling_available_extended_count}}</available_extended_count>\n</tooling>\n<analysis_workbench_guidance>\n${ANALYSIS_WORKBENCH_GUIDANCE_BODY_TEMPLATE}\n</analysis_workbench_guidance>`,
  },
  {
    identifier: 'runtime.trust',
    name: 'Trust Guidance',
    priority: 170,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: `<trust>\n${TRUST_GUIDANCE_BODY_TEMPLATE}\n</trust>`,
  },
  {
    identifier: 'runtime.emotional_affect',
    name: 'Emotional Affect',
    priority: 180,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: `<emotional_affect>\n${EMOTIONAL_AFFECT_BODY_TEMPLATE}\n</emotional_affect>`,
  },
  {
    identifier: 'runtime.metacognitive_guidance',
    name: 'Metacognitive Guidance',
    priority: 190,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: `<metacognitive_persona_guidance>\n${METACOGNITIVE_PERSONA_GUIDANCE_BODY_TEMPLATE}\n</metacognitive_persona_guidance>`,
  },
  {
    identifier: 'runtime.response_style_guidance',
    name: 'Response Style Guidance',
    priority: 200,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: `<response_style_guidance>\n${RESPONSE_STYLE_GUIDANCE_BODY_TEMPLATE}\n</response_style_guidance>`,
  },
  {
    identifier: 'runtime.internal_state',
    name: 'Internal State',
    priority: 210,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: `<internal_state>\n${INTERNAL_STATE_BODY_TEMPLATE}\n</internal_state>`,
  },
  {
    identifier: 'runtime.emotion_appraisal_chain',
    name: 'Emotion Appraisal Chain',
    priority: 220,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<emotion_appraisal_chain>\n{{runtime_emotion_appraisal_body}}\n</emotion_appraisal_chain>",
  },
  {
    identifier: 'runtime.open_threads',
    name: 'Open Threads',
    priority: 230,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: `<open_threads>\n${OPEN_THREADS_BODY_TEMPLATE}\n</open_threads>`,
  },
  {
    identifier: 'runtime.behavioral_notes',
    name: 'Behavioral Notes',
    priority: 240,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<behavioral_notes>\n{{runtime_behavioral_notes_body}}\n</behavioral_notes>",
  },
  {
    identifier: 'runtime.skills_index',
    name: 'Skills Index',
    priority: 250,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<skills_index>\n{{runtime_skills_index_body}}\n</skills_index>",
  },
  {
    identifier: 'runtime.appearance_context',
    name: 'Appearance Context',
    priority: 260,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<appearance_context>\n{{runtime_appearance_context_body}}\n</appearance_context>",
  },
  {
    identifier: 'runtime.self_image_tool_guidance',
    name: 'Self-Image Tool Guidance',
    priority: 270,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: `<self_image_tool_guidance>\n${SELF_IMAGE_TOOL_GUIDANCE_BODY_TEMPLATE}\n</self_image_tool_guidance>`,
  },
  {
    identifier: 'runtime.extended_tools',
    name: 'Extended Tools',
    priority: 280,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: `<extended_tools>\n${EXTENDED_TOOLS_BODY_TEMPLATE}\n</extended_tools>`,
  },
  {
    identifier: 'runtime.current_datetime',
    name: 'Current Date & Time',
    priority: 290,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: CURRENT_DATETIME_LAYER_CONTENT,
  },
] as const satisfies readonly RuntimePromptLayerDefinition[];

const LEGACY_RUNTIME_PROMPT_LAYER_DEFINITION_MAP = new Map(
  LEGACY_RUNTIME_PROMPT_LAYER_DEFINITIONS.map(definition => [definition.identifier, definition]),
);

const REQUIRED_RUNTIME_PROMPT_SIGNAL_DEFINITIONS: readonly RequiredRuntimePromptSignalDefinitionInternal[] = [
  createRequiredRuntimePromptSignalDefinition(
    'runtime.last_message_received',
    'Last Message Received',
    ['runtime.state'],
    ['<last_message_received>', '{{runtime_last_message_received_'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.internal_turn_context',
    'Internal Turn Context',
    ['runtime.state'],
    ['<internal_turn_context>', '{{runtime_internal_turn_kind}}'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.speaking_with',
    'Speaking With',
    ['runtime.state'],
    ['<speaking_with>', '{{runtime_speaking_with_'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.channel_context',
    'Channel Context',
    ['runtime.state'],
    ['<channel_context>', '{{runtime_channel_'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.model_context',
    'Model Context',
    ['runtime.state'],
    ['<model_context>', '{{model}}'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.capability_tier',
    'Capability Tier',
    ['runtime.state'],
    ['<capability_tier>', '{{runtime_capability_tier}}'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.trust',
    'Trust Guidance',
    ['runtime.self'],
    ['<trust>', '{{runtime_trust_'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.emotional_affect',
    'Emotional Affect',
    ['runtime.self'],
    ['<emotional_affect>', '{{runtime_affect_'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.metacognitive_guidance',
    'Metacognitive Guidance',
    ['runtime.self'],
    ['<metacognitive_persona_guidance>', '{{runtime_flag_'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.response_style_guidance',
    'Response Style Guidance',
    ['runtime.self'],
    ['<response_style_guidance>', '{{runtime_response_style'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.internal_state',
    'Internal State',
    ['runtime.self'],
    ['<internal_state>', '{{runtime_internal_state_'],
  ),
  createRequiredRuntimePromptSignalDefinition(
    'runtime.tooling',
    'Tooling',
    [],
    ['<tooling>', '{{runtime_tooling_'],
  ),
] as const;

// Ordered most-stable-first for prompt prefix caching: provider caches die at
// the first changed byte, so per-turn volatile content (timestamps, elapsed
// time) must render LAST. Live churn evidence (2026-06-09, consecutive turns):
// runtime_self changed 1 line, runtime_attention/tooling change on appraisal
// and tool activity, runtime_state changes every turn by definition.
const RUNTIME_PROMPT_LAYER_DEFINITIONS: readonly RuntimePromptLayerDefinition[] = [
  {
    identifier: 'runtime.self',
    name: 'Runtime Self',
    priority: 100,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_SELF_LAYER_CONTENT,
  },
  {
    identifier: 'runtime.attention',
    name: 'Runtime Attention',
    priority: 110,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_ATTENTION_LAYER_CONTENT,
  },
  {
    identifier: 'runtime.tooling',
    name: 'Tooling',
    priority: 120,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_TOOLING_LAYER_CONTENT,
  },
  {
    identifier: 'runtime.state',
    name: 'Runtime State',
    priority: 130,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_STATE_LAYER_CONTENT,
  },
] as const;

const RUNTIME_PROMPT_LAYER_DEFINITION_MAP = new Map(
  RUNTIME_PROMPT_LAYER_DEFINITIONS.map(definition => [definition.identifier, definition]),
);

export function getRuntimePromptLayerDefinitions(): RuntimePromptLayerDefinition[] {
  return RUNTIME_PROMPT_LAYER_DEFINITIONS.map(definition => ({
    identifier: definition.identifier,
    name: definition.name,
    content: definition.content,
    priority: definition.priority,
    schema: { ...definition.schema },
  }));
}

export function getRuntimePromptLayerDefinition(identifier: string): RuntimePromptLayerDefinition | null {
  const definition = RUNTIME_PROMPT_LAYER_DEFINITION_MAP.get(identifier);
  return definition ? {
    identifier: definition.identifier,
    name: definition.name,
    content: definition.content,
    priority: definition.priority,
    schema: { ...definition.schema },
  } : null;
}

export function getRequiredRuntimePromptSignalManifest(): RequiredRuntimePromptSignalManifestEntry[] {
  return REQUIRED_RUNTIME_PROMPT_SIGNAL_DEFINITIONS.map(signal => ({
    identifier: signal.identifier,
    name: signal.name,
    classification: signal.classification,
    required: signal.required,
  }));
}

export function isRequiredRuntimePromptLayer(identifier: string): boolean {
  return RUNTIME_PROMPT_LAYER_DEFINITION_MAP.get(identifier)?.schema.required ?? false;
}

export function validateRuntimePromptLayerCoverage(
  layers: readonly Pick<PromptLayer, 'type' | 'identifier' | 'content' | 'enabled'>[],
): RuntimePromptLayerCoverageValidationResult {
  const runtimeLayers = layers.filter(layer => layer.type === 'runtime');
  const issues: RuntimePromptLayerCoverageIssue[] = [];

  for (const signal of REQUIRED_RUNTIME_PROMPT_SIGNAL_DEFINITIONS) {
    const issue = resolveRuntimeSignalCoverageIssue(runtimeLayers, signal);
    if (issue !== null) {
      issues.push({
        identifier: signal.identifier,
        name: signal.name,
        reason: issue,
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function composeDefaultRuntimePromptTemplate(): string {
  return RUNTIME_PROMPT_LAYER_DEFINITIONS
    .map(definition => definition.content.trim())
    .filter(content => content.length > 0)
    .join('\n\n');
}

function findExistingRuntimeLayer(
  promptStore: PromptLayerStatePort,
  definition: RuntimePromptLayerDefinition,
) {
  return promptStore.getAll().find(layer => (
    layer.type === 'runtime'
    && (layer.identifier === definition.identifier || layer.name === definition.name)
  ));
}

function isLegacyRuntimeLayerIdentifier(identifier: string | undefined): identifier is LegacyRuntimeLayerIdentifier {
  return typeof identifier === 'string'
    && LEGACY_RUNTIME_LAYER_IDENTIFIER_SET.has(identifier as LegacyRuntimeLayerIdentifier);
}

function isCurrentToolingUmbrellaLayer(layer: Pick<PromptLayer, 'identifier' | 'content'>): boolean {
  return layer.identifier === 'runtime.tooling' && layer.content.includes('<runtime_tooling>');
}

function isLegacyLayerDefault(layer: Pick<PromptLayer, 'identifier' | 'name' | 'content' | 'enabled' | 'role' | 'promptOrder' | 'priority'>): boolean {
  if (!isLegacyRuntimeLayerIdentifier(layer.identifier)) {
    return false;
  }
  if (isCurrentToolingUmbrellaLayer(layer)) {
    return false;
  }
  const definition = LEGACY_RUNTIME_PROMPT_LAYER_DEFINITION_MAP.get(layer.identifier);
  if (!definition) {
    return false;
  }
  return (
    layer.name === definition.name
    && layer.content === definition.content
    && layer.enabled === true
    && layer.role === 'system'
    && layer.promptOrder === definition.priority
    && layer.priority === definition.priority
  );
}

function normalizeRuntimeLayerMetadata(
  promptStore: PromptLayerStatePort,
  layer: PromptLayer,
  definition: RuntimePromptLayerDefinition,
): boolean {
  const shouldUpgradeContent = definition.identifier === 'runtime.state'
    && layer.content === LEGACY_RUNTIME_STATE_LAYER_CONTENT_WITH_CURRENT_DATETIME;
  const metadataPatch = {
    ...(layer.identifier !== definition.identifier ? { identifier: definition.identifier } : {}),
    ...(layer.role !== 'system' ? { role: 'system' as const } : {}),
    ...(layer.promptOrder !== definition.priority ? { promptOrder: definition.priority } : {}),
  };
  const needsPriority = layer.priority !== definition.priority;
  if (Object.keys(metadataPatch).length === 0 && !needsPriority && !shouldUpgradeContent) {
    return false;
  }
  promptStore.update(layer.id, {
    ...(shouldUpgradeContent ? { content: definition.content } : {}),
    ...(needsPriority ? { priority: definition.priority } : {}),
    ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
  }, 'system:runtime-layer-seed', `Normalize seeded runtime prompt layer ${definition.identifier}`);
  return true;
}

function createRuntimeUmbrellaLayer(
  promptStore: PromptLayerStatePort,
  definition: RuntimePromptLayerDefinition,
): void {
  promptStore.create({
    type: 'runtime',
    name: definition.name,
    identifier: definition.identifier,
    role: 'system',
    promptOrder: definition.priority,
    content: definition.content,
    priority: definition.priority,
    updatedBy: 'system',
  });
}

function determineRuntimePromptMigrationOutcome(summary: Omit<RuntimePromptLayerMigrationSummary, 'outcome'>): RuntimePromptMigrationOutcome {
  if (summary.blockedUmbrellaIdentifiers.length > 0) {
    return 'partial_legacy_retention';
  }
  if (
    summary.removedLegacyIdentifiers.length > 0
    && summary.retainedCustomizedLegacyIdentifiers.length > 0
  ) {
    return 'migrated_legacy_defaults_with_custom_retention';
  }
  if (
    summary.removedLegacyIdentifiers.length > 0
    || summary.upgradedLegacyIdentifiers.length > 0
  ) {
    return 'migrated_legacy_defaults';
  }
  if (summary.createdUmbrellaIdentifiers.length > 0) {
    return 'seeded_umbrella_defaults';
  }
  if (summary.normalizedUmbrellaIdentifiers.length > 0) {
    return 'normalized_runtime_umbrellas';
  }
  return 'no_changes';
}

export function ensureRuntimePromptLayers(
  promptStore: PromptLayerStatePort,
  options: { logger?: Pick<typeof log, 'info'> } = {},
): RuntimePromptLayerMigrationSummary {
  const logger = options.logger ?? log;
  const createdUmbrellaIdentifiers: string[] = [];
  const normalizedUmbrellaIdentifiers: string[] = [];
  const upgradedLegacyIdentifiers: string[] = [];
  const removedLegacyIdentifiers: string[] = [];
  const retainedLegacyIdentifiers = new Set<string>();
  const retainedCustomizedLegacyIdentifiers = new Set<string>();
  const blockedUmbrellaIdentifiers = new Set<string>();

  const createOrNormalizeUmbrella = (
    definition: RuntimePromptLayerDefinition,
  ): void => {
    const existing = findExistingRuntimeLayer(promptStore, definition);
    if (existing) {
      if (normalizeRuntimeLayerMetadata(promptStore, existing, definition)) {
        normalizedUmbrellaIdentifiers.push(definition.identifier);
      }
      return;
    }

    createRuntimeUmbrellaLayer(promptStore, definition);
    createdUmbrellaIdentifiers.push(definition.identifier);
  };

  for (const identifier of ['runtime.self', 'runtime.attention'] as const) {
    const definition = getRuntimePromptLayerDefinition(identifier);
    if (definition) {
      createOrNormalizeUmbrella(definition);
    }
  }

  const toolingDefinition = getRuntimePromptLayerDefinition('runtime.tooling');
  if (toolingDefinition) {
    const existingTooling = findExistingRuntimeLayer(promptStore, toolingDefinition);
    if (!existingTooling) {
      createRuntimeUmbrellaLayer(promptStore, toolingDefinition);
      createdUmbrellaIdentifiers.push(toolingDefinition.identifier);
    } else if (isLegacyLayerDefault(existingTooling)) {
      promptStore.update(existingTooling.id, {
        content: toolingDefinition.content,
        ...(existingTooling.priority !== toolingDefinition.priority ? { priority: toolingDefinition.priority } : {}),
        metadata: {
          ...(existingTooling.identifier !== toolingDefinition.identifier ? { identifier: toolingDefinition.identifier } : {}),
          ...(existingTooling.role !== 'system' ? { role: 'system' as const } : {}),
          ...(existingTooling.promptOrder !== toolingDefinition.priority ? { promptOrder: toolingDefinition.priority } : {}),
        },
      }, 'system:runtime-layer-seed', 'Upgrade legacy tooling runtime layer to umbrella default');
      upgradedLegacyIdentifiers.push(toolingDefinition.identifier);
    } else {
      if (normalizeRuntimeLayerMetadata(promptStore, existingTooling, toolingDefinition)) {
        normalizedUmbrellaIdentifiers.push(toolingDefinition.identifier);
      }
      if (!isCurrentToolingUmbrellaLayer(existingTooling) && existingTooling.content !== toolingDefinition.content) {
        retainedLegacyIdentifiers.add(existingTooling.identifier ?? toolingDefinition.identifier);
        if (isLegacyRuntimeLayerIdentifier(existingTooling.identifier)) {
          retainedCustomizedLegacyIdentifiers.add(existingTooling.identifier);
          blockedUmbrellaIdentifiers.add(toolingDefinition.identifier);
        }
      }
    }
  }

  // runtime.state seeds last to match its cache-aware priority: it carries
  // per-turn timestamps that must render after the stable umbrellas.
  const stateDefinition = getRuntimePromptLayerDefinition('runtime.state');
  if (stateDefinition) {
    createOrNormalizeUmbrella(stateDefinition);
  }

  const runtimeLayers = promptStore.getAll().filter(layer => layer.type === 'runtime');
  for (const layer of runtimeLayers) {
    if (!isLegacyRuntimeLayerIdentifier(layer.identifier) || isCurrentToolingUmbrellaLayer(layer)) {
      continue;
    }

    if (isLegacyLayerDefault(layer)) {
      const toolingBlocked = blockedUmbrellaIdentifiers.has('runtime.tooling')
        && RUNTIME_TOOLING_LEGACY_IDENTIFIERS.includes(layer.identifier as typeof RUNTIME_TOOLING_LEGACY_IDENTIFIERS[number]);
      if (!toolingBlocked) {
        promptStore.delete(layer.id);
        removedLegacyIdentifiers.push(layer.identifier);
        continue;
      }
    }

    retainedLegacyIdentifiers.add(layer.identifier);
    if (!isLegacyLayerDefault(layer)) {
      retainedCustomizedLegacyIdentifiers.add(layer.identifier);
    }
  }

  const summaryBase = {
    createdUmbrellaIdentifiers,
    normalizedUmbrellaIdentifiers,
    upgradedLegacyIdentifiers,
    removedLegacyIdentifiers,
    retainedLegacyIdentifiers: [...retainedLegacyIdentifiers].sort(),
    retainedCustomizedLegacyIdentifiers: [...retainedCustomizedLegacyIdentifiers].sort(),
    blockedUmbrellaIdentifiers: [...blockedUmbrellaIdentifiers].sort(),
  };
  const summary: RuntimePromptLayerMigrationSummary = {
    outcome: determineRuntimePromptMigrationOutcome(summaryBase),
    ...summaryBase,
  };

  logger.info('runtime_prompt_layer_migration', summary);
  return summary;
}

function resolveRuntimeSignalCoverageIssue(
  runtimeLayers: readonly Pick<PromptLayer, 'identifier' | 'content' | 'enabled'>[],
  signal: RequiredRuntimePromptSignalDefinitionInternal,
): RuntimePromptLayerCoverageIssue['reason'] | null {
  const candidates = runtimeLayers.filter(layer => (
    (layer.identifier !== undefined && signal.ownerLayerIdentifiers.includes(layer.identifier))
    || layerReferencesRequiredRuntimeSignal(layer.content, signal)
  ));
  if (candidates.length === 0) {
    return 'missing';
  }

  const enabledCandidates = candidates.filter(layer => layer.enabled);
  if (enabledCandidates.length === 0) {
    return 'disabled';
  }

  return enabledCandidates.some(layer => layerReferencesRequiredRuntimeSignal(layer.content, signal))
    ? null
    : 'empty';
}

function layerReferencesRequiredRuntimeSignal(
  content: string,
  signal: RequiredRuntimePromptSignalDefinitionInternal,
): boolean {
  return signal.coverageAnchors.some(anchor => content.includes(anchor));
}
