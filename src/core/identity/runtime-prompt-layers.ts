import type { PromptLayerStatePort } from './prompt-state-port.js';
import type { PromptLayer } from './prompt-types.js';
import { EMOTIONAL_AFFECT_BODY_TEMPLATE } from '../emotion/persona-adaptation.js';
import { OPEN_THREADS_BODY_TEMPLATE } from '../intention/concerns.js';
import { METACOGNITIVE_PERSONA_GUIDANCE_BODY_TEMPLATE } from '../self-model/metacognition.js';
import {
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

interface RuntimePromptLayerDefinitionInternal extends RuntimePromptLayerDefinition {
  legacyCoverageIdentifiers?: readonly string[];
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
  'runtime.emotion_appraisal_chain',
  'runtime.open_threads',
  'runtime.behavioral_notes',
  'runtime.skills_index',
  'runtime.appearance_context',
  'runtime.self_image_tool_guidance',
  'runtime.extended_tools',
] as const;

const LEGACY_RUNTIME_LAYER_IDENTIFIER_SET = new Set<string>(LEGACY_RUNTIME_LAYER_IDENTIFIERS);

function wrapRuntimeUmbrella(tag: string, sections: readonly string[]): string {
  return `<${tag}>\n${sections.map(section => section.trim()).join('\n\n')}\n</${tag}>`;
}

const RUNTIME_STATE_LAYER_CONTENT = wrapRuntimeUmbrella('runtime_state', [
  "<last_message_received>\n<weekday>{{runtime_last_message_received_weekday}}</weekday>\n<date>{{runtime_last_message_received_date_human}}</date>\n<time>{{runtime_last_message_received_time_human}}</time>\n<timezone>{{runtime_last_message_received_timezone}}</timezone>\n<elapsed_time_since_last>{{runtime_last_message_received_ago}}</elapsed_time_since_last>\n<status>{{runtime_last_message_received_missing_notice}}</status>\n</last_message_received>",
  "<internal_turn_context>\n<kind>{{runtime_internal_turn_kind}}</kind>\n</internal_turn_context>",
  "<speaking_with>\n<name>{{runtime_speaking_with_name}}</name>\n<trust_level>{{runtime_speaking_with_trust_level}}</trust_level>\n</speaking_with>",
  "<channel_context>\n<type>{{runtime_channel_type}}</type>\n<visibility>{{runtime_channel_visibility}}</visibility>\n</channel_context>",
  "<model_context>\n<identifier>{{model}}</identifier>\n</model_context>",
  "<capability_tier>\n<tier>{{runtime_capability_tier}}</tier>\n</capability_tier>",
  "<current_datetime>\n<weekday>{{runtime_current_weekday}}</weekday>\n<date>{{runtime_current_date_human}}</date>\n<time>{{runtime_current_time_human}}</time>\n<timezone>{{active_timezone}}</timezone>\n</current_datetime>",
]);

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
  "<appearance_context>\n{{runtime_appearance_context_body}}\n</appearance_context>",
  `<self_image_tool_guidance>\n${SELF_IMAGE_TOOL_GUIDANCE_BODY_TEMPLATE}\n</self_image_tool_guidance>`,
  `<extended_tools>\n${EXTENDED_TOOLS_BODY_TEMPLATE}\n</extended_tools>`,
]);

