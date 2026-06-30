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

const LEGACY_RUNTIME_LAYER_SEEDS = [
  {
    identifier: 'runtime.self',
    name: 'Runtime Self',
    priority: 90,
    content: '<runtime_self><style>{{runtime_response_style}}</style><trust>{{runtime_trust_level}}</trust></runtime_self>',
  },
  {
    identifier: 'runtime.last_message_received',
    name: 'Last Message Received',
    priority: 100,
    content: '<last_message_received>{{runtime_last_message_received_weekday}}</last_message_received>',
  },
  {
    identifier: 'runtime.internal_turn_context',
    name: 'Internal Turn Context',
    priority: 110,
    content: '<internal_turn_context>{{runtime_internal_turn_kind}}</internal_turn_context>',
  },
  {
    identifier: 'runtime.conversation_state',
    name: 'Conversation State',
    priority: 120,
    content: '<conversation_state>{{runtime_chat_type}}{{runtime_current_message_author_name}}</conversation_state>',
  },
  {
    identifier: 'runtime.model_context',
    name: 'Model Context',
    priority: 130,
    content: '<model_context>{{model}}</model_context>',
  },
  {
    identifier: 'runtime.capability_tier',
    name: 'Capability Tier',
    priority: 140,
    content: '<capability_tier>{{runtime_capability_tier}}</capability_tier>',
  },
  {
    identifier: 'runtime.state',
    name: 'Runtime State',
    priority: 150,
    content: '<runtime_state><legacy>true</legacy></runtime_state>',
  },
  {
    identifier: 'runtime.tooling',
    name: 'Runtime Tooling',
    priority: 160,
    content: '<runtime_tooling><analysis_workbench_guidance>legacy guidance</analysis_workbench_guidance></runtime_tooling>',
  },
  {
    identifier: 'runtime.trust',
    name: 'Trust Guidance',
    priority: 170,
    content: '<trust>{{runtime_trust_level}}</trust>',
  },
  {
    identifier: 'runtime.appearance_context',
    name: 'Appearance Context',
    priority: 180,
    content: '<appearance_context>{{runtime_appearance_context_body}}</appearance_context>',
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
    updatedBy: string;
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
      updatedBy: override.updatedBy ?? 'system',
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
  'runtime.conversation_state': '<conversation_state>{{runtime_chat_type}}{{runtime_current_message_author_name}}</conversation_state>',
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
  it('loads only seed-backed current runtime layers', () => {
    expect(getRuntimePromptLayerDefinitions().map(definition => definition.identifier)).toEqual([
      'runtime.attention',
      'runtime.response_style',
      'runtime.tooling',
      'runtime.state',
    ]);

    expect(isRequiredRuntimePromptLayer('runtime.state')).toBe(true);
    expect(isRequiredRuntimePromptLayer('runtime.attention')).toBe(false);
    expect(isRequiredRuntimePromptLayer('runtime.response_style')).toBe(false);
    expect(isRequiredRuntimePromptLayer('runtime.tooling')).toBe(false);
    expect(isRequiredRuntimePromptLayer('runtime.self')).toBe(false);
    expect(getRuntimePromptLayerDefinition('runtime.self')).toBeNull();
  });

  it('returns cloned schema metadata for callers', () => {
    const definitions = getRuntimePromptLayerDefinitions();

    definitions[0]!.schema.required = true;

    expect(getRuntimePromptLayerDefinition('runtime.attention')?.schema.required).toBe(false);
    expect(getRuntimePromptLayerDefinition('runtime.state')?.schema.required).toBe(true);
  });

  it('requires only the runtime state signals that are deterministic runtime context', () => {
    const manifest = getRequiredRuntimePromptSignalManifest();

    expect(manifest.map(signal => signal.identifier)).toEqual([
      'runtime.last_message_received',
      'runtime.internal_turn_context',
      'runtime.conversation_state',
    ]);
    manifest[0]!.required = false;

    expect(getRequiredRuntimePromptSignalManifest()[0]?.required).toBe(true);
  });

  it('keeps backend-only and removed guidance out of the seed-backed runtime layers', () => {
    const template = getRuntimePromptLayerDefinitions()
      .map(definition => definition.content)
      .join('\n\n');

    expect(template).not.toContain('<runtime_self>');
    expect(template).not.toContain('<analysis_workbench_guidance>');
    expect(template).not.toContain('<model_context>');
    expect(template).not.toContain('<capability_tier>');
    expect(template).not.toContain('{{model}}');
    expect(template).not.toContain('{{runtime_tooling_active_count}}');
    expect(template).not.toContain('{{runtime_analysis_workbench_guidance_body}}');
    expect(template).not.toContain('<emotion_appraisal_chain>');
    expect(template).toContain('<response_style_guidance>');
    expect(template).toContain('<conversation_state>');
    expect(template).toContain('{{runtime_chat_type}}');
    expect(template).toContain('{{runtime_current_message_author_xml}}');
    expect(template).toContain('{{runtime_recent_active_participants_xml}}');
  });

  it('renders state as structured runtime metadata without runtime_self', () => {
    const template = getRuntimePromptLayerDefinition('runtime.state')?.content ?? '';
    const rendered = injectPromptRuntimeTokens(template, {
      variables: {
        runtime_last_message_received_weekday: '',
        runtime_last_message_received_date_human: '',
        runtime_last_message_received_time_human: '',
        runtime_last_message_received_timezone: '',
        runtime_last_message_received_ago: '',
        runtime_last_message_received_missing_notice: 'No earlier message is loaded for this channel.',
        runtime_internal_turn_kind: '',
        runtime_chat_type: 'direct_message',
        runtime_room_id: 'discord:dm:alex',
        runtime_channel_type: 'discord_text',
        runtime_channel_visibility: 'private',
        runtime_current_message_author_xml: '<current_message_author name="Alex" id="discord:alex" />',
        runtime_recent_active_participants_xml: '',
      },
    });

    expect(rendered).toContain('<runtime_state>');
    expect(rendered).not.toContain('<runtime_self>');
    expect(rendered).toContain('<status>No earlier message is loaded for this channel.</status>');
    expect(rendered).toContain('<chat_type>direct_message</chat_type>');
    expect(rendered).toContain('<current_message_author name="Alex" id="discord:alex" />');
    expect(rendered).not.toContain('<weekday></weekday>');
    expect(rendered).not.toContain('<kind>');
  });

  it('treats the seed-backed defaults as valid required signal coverage', () => {
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
        'runtime.internal_turn_context',
        'runtime.conversation_state',
      ]),
      {
        type: 'runtime',
        identifier: 'runtime.internal_turn_context',
        content: REQUIRED_RUNTIME_SIGNAL_SECTIONS['runtime.internal_turn_context'],
        enabled: false,
      },
      {
        type: 'runtime',
        identifier: 'runtime.conversation_state',
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
        identifier: 'runtime.internal_turn_context',
        name: 'Internal Turn Context',
        reason: 'disabled',
      },
      {
        identifier: 'runtime.conversation_state',
        name: 'Conversation State',
        reason: 'empty',
      },
    ]);
  });

  it('seeds fresh companions with only the current runtime layers', () => {
    const root = makeTempDir();
    const store = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const { events, logger } = createMigrationLogger();

    const summary = ensureRuntimePromptLayers(store, { logger });

    expect(store.getByType('runtime').map(layer => layer.identifier)).toEqual([
      'runtime.attention',
      'runtime.response_style',
      'runtime.tooling',
      'runtime.state',
    ]);
    for (const definition of getRuntimePromptLayerDefinitions()) {
      const layer = store.getByType('runtime').find(entry => entry.identifier === definition.identifier);
      expect(layer?.priority).toBe(definition.priority);
      expect(layer?.promptOrder).toBe(definition.priority);
    }
    expect(summary).toMatchObject({
      outcome: 'seeded_umbrella_defaults',
      createdUmbrellaIdentifiers: ['runtime.attention', 'runtime.response_style', 'runtime.tooling', 'runtime.state'],
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

  it('migrates untouched legacy runtime layers to seed-backed defaults and removes runtime_self', () => {
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
      'runtime.response_style',
      'runtime.state',
      'runtime.tooling',
    ]);
    expect(store.getByType('runtime').find(layer => layer.identifier === 'runtime.tooling')?.content)
      .toBe(getRuntimePromptLayerDefinition('runtime.tooling')?.content);
    expect(store.getByType('runtime').find(layer => layer.identifier === 'runtime.state')?.content)
      .toBe(getRuntimePromptLayerDefinition('runtime.state')?.content);
    expect(summary.upgradedLegacyIdentifiers.sort()).toEqual(['runtime.state', 'runtime.tooling']);
    expect(summary.removedLegacyIdentifiers).toContain('runtime.self');
    expect(summary.removedLegacyIdentifiers).toContain('runtime.last_message_received');
    expect(summary.removedLegacyIdentifiers).toContain('runtime.model_context');
    expect(summary.removedLegacyIdentifiers).toContain('runtime.appearance_context');
    expect(events.at(0)).toMatchObject({
      message: 'runtime_prompt_layer_migration',
      payload: expect.objectContaining({
        outcome: 'migrated_legacy_defaults',
      }),
    });
  });

  it('preserves existing runtime layer order while normalizing system-owned content', () => {
    const root = makeTempDir();
    const store = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    seedLegacyRuntimeLayers(store, {
      'runtime.state': {
        priority: 900,
        promptOrder: 901,
      },
      'runtime.tooling': {
        priority: 902,
        promptOrder: 903,
      },
    });

    ensureRuntimePromptLayers(store);

    const stateLayer = store.getByType('runtime').find(layer => layer.identifier === 'runtime.state');
    const toolingLayer = store.getByType('runtime').find(layer => layer.identifier === 'runtime.tooling');
    expect(stateLayer?.content).toBe(getRuntimePromptLayerDefinition('runtime.state')?.content);
    expect(stateLayer?.priority).toBe(900);
    expect(stateLayer?.promptOrder).toBe(901);
    expect(toolingLayer?.content).toBe(getRuntimePromptLayerDefinition('runtime.tooling')?.content);
    expect(toolingLayer?.priority).toBe(902);
    expect(toolingLayer?.promptOrder).toBe(903);
  });

  it('retains customized legacy layers while adding current seed-backed layers alongside them', () => {
    const root = makeTempDir();
    const store = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const { events, logger } = createMigrationLogger();
    seedLegacyRuntimeLayers(store, {
      'runtime.self': {
        content: '<runtime_self>Operator-edited legacy block.</runtime_self>',
        updatedBy: 'operator',
      },
      'runtime.trust': {
        content: '<trust>Operator-edited legacy trust guidance.</trust>',
        updatedBy: 'operator',
      },
    });

    const summary = ensureRuntimePromptLayers(store, { logger });
    const runtimeIdentifiers = store.getByType('runtime')
      .map(layer => layer.identifier)
      .sort();

    expect(runtimeIdentifiers).toContain('runtime.attention');
    expect(runtimeIdentifiers).toContain('runtime.tooling');
    expect(runtimeIdentifiers).toContain('runtime.state');
    expect(runtimeIdentifiers).toContain('runtime.self');
    expect(runtimeIdentifiers).toContain('runtime.trust');
    expect(runtimeIdentifiers).not.toContain('runtime.last_message_received');
    expect(store.getByType('runtime').find(layer => layer.identifier === 'runtime.self')?.content)
      .toBe('<runtime_self>Operator-edited legacy block.</runtime_self>');
    expect(store.getByType('runtime').find(layer => layer.identifier === 'runtime.trust')?.content)
      .toBe('<trust>Operator-edited legacy trust guidance.</trust>');
    expect(summary).toMatchObject({
      outcome: 'migrated_legacy_defaults_with_custom_retention',
      retainedCustomizedLegacyIdentifiers: ['runtime.self', 'runtime.trust'],
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
