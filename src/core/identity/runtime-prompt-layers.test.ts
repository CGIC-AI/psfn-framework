import { describe, expect, it } from 'vitest';
import { injectPromptRuntimeTokens } from './prompt-runtime.js';
import {
  getRuntimePromptLayerDefinition,
  getRuntimePromptLayerDefinitions,
  isRequiredRuntimePromptLayer,
} from './runtime-prompt-layers.js';

describe('runtime prompt layer schema', () => {
  it('marks orientation and posture layers as required runtime-aware sections', () => {
    expect(isRequiredRuntimePromptLayer('runtime.current_datetime')).toBe(true);
    expect(isRequiredRuntimePromptLayer('runtime.response_style_guidance')).toBe(true);
    expect(getRuntimePromptLayerDefinition('runtime.current_datetime')?.schema.classification).toBe('required_runtime_aware');
    expect(getRuntimePromptLayerDefinition('runtime.internal_state')?.schema.classification).toBe('required_runtime_aware');
  });

  it('marks adjunct runtime layers as optional', () => {
    expect(isRequiredRuntimePromptLayer('runtime.emotion_appraisal_chain')).toBe(false);
    expect(isRequiredRuntimePromptLayer('runtime.extended_tools')).toBe(false);
    expect(getRuntimePromptLayerDefinition('runtime.appearance_context')?.schema.classification).toBe('optional_runtime_aware');
    expect(getRuntimePromptLayerDefinition('runtime.skills_index')?.schema.classification).toBe('optional_runtime_aware');
  });

  it('returns cloned schema metadata for callers', () => {
    const definitions = getRuntimePromptLayerDefinitions();
    expect(definitions).toHaveLength(20);
    definitions[0]!.schema.required = false;
    expect(getRuntimePromptLayerDefinition('runtime.current_datetime')?.schema.required).toBe(true);
  });

  it('uses granular runtime variables in editable default templates', () => {
    expect(getRuntimePromptLayerDefinition('runtime.current_datetime')?.content).toContain('{{runtime_current_weekday}}');
    expect(getRuntimePromptLayerDefinition('runtime.current_datetime')?.content).toContain('{{runtime_current_time_human}}');
    expect(getRuntimePromptLayerDefinition('runtime.last_message_received')?.content).toContain('{{runtime_last_message_received_timezone}}');
    expect(getRuntimePromptLayerDefinition('runtime.last_message_received')?.content).toContain('{{runtime_last_message_received_missing_notice}}');
    expect(getRuntimePromptLayerDefinition('runtime.internal_turn_context')?.content).toContain('{{runtime_internal_turn_kind}}');
    expect(getRuntimePromptLayerDefinition('runtime.speaking_with')?.content).toContain('{{runtime_speaking_with_trust_level}}');
    expect(getRuntimePromptLayerDefinition('runtime.channel_context')?.content).toContain('{{runtime_channel_visibility}}');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).toContain('{{runtime_tooling_active_count}}');
    expect(getRuntimePromptLayerDefinition('runtime.response_style_guidance')?.content).toContain('{{runtime_response_style}}');
    expect(getRuntimePromptLayerDefinition('runtime.response_style_guidance')?.content).toContain('{{runtime_response_style_delivery_guidance}}');
    expect(getRuntimePromptLayerDefinition('runtime.response_style_guidance')?.content).toContain('{{runtime_response_style_expansion_guidance}}');
  });

  it('renders structured runtime metadata and prunes unavailable nested fields', () => {
    const template = [
      getRuntimePromptLayerDefinition('runtime.last_message_received')?.content ?? '',
      getRuntimePromptLayerDefinition('runtime.internal_turn_context')?.content ?? '',
      getRuntimePromptLayerDefinition('runtime.response_style_guidance')?.content ?? '',
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
        runtime_response_style_delivery_guidance: 'Answer directly and keep wording tight.',
        runtime_response_style_expansion_guidance: 'Expand only when the user asks for more detail.',
      },
    });

    expect(rendered).toContain('<status>No earlier message is loaded for this channel.</status>');
    expect(rendered).not.toContain('<weekday></weekday>');
    expect(rendered).not.toContain('<kind>');
    expect(rendered).toContain('<style>concise</style>');
    expect(rendered).toContain('<delivery>Answer directly and keep wording tight.</delivery>');
  });
});