const RUNTIME_PROMPT_LAYER_DEFINITIONS: readonly RuntimePromptLayerDefinitionInternal[] = [
  {
    identifier: 'runtime.state',
    name: 'Runtime State',
    priority: 100,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_STATE_LAYER_CONTENT,
    legacyCoverageIdentifiers: RUNTIME_STATE_LEGACY_IDENTIFIERS,
  },
  {
    identifier: 'runtime.self',
    name: 'Runtime Self',
    priority: 110,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_SELF_LAYER_CONTENT,
    legacyCoverageIdentifiers: RUNTIME_SELF_LEGACY_IDENTIFIERS,
  },
  {
    identifier: 'runtime.attention',
    name: 'Runtime Attention',
    priority: 120,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_ATTENTION_LAYER_CONTENT,
  },
  {
    identifier: 'runtime.tooling',
    name: 'Tooling',
    priority: 130,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: RUNTIME_TOOLING_LAYER_CONTENT,
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

export function isRequiredRuntimePromptLayer(identifier: string): boolean {
  return RUNTIME_PROMPT_LAYER_DEFINITION_MAP.get(identifier)?.schema.required ?? false;
}

export function validateRuntimePromptLayerCoverage(
  layers: readonly Pick<PromptLayer, 'type' | 'identifier' | 'content' | 'enabled'>[],
): RuntimePromptLayerCoverageValidationResult {
  const runtimeLayers = layers.filter(layer => layer.type === 'runtime');
  const issues: RuntimePromptLayerCoverageIssue[] = [];

  for (const definition of RUNTIME_PROMPT_LAYER_DEFINITIONS) {
    if (!definition.schema.required) continue;

    const issue = resolveRuntimeLayerCoverageIssue(runtimeLayers, definition);
    if (issue) {
      issues.push({
        identifier: definition.identifier,
        name: definition.name,
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

export function ensureRuntimePromptLayers(promptStore: PromptLayerStatePort): void {
  const runtimeLayers = promptStore.getAll().filter(layer => layer.type === 'runtime');
  const preserveLegacyCompanion = runtimeLayers.some(layer => (
    typeof layer.identifier === 'string'
    && LEGACY_RUNTIME_LAYER_IDENTIFIER_SET.has(layer.identifier)
  ));

  for (const definition of RUNTIME_PROMPT_LAYER_DEFINITIONS) {
    const existing = findExistingRuntimeLayer(promptStore, definition);
    if (existing) {
      const metadataPatch = {
        ...(existing.identifier !== definition.identifier ? { identifier: definition.identifier } : {}),
        ...(existing.role !== 'system' ? { role: 'system' as const } : {}),
        ...(existing.promptOrder !== definition.priority ? { promptOrder: definition.priority } : {}),
      };
      const needsPriority = existing.priority !== definition.priority;
      if (Object.keys(metadataPatch).length > 0 || needsPriority) {
        promptStore.update(existing.id, {
          ...(needsPriority ? { priority: definition.priority } : {}),
          ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
        }, 'system:runtime-layer-seed', `Normalize seeded runtime prompt layer ${definition.identifier}`);
      }
      continue;
    }

    if (preserveLegacyCompanion) {
      continue;
    }

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
}

function resolveRuntimeLayerCoverageIssue(
  runtimeLayers: readonly Pick<PromptLayer, 'identifier' | 'content' | 'enabled'>[],
  definition: RuntimePromptLayerDefinitionInternal,
): RuntimePromptLayerCoverageIssue['reason'] | null {
  const exactCoverageIssue = evaluateCoverageIdentifiers(runtimeLayers, [definition.identifier]);
  if (exactCoverageIssue === null) {
    return null;
  }

  if (definition.legacyCoverageIdentifiers) {
    const legacyCoverageIssue = evaluateCoverageIdentifiers(runtimeLayers, definition.legacyCoverageIdentifiers);
    if (legacyCoverageIssue === null) {
      return null;
    }

    if (exactCoverageIssue === 'empty' || legacyCoverageIssue === 'empty') {
      return 'empty';
    }
    if (exactCoverageIssue === 'disabled' || legacyCoverageIssue === 'disabled') {
      return 'disabled';
    }
  }

  return exactCoverageIssue;
}

function evaluateCoverageIdentifiers(
  runtimeLayers: readonly Pick<PromptLayer, 'identifier' | 'content' | 'enabled'>[],
  identifiers: readonly string[],
): RuntimePromptLayerCoverageIssue['reason'] | null {
  for (const identifier of identifiers) {
    const matches = runtimeLayers.filter(layer => layer.identifier === identifier);
    if (matches.length === 0) {
      return 'missing';
    }

    if (!matches.some(layer => layer.enabled)) {
      return 'disabled';
    }

    if (!matches.some(layer => layer.enabled && layer.content.trim().length > 0)) {
      return 'empty';
    }
  }

  return null;
}
