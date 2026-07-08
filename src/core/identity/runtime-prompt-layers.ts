import type { PromptLayerStatePort } from './prompt-state-port.js';
import type { PromptLayer } from './prompt-types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord } from '../../shared/utils/types.js';

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
  'runtime.conversation_state',
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
  'runtime.self',
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

const RUNTIME_PROMPT_LAYER_SEED_FILE_NAME = 'runtime-prompt-layers.seed.json';

interface RuntimePromptLayerSeedEntry {
  identifier: string;
  name: string;
  content: string;
  priority: number;
  required: boolean;
}

interface RuntimePromptLayerSeedFile {
  schemaVersion: 1;
  layers: RuntimePromptLayerSeedEntry[];
}

let runtimePromptLayerDefinitionCache: RuntimePromptLayerDefinition[] | null = null;

function asNonEmptyString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldPath} must be a non-empty string`);
  }
  return value.trim();
}

function asBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldPath} must be a boolean`);
  }
  return value;
}

function asInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${fieldPath} must be an integer`);
  }
  return value;
}

function parseRuntimePromptLayerSeedFile(value: unknown, sourcePath: string): RuntimePromptLayerSeedFile {
  if (!isRecord(value)) {
    throw new Error(`${sourcePath} must contain a JSON object`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${sourcePath}.schemaVersion must be 1`);
  }
  if (!Array.isArray(value.layers)) {
    throw new Error(`${sourcePath}.layers must be an array`);
  }

  const seen = new Set<string>();
  const layers = value.layers.map((entry, index): RuntimePromptLayerSeedEntry => {
    const fieldPath = `${sourcePath}.layers[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${fieldPath} must be an object`);
    }
    const identifier = asNonEmptyString(entry.identifier, `${fieldPath}.identifier`);
    if (seen.has(identifier)) {
      throw new Error(`${fieldPath}.identifier duplicates ${identifier}`);
    }
    seen.add(identifier);
    return {
      identifier,
      name: asNonEmptyString(entry.name, `${fieldPath}.name`),
      content: asNonEmptyString(entry.content, `${fieldPath}.content`),
      priority: asInteger(entry.priority, `${fieldPath}.priority`),
      required: asBoolean(entry.required, `${fieldPath}.required`),
    };
  });

  return {
    schemaVersion: 1,
    layers,
  };
}

function readRuntimePromptLayerDefinitions(): RuntimePromptLayerDefinition[] {
  const seedDir = process.env.CONFIG_DIR?.trim() || join(process.cwd(), 'config');
  const seedPath = join(seedDir, RUNTIME_PROMPT_LAYER_SEED_FILE_NAME);
  const parsed = parseRuntimePromptLayerSeedFile(
    JSON.parse(readFileSync(seedPath, 'utf-8')) as unknown,
    seedPath,
  );
  return parsed.layers.map(layer => ({
    identifier: layer.identifier,
    name: layer.name,
    content: layer.content,
    priority: layer.priority,
    schema: layer.required ? REQUIRED_RUNTIME_LAYER_SCHEMA : OPTIONAL_RUNTIME_LAYER_SCHEMA,
  }));
}

function getRuntimePromptLayerDefinitionCache(): readonly RuntimePromptLayerDefinition[] {
  runtimePromptLayerDefinitionCache ??= readRuntimePromptLayerDefinitions();
  return runtimePromptLayerDefinitionCache;
}

function getRuntimePromptLayerDefinitionMap(): Map<string, RuntimePromptLayerDefinition> {
  return new Map(getRuntimePromptLayerDefinitionCache().map(definition => [definition.identifier, definition]));
}

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
    'runtime.conversation_state',
    'Conversation State',
    ['runtime.state'],
    ['<conversation_state>', '{{runtime_chat_type}}', '{{runtime_current_message_author_'],
  ),
] as const;

