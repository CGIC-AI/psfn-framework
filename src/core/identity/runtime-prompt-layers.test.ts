import { describe, expect, it } from 'vitest';
import {
  getRuntimePromptLayerDefinition,
  getRuntimePromptLayerDefinitions,
  isRequiredRuntimePromptLayer,
  validateRuntimePromptLayerCoverage,
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

  it('reports missing and invalid required runtime prompt layers distinctly', () => {
    const layers = getRuntimePromptLayerDefinitions().map(definition => ({
      type: 'runtime' as const,
      identifier: definition.identifier,
      content: definition.content,
      enabled: true,
    }));
    const filteredLayers = layers.filter(layer => layer.identifier !== 'runtime.internal_turn_context');
    const currentDateLayer = filteredLayers.find(layer => layer.identifier === 'runtime.current_datetime');
    const lastMessageLayer = filteredLayers.find(layer => layer.identifier === 'runtime.last_message_received');
    expect(currentDateLayer).toBeTruthy();
    expect(lastMessageLayer).toBeTruthy();

    currentDateLayer!.content = '';
    lastMessageLayer!.enabled = false;

    const result = validateRuntimePromptLayerCoverage(filteredLayers);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      {
        identifier: 'runtime.current_datetime',
        name: 'Current Date & Time',
        reason: 'empty',
      },
      {
        identifier: 'runtime.last_message_received',
        name: 'Last Message Received',
        reason: 'disabled',
      },
      {
        identifier: 'runtime.internal_turn_context',
        name: 'Internal Turn Context',
        reason: 'missing',
      },
    ]);
  });
});
