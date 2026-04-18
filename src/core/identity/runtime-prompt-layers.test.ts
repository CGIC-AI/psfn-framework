import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { injectPromptRuntimeTokens } from './prompt-runtime.js';
import { PromptLayerStore } from './prompt-store.js';
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

const REQUIRED_RUNTIME_SIGNAL_SECTIONS: Record<string, string> = {
  'runtime.last_message_received': '<last_message_received>{{runtime_last_message_received_weekday}}</last_message_received>',
  'runtime.internal_turn_context': '<internal_turn_context>{{runtime_internal_turn_kind}}</internal_turn_context>',
  'runtime.speaking_with': '<speaking_with>{{runtime_speaking_with_name}}</speaking_with>',
  'runtime.channel_context': '<channel_context>{{runtime_channel_visibility}}</channel_context>',
  'runtime.model_context': '<model_context>{{model}}</model_context>',
  'runtime.capability_tier': '<capability_tier>{{runtime_capability_tier}}</capability_tier>',
  'runtime.current_datetime': '<current_datetime>{{runtime_current_weekday}}</current_datetime>',
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
      'runtime.state',
      'runtime.self',
      'runtime.attention',
      'runtime.tooling',
    ]);
    definitions[0]!.schema.required = false;
    expect(getRuntimePromptLayerDefinition('runtime.state')?.schema.required).toBe(true);
  });

  it('returns cloned required runtime signal metadata for callers', () => {
    const manifest = getRequiredRuntimePromptSignalManifest();

    expect(manifest.map(signal => signal.identifier)).toEqual([
      'runtime.last_message_received',
      'runtime.internal_turn_context',
      'runtime.speaking_with',
      'runtime.channel_context',
      'runtime.model_context',
      'runtime.capability_tier',
      'runtime.current_datetime',
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
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_current_weekday}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_current_time_human}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_last_message_received_timezone}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_last_message_received_missing_notice}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_internal_turn_kind}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_speaking_with_trust_level}}');
    expect(getRuntimePromptLayerDefinition('runtime.state')?.content).toContain('{{runtime_channel_visibility}}');
    expect(getRuntimePromptLayerDefinition('runtime.tooling')?.content).toContain('{{runtime_tooling_active_count}}');
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
      'runtime.model_context',
      'runtime.capability_tier',
      'runtime.current_datetime',
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

    ensureRuntimePromptLayers(store);

    expect(store.getByType('runtime').map(layer => layer.identifier)).toEqual([
      'runtime.state',
      'runtime.self',
      'runtime.attention',
      'runtime.tooling',
    ]);
  });

  it('does not backfill umbrella runtime layers into legacy customized companions', () => {
    const root = makeTempDir();
    const store = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );

    for (const identifier of [
      'runtime.last_message_received',
      'runtime.internal_turn_context',
      'runtime.speaking_with',
      'runtime.channel_context',
      'runtime.model_context',
      'runtime.capability_tier',
      'runtime.current_datetime',
      'runtime.trust',
      'runtime.emotional_affect',
      'runtime.metacognitive_guidance',
      'runtime.response_style_guidance',
      'runtime.internal_state',
      'runtime.tooling',
    ]) {
      store.create({
        type: 'runtime',
        name: identifier,
        identifier,
        content: REQUIRED_RUNTIME_SIGNAL_SECTIONS[identifier],
        updatedBy: 'admin',
      });
    }

    ensureRuntimePromptLayers(store);

    expect(store.getByType('runtime').map(layer => layer.identifier)).not.toContain('runtime.state');
    expect(store.getByType('runtime').map(layer => layer.identifier)).not.toContain('runtime.self');
    expect(store.getByType('runtime').map(layer => layer.identifier)).not.toContain('runtime.attention');
    expect(store.getByType('runtime').map(layer => layer.identifier)).toContain('runtime.tooling');
  });
});