export function getRuntimePromptLayerDefinitions(): RuntimePromptLayerDefinition[] {
  return getRuntimePromptLayerDefinitionCache().map(definition => ({
    identifier: definition.identifier,
    name: definition.name,
    content: definition.content,
    priority: definition.priority,
    schema: { ...definition.schema },
  }));
}

export function getRuntimePromptLayerDefinition(identifier: string): RuntimePromptLayerDefinition | null {
  const definition = getRuntimePromptLayerDefinitionMap().get(identifier);
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
  return getRuntimePromptLayerDefinitionMap().get(identifier)?.schema.required ?? false;
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
  return getRuntimePromptLayerDefinitionCache()
    .map(definition => definition.content.trim())
    .filter(content => content.length > 0)
    .join('\n\n');
}

export interface DefaultRuntimePromptSection {
  identifier: string;
  required: boolean;
  content: string;
}

/**
 * The seeded runtime layers as per-section render units (E2.5). Each section
 * carries its render policy: required sections fail the turn loudly on
 * unresolved macros; optional sections drop with telemetry.
 */
export function getDefaultRuntimePromptSections(): DefaultRuntimePromptSection[] {
  return getRuntimePromptLayerDefinitionCache().map(definition => ({
    identifier: definition.identifier,
    required: definition.schema.required,
    content: definition.content,
  }));
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

function isCurrentRuntimeSeedLayer(layer: Pick<PromptLayer, 'identifier'>): boolean {
  return typeof layer.identifier === 'string'
    && getRuntimePromptLayerDefinitionMap().has(layer.identifier);
}

function isSystemOwnedRuntimeLayer(layer: Pick<PromptLayer, 'updatedBy'>): boolean {
  return layer.updatedBy === 'system' || layer.updatedBy.startsWith('system:');
}

function isLegacyLayerDefault(layer: Pick<PromptLayer, 'identifier' | 'updatedBy'>): boolean {
  return isLegacyRuntimeLayerIdentifier(layer.identifier)
    && !isCurrentRuntimeSeedLayer(layer)
    && isSystemOwnedRuntimeLayer(layer);
}

function normalizeRuntimeLayerMetadata(
  promptStore: PromptLayerStatePort,
  layer: PromptLayer,
  definition: RuntimePromptLayerDefinition,
): boolean {
  const shouldUpgradeContent = isSystemOwnedRuntimeLayer(layer)
    && layer.content !== definition.content;
  const metadataPatch = {
    ...(layer.identifier !== definition.identifier ? { identifier: definition.identifier } : {}),
    ...(layer.role !== 'system' ? { role: 'system' as const } : {}),
  };
  if (Object.keys(metadataPatch).length === 0 && !shouldUpgradeContent) {
    return false;
  }
  promptStore.update(layer.id, {
    ...(shouldUpgradeContent ? { content: definition.content } : {}),
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

  for (const definition of getRuntimePromptLayerDefinitions()) {
    const existing = findExistingRuntimeLayer(promptStore, definition);
    const existingContent = existing?.content;
    createOrNormalizeUmbrella(definition);
    const updated = existing ? promptStore.getById(existing.id) : undefined;
    if (
      existing
      && updated
      && isSystemOwnedRuntimeLayer(existing)
      && existingContent !== definition.content
      && updated.content === definition.content
    ) {
      upgradedLegacyIdentifiers.push(definition.identifier);
    }
  }

  const runtimeLayers = promptStore.getAll().filter(layer => layer.type === 'runtime');
  for (const layer of runtimeLayers) {
    if (!isLegacyRuntimeLayerIdentifier(layer.identifier)) {
      continue;
    }

    if (isLegacyLayerDefault(layer)) {
      promptStore.delete(layer.id);
      removedLegacyIdentifiers.push(layer.identifier);
      continue;
    }

    if (!isCurrentRuntimeSeedLayer(layer)) {
      retainedLegacyIdentifiers.add(layer.identifier);
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
