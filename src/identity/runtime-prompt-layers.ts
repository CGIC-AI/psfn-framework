import type { PromptLayerStore } from './prompt-store.js';

interface RuntimePromptLayerDefinition {
  identifier: string;
  name: string;
  content: string;
  priority: number;
}

const RUNTIME_PROMPT_LAYER_DEFINITIONS: readonly RuntimePromptLayerDefinition[] = [
  {
    identifier: 'runtime.current_datetime',
    name: 'Current Date & Time',
    priority: 100,
    content: '<current_datetime>\nIt is {{runtime_current_datetime_human}} {{active_timezone}}.\n</current_datetime>',
  },
  {
    identifier: 'runtime.last_message_received',
    name: 'Last Message Received',
    priority: 110,
    content: '<last_message_received>\nLast message received before this turn: {{runtime_last_message_received_human}}.\n</last_message_received>',
  },
  {
    identifier: 'runtime.internal_turn_context',
    name: 'Internal Turn Context',
    priority: 120,
    content: '<internal_turn_context>\n{{runtime_internal_turn_context}}\n</internal_turn_context>',
  },
  {
    identifier: 'runtime.speaking_with',
    name: 'Speaking With',
    priority: 130,
    content: '<speaking_with>\nSpeaking with: {{runtime_speaking_with_name}} ({{trust_level}} trust).\n</speaking_with>',
  },
  {
    identifier: 'runtime.channel_context',
    name: 'Channel Context',
    priority: 140,
    content: '<channel_context>\nChannel: {{runtime_channel_type}} ({{channel_visibility}}).\n</channel_context>',
  },
  {
    identifier: 'runtime.model_context',
    name: 'Model Context',
    priority: 150,
    content: '<model_context>\nCurrent model: {{model}}.\n</model_context>',
  },
  {
    identifier: 'runtime.capability_tier',
    name: 'Capability Tier',
    priority: 160,
    content: '<capability_tier>\nCapability tier: {{runtime_capability_tier}}.\n</capability_tier>',
  },
  {
    identifier: 'runtime.tooling',
    name: 'Tooling',
    priority: 170,
    content: '<tooling>\n{{runtime_tooling_summary}}\n</tooling>',
  },
  {
    identifier: 'runtime.trust',
    name: 'Trust Guidance',
    priority: 180,
    content: '<trust>\n{{runtime_trust_guidance}}\n</trust>',
  },
  {
    identifier: 'runtime.emotional_affect',
    name: 'Emotional Affect',
    priority: 190,
    content: '<emotional_affect>\n{{runtime_emotional_affect_body}}\n</emotional_affect>',
  },
  {
    identifier: 'runtime.metacognitive_guidance',
    name: 'Metacognitive Guidance',
    priority: 200,
    content: '<metacognitive_persona_guidance>\n{{runtime_metacognitive_persona_guidance_body}}\n</metacognitive_persona_guidance>',
  },
  {
    identifier: 'runtime.response_style_guidance',
    name: 'Response Style Guidance',
    priority: 210,
    content: '<response_style_guidance>\n{{runtime_response_style_guidance}}\n</response_style_guidance>',
  },
  {
    identifier: 'runtime.internal_state',
    name: 'Internal State',
    priority: 220,
    content: '<internal_state>\n{{runtime_internal_state_body}}\n</internal_state>',
  },
  {
    identifier: 'runtime.emotion_appraisal_chain',
    name: 'Emotion Appraisal Chain',
    priority: 230,
    content: '<emotion_appraisal_chain>\n{{runtime_emotion_appraisal_body}}\n</emotion_appraisal_chain>',
  },
  {
    identifier: 'runtime.open_threads',
    name: 'Open Threads',
    priority: 240,
    content: '<open_threads>\n{{runtime_open_threads_body}}\n</open_threads>',
  },
  {
    identifier: 'runtime.behavioral_notes',
    name: 'Behavioral Notes',
    priority: 250,
    content: '<behavioral_notes>\n{{runtime_behavioral_notes_body}}\n</behavioral_notes>',
  },
  {
    identifier: 'runtime.skills_index',
    name: 'Skills Index',
    priority: 260,
    content: '<skills_index>\n{{runtime_skills_index_body}}\n</skills_index>',
  },
  {
    identifier: 'runtime.appearance_context',
    name: 'Appearance Context',
    priority: 270,
    content: '<appearance_context>\n{{runtime_appearance_context_body}}\n</appearance_context>',
  },
  {
    identifier: 'runtime.self_image_tool_guidance',
    name: 'Self-Image Tool Guidance',
    priority: 280,
    content: '<self_image_tool_guidance>\n{{runtime_self_image_tool_guidance_body}}\n</self_image_tool_guidance>',
  },
  {
    identifier: 'runtime.extended_tools',
    name: 'Extended Tools',
    priority: 290,
    content: '<extended_tools>\n{{runtime_extended_tools_body}}\n</extended_tools>',
  },
] as const;

export function composeDefaultRuntimePromptTemplate(): string {
  return RUNTIME_PROMPT_LAYER_DEFINITIONS
    .map(definition => definition.content.trim())
    .filter(content => content.length > 0)
    .join('\n\n');
}

function findExistingRuntimeLayer(
  promptStore: PromptLayerStore,
  definition: RuntimePromptLayerDefinition,
) {
  return promptStore.getAll().find(layer => (
    layer.type === 'runtime'
    && (layer.identifier === definition.identifier || layer.name === definition.name)
  ));
}

export function ensureRuntimePromptLayers(promptStore: PromptLayerStore): void {
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
