import { describe, expect, it } from 'vitest';
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
    expect(getRuntimePromptLayerDefinition('runtime.response_style_guidance')?.content).toContain('{{runtime_response_style_name}}');
    expect(getRuntimePromptLayerDefinition('runtime.response_style_guidance')?.content).toContain('{{runtime_response_style_guidance_body}}');
  });
});
