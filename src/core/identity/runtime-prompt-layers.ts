import type { PromptLayerStatePort } from './prompt-state-port.js';

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

const REQUIRED_RUNTIME_LAYER_SCHEMA: RuntimePromptLayerSchema = Object.freeze({
  classification: 'required_runtime_aware',
  required: true,
});

const OPTIONAL_RUNTIME_LAYER_SCHEMA: RuntimePromptLayerSchema = Object.freeze({
  classification: 'optional_runtime_aware',
  required: false,
});

export const RUNTIME_PROMPT_LAYER_DEFINITIONS: readonly RuntimePromptLayerDefinition[] = [
  {
    identifier: "runtime.current_datetime",
    name: "Current Date & Time",
    priority: 100,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<current_datetime>\nIt is {{runtime_current_weekday}}, {{runtime_current_date_human}} at {{runtime_current_time_human}} in {{active_timezone}}.\n</current_datetime>",
  },
  {
    identifier: "runtime.last_message_received",
    name: "Last Message Received",
    priority: 110,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<last_message_received>\nLast message received before this turn: {{runtime_last_message_received_human}}.\n</last_message_received>",
  },
  {
    identifier: "runtime.internal_turn_context",
    name: "Internal Turn Context",
    priority: 120,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<internal_turn_context>\n{{runtime_internal_turn_context}}\n</internal_turn_context>",
  },
  {
    identifier: "runtime.speaking_with",
    name: "Speaking With",
    priority: 130,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<speaking_with>\nSpeaking with: {{runtime_speaking_with_name}} ({{trust_level}} trust).\n</speaking_with>",
  },
  {
    identifier: "runtime.channel_context",
    name: "Channel Context",
    priority: 140,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<channel_context>\nChannel: {{runtime_channel_type}} ({{channel_visibility}}).\n</channel_context>",
  },
  {
    identifier: "runtime.model_context",
    name: "Model Context",
    priority: 150,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<model_context>\nCurrent model: {{model}}.\n</model_context>",
  },
  {
    identifier: "runtime.capability_tier",
    name: "Capability Tier",
    priority: 160,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<capability_tier>\nCapability tier: {{runtime_capability_tier}}.\n</capability_tier>",
  },
  {
    identifier: "runtime.tooling",
    name: "Tooling",
    priority: 170,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<tooling>\n{{runtime_tooling_summary}}\n</tooling>",
  },
  {
    identifier: "runtime.trust",
    name: "Trust Guidance",
    priority: 180,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<trust>\n{{runtime_trust_guidance}}\n</trust>",
  },
  {
    identifier: "runtime.emotional_affect",
    name: "Emotional Affect",
    priority: 190,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<emotional_affect>\n{{runtime_emotional_affect_body}}\n</emotional_affect>",
  },
  {
    identifier: "runtime.metacognitive_guidance",
    name: "Metacognitive Guidance",
    priority: 200,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<metacognitive_persona_guidance>\n{{runtime_metacognitive_persona_guidance_body}}\n</metacognitive_persona_guidance>",
  },
  {
    identifier: "runtime.response_style_guidance",
    name: "Response Style Guidance",
    priority: 210,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<response_style_guidance>\nResponse style for this turn: {{runtime_response_style_name}}.\n{{runtime_response_style_guidance_body}}\n</response_style_guidance>",
  },
  {
    identifier: "runtime.internal_state",
    name: "Internal State",
    priority: 220,
    schema: REQUIRED_RUNTIME_LAYER_SCHEMA,
    content: "<internal_state>\n{{runtime_internal_state_body}}\n</internal_state>",
  },
  {
    identifier: "runtime.emotion_appraisal_chain",
    name: "Emotion Appraisal Chain",
    priority: 230,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<emotion_appraisal_chain>\n{{runtime_emotion_appraisal_body}}\n</emotion_appraisal_chain>",
  },
  {
    identifier: "runtime.open_threads",
    name: "Open Threads",
    priority: 240,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<open_threads>\n{{runtime_open_threads_body}}\n</open_threads>",
  },
  {
    identifier: "runtime.behavioral_notes",
    name: "Behavioral Notes",
    priority: 250,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<behavioral_notes>\n{{runtime_behavioral_notes_body}}\n</behavioral_notes>",
  },
  {
    identifier: "runtime.skills_index",
    name: "Skills Index",
    priority: 260,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<skills_index>\n{{runtime_skills_index_body}}\n</skills_index>",
  },
  {
    identifier: "runtime.appearance_context",
    name: "Appearance Context",
    priority: 270,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<appearance_context>\n{{runtime_appearance_context_body}}\n</appearance_context>",
  },
  {
    identifier: "runtime.self_image_tool_guidance",
    name: "Self-Image Tool Guidance",
    priority: 280,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<self_image_tool_guidance>\n{{runtime_self_image_tool_guidance_body}}\n</self_image_tool_guidance>",
  },
  {
    identifier: "runtime.extended_tools",
    name: "Extended Tools",
    priority: 290,
    schema: OPTIONAL_RUNTIME_LAYER_SCHEMA,
    content: "<extended_tools>\n{{runtime_extended_tools_body}}\n</extended_tools>",
  },
] as const;

const RUNTIME_PROMPT_LAYER_DEFINITION_MAP = new Map(
  RUNTIME_PROMPT_LAYER_DEFINITIONS.map(definition => [definition.identifier, definition]),
);

export function getRuntimePromptLayerDefinitions(): RuntimePromptLayerDefinition[] {
  return RUNTIME_PROMPT_LAYER_DEFINITIONS.map(definition => ({
    ...definition,
    schema: { ...definition.schema },
  }));
}

export function getRuntimePromptLayerDefinition(identifier: string): RuntimePromptLayerDefinition | null {
  const definition = RUNTIME_PROMPT_LAYER_DEFINITION_MAP.get(identifier);
  return definition ? { ...definition, schema: { ...definition.schema } } : null;
}

export function isRequiredRuntimePromptLayer(identifier: string): boolean {
  return RUNTIME_PROMPT_LAYER_DEFINITION_MAP.get(identifier)?.schema.required ?? false;
}

export interface RuntimePromptLayerCoverageIssue {
  identifier: string;
  name: string;
  reason: 'missing' | 'disabled' | 'empty';
}

export interface RuntimePromptLayerCoverageResult {
  ok: boolean;
  issues: RuntimePromptLayerCoverageIssue[];
}

export function validateRuntimePromptLayerCoverage(
  layers: readonly Array<{
    type: string;
    identifier?: string | null;
    content: string;
    enabled: boolean;
  }>,
): RuntimePromptLayerCoverageResult {
  const issues: RuntimePromptLayerCoverageIssue[] = [];

  for (const definition of RUNTIME_PROMPT_LAYER_DEFINITIONS) {
    if (!definition.schema.required) {
      continue;
    }

    const existing = layers.find(layer => (
      layer.type === 'runtime'
      && layer.identifier === definition.identifier
    ));

    if (!existing) {
      issues.push({
        identifier: definition.identifier,
        name: definition.name,
        reason: 'missing',
      });
      continue;
    }

    if (!existing.enabled) {
      issues.push({
        identifier: definition.identifier,
        name: definition.name,
        reason: 'disabled',
      });
      continue;
    }

    if (existing.content.trim().length === 0) {
      issues.push({
        identifier: definition.identifier,
        name: definition.name,
        reason: 'empty',
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
