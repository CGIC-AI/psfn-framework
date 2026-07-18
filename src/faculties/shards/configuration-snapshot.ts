import { createHash } from 'node:crypto';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ChargePolicyConfig } from '../../shared/contracts/charge-policy.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type {
  ShardCapabilityGrantEvidence,
  ShardConfigurationOverridePatch,
  ShardConfigurationOverrides,
  ShardConfigurationMutationResult,
  ShardConfigurationSnapshot,
  ShardConfigurationValues,
  ShardLifecycleState,
  ShardHealthState,
  ShardModelSelection,
  ShardResult,
  ShardWorkerBudget,
} from './types.js';

const SHARD_CONFIGURATION_REVISION_CONTRACT = 'psfn.shard-configuration.v1';
const OVERRIDE_KEYS = new Set(['model', 'workerBudget']);
const MODEL_KEYS = new Set(['provider', 'model']);
const WORKER_BUDGET_KEYS = new Set(['maxTurns', 'maxOutputTokens', 'maxChargeUnits']);

export interface ShardConfigurationControl {
  readonly shardId: string;
  readonly parentCompanionId: CompanionId;
  lifecycleState: ShardLifecycleState;
  health: ShardHealthState;
  readonly source: ShardConfigurationSnapshot['source'];
  readonly inherited: ShardConfigurationValues;
  readonly lineage: ShardResult['lineage'];
  override: ShardConfigurationOverrides;
  effective: ShardConfigurationValues;
  updatedAt?: number;
  updatedBy?: string;
}

export interface CreateShardConfigurationControlInput {
  shardId: string;
  parentCompanionId: CompanionId;
  lifecycleState: ShardLifecycleState;
  health: ShardHealthState;
  capturedAt: number;
  maxTurns: number;
  capabilityGrant: ShardCapabilityGrantEvidence;
  lineage: ShardResult['lineage'];
  config: SubstrateConfig;
  parentSystemPrompt: string;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number greater than or equal to zero`);
  }
  return value;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown keys: ${unknown.join(', ')}`);
  }
}

function normalizedText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parseShardConfigurationOverridePatch(
  value: unknown,
): ShardConfigurationOverridePatch {
  if (!isRecord(value)) {
    throw new Error('Shard configuration override payload must be a JSON object');
  }
  assertAllowedKeys(value, OVERRIDE_KEYS, 'Shard configuration override payload');
  if (Object.keys(value).length === 0) {
    throw new Error('Shard configuration override payload must include model or workerBudget');
  }

  const patch: ShardConfigurationOverridePatch = {};
  if (Object.hasOwn(value, 'model')) {
    if (value.model === null) {
      patch.model = null;
    } else {
      if (!isRecord(value.model)) {
        throw new Error('model must be an object or null');
      }
      assertAllowedKeys(value.model, MODEL_KEYS, 'model');
      if (Object.keys(value.model).length !== MODEL_KEYS.size) {
        throw new Error('model must include exactly provider and model');
      }
      patch.model = {
        provider: normalizedText(value.model.provider, 'model.provider').toLowerCase(),
        model: normalizedText(value.model.model, 'model.model'),
      };
    }
  }

  if (Object.hasOwn(value, 'workerBudget')) {
    if (value.workerBudget === null) {
      patch.workerBudget = null;
    } else {
      if (!isRecord(value.workerBudget)) {
        throw new Error('workerBudget must be an object or null');
      }
      assertAllowedKeys(value.workerBudget, WORKER_BUDGET_KEYS, 'workerBudget');
      if (Object.keys(value.workerBudget).length === 0) {
        throw new Error('workerBudget must include at least one approved budget key');
      }
      patch.workerBudget = {
        ...(Object.hasOwn(value.workerBudget, 'maxTurns')
          ? { maxTurns: positiveInteger(value.workerBudget.maxTurns, 'workerBudget.maxTurns') }
          : {}),
        ...(Object.hasOwn(value.workerBudget, 'maxOutputTokens')
          ? {
              maxOutputTokens: positiveInteger(
                value.workerBudget.maxOutputTokens,
                'workerBudget.maxOutputTokens',
              ),
            }
          : {}),
        ...(Object.hasOwn(value.workerBudget, 'maxChargeUnits')
          ? {
              maxChargeUnits: nonNegativeNumber(
                value.workerBudget.maxChargeUnits,
                'workerBudget.maxChargeUnits',
              ),
            }
          : {}),
      };
    }
  }
  return patch;
}

function modelKey(selection: Pick<ShardModelSelection, 'provider' | 'model'>): string {
  return `${selection.provider.toLowerCase()}\u0000${selection.model}`;
}

function resolveModelTokenLimit(
  config: SubstrateConfig,
  provider: string,
  model: string,
): number {
  const entry = config.modelRegistry?.models.find(candidate => (
    candidate.enabled !== false
    && candidate.identity.provider.toLowerCase() === provider.toLowerCase()
    && candidate.identity.model === model
  ));
  return positiveInteger(
    entry?.tuning?.maxOutputTokens
      ?? entry?.capabilities?.maxOutputTokens
      ?? config.primaryMaxTokens,
    `model ${provider}/${model} maxOutputTokens`,
  );
}

export function resolveParentAllowedShardModels(config: SubstrateConfig): ShardModelSelection[] {
  const enabledProviders = config.providerRegistry
    ? new Set(
      config.providerRegistry.providers
        .filter(provider => provider.enabled)
        .map(provider => provider.id.toLowerCase()),
    )
    : null;
  const candidates = (config.modelRegistry?.models ?? [])
    .filter(entry => (
      entry.enabled !== false
      && entry.purposes.some(purpose => purpose.purpose === 'chat')
      && (!enabledProviders || enabledProviders.has(entry.identity.provider.toLowerCase()))
    ))
    .map((entry): ShardModelSelection => ({
      provider: entry.identity.provider.toLowerCase(),
      model: entry.identity.model,
      maxOutputTokens: positiveInteger(
        entry.tuning?.maxOutputTokens
          ?? entry.capabilities?.maxOutputTokens
          ?? config.primaryMaxTokens,
        `model ${entry.id} maxOutputTokens`,
      ),
      ...(entry.capabilities?.contextWindow !== undefined
        ? {
            contextWindow: positiveInteger(
              entry.capabilities.contextWindow,
              `model ${entry.id} contextWindow`,
            ),
          }
        : {}),
    }));

  const inherited: ShardModelSelection = {
    provider: config.primaryProvider.trim().toLowerCase(),
    model: config.primaryModel.trim(),
    maxOutputTokens: resolveModelTokenLimit(
      config,
      config.primaryProvider,
      config.primaryModel,
    ),
    ...(config.modelRoster.chat?.contextWindow !== undefined
      ? { contextWindow: config.modelRoster.chat.contextWindow }
      : {}),
  };
  const byKey = new Map(candidates.map(candidate => [modelKey(candidate), candidate]));
  if (!config.modelRegistry) {
    if (enabledProviders && !enabledProviders.has(inherited.provider)) {
      throw new Error('Parent primary provider is disabled in the live provider registry');
    }
    byKey.set(modelKey(inherited), inherited);
  }
  const allowed = [...byKey.values()];
  if (!byKey.has(modelKey(inherited))) {
    throw new Error('Parent primary model is not eligible under the live provider/model registry');
  }
  return allowed;
}

function cloneModel(model: ShardModelSelection): ShardModelSelection {
  return { ...model };
}

function cloneBudget(budget: ShardWorkerBudget): ShardWorkerBudget {
  return { ...budget };
}

function cloneCapabilityGrant(
  grant: ShardCapabilityGrantEvidence,
): ShardCapabilityGrantEvidence {
  return Object.freeze({
    ...grant,
    tokens: Object.freeze([...grant.tokens]),
    denialMask: Object.freeze([...grant.denialMask]),
  });
}

function cloneReadOnly(
  readOnly: ShardConfigurationValues['readOnly'],
): ShardConfigurationValues['readOnly'] {
  return {
    capabilityTier: { ...readOnly.capabilityTier },
    trust: { ...readOnly.trust },
    identity: { ...readOnly.identity },
    prompts: { ...readOnly.prompts },
    capabilityGrant: cloneCapabilityGrant(readOnly.capabilityGrant),
  };
}

function cloneValues(values: ShardConfigurationValues): ShardConfigurationValues {
  return {
    model: cloneModel(values.model),
    workerBudget: cloneBudget(values.workerBudget),
    readOnly: cloneReadOnly(values.readOnly),
  };
}

function configurationRevision(input: {
  parentCompanionId: CompanionId;
  capabilityGrant: ShardCapabilityGrantEvidence;
  allowedModels: readonly ShardModelSelection[];
  parentSystemPrompt: string;
}): string {
  return createHash('sha256').update(JSON.stringify([
    SHARD_CONFIGURATION_REVISION_CONTRACT,
    input.parentCompanionId,
    input.capabilityGrant.ownerVersion,
    input.capabilityGrant.grantDigest,
    input.allowedModels.map(model => [
      model.provider,
      model.model,
      model.maxOutputTokens,
      model.contextWindow ?? null,
    ]),
    createHash('sha256').update(input.parentSystemPrompt, 'utf8').digest('hex'),
  ])).digest('hex');
}

export function createShardConfigurationControl(
  input: CreateShardConfigurationControlInput,
): ShardConfigurationControl {
  if (
    input.lineage.coreCompanionId !== input.parentCompanionId
    || input.lineage.companionProvenance.parentCompanionId !== input.parentCompanionId
    || input.lineage.shardId !== input.shardId
  ) {
    throw new Error('Shard configuration control requires complete parent-owned lineage');
  }
  const allowedModels = resolveParentAllowedShardModels(input.config);
  const inheritedModel = allowedModels.find(model => (
    model.provider === input.config.primaryProvider.trim().toLowerCase()
    && model.model === input.config.primaryModel.trim()
  ));
  if (!inheritedModel) {
    throw new Error('Parent primary model is not eligible for shard inheritance');
  }
  const workerBudget: ShardWorkerBudget = {
    maxTurns: input.maxTurns,
    maxOutputTokens: Math.min(input.config.primaryMaxTokens, inheritedModel.maxOutputTokens),
    maxChargeUnits: input.config.chargePolicy?.runChargeQuotaByLane.shard ?? 0,
  };
  const inherited: ShardConfigurationValues = {
    model: cloneModel(inheritedModel),
    workerBudget,
    readOnly: {
      capabilityTier: {
        parent: input.capabilityGrant.parentTier,
        effective: input.capabilityGrant.derivedTier,
      },
      trust: {
        source: 'parent_runtime',
        mutable: false,
      },
      identity: {
        parentCompanionId: input.parentCompanionId,
        shardCompanionId: input.lineage.shardCompanionId,
        mutable: false,
      },
      prompts: {
        source: 'parent_launch_snapshot',
        mutable: false,
      },
      capabilityGrant: cloneCapabilityGrant(input.capabilityGrant),
    },
  };
  return {
    shardId: input.shardId,
    parentCompanionId: input.parentCompanionId,
    lifecycleState: input.lifecycleState,
    health: input.health,
    source: {
      kind: 'parent_launch',
      companionId: input.parentCompanionId,
      revision: configurationRevision({
        parentCompanionId: input.parentCompanionId,
        capabilityGrant: input.capabilityGrant,
        allowedModels,
        parentSystemPrompt: input.parentSystemPrompt,
      }),
      capabilityOwnerVersion: input.capabilityGrant.ownerVersion,
      grantDigest: input.capabilityGrant.grantDigest,
      capturedAt: input.capturedAt,
    },
    inherited,
    override: {
      model: null,
      workerBudget: {},
      readOnly: null,
    },
    effective: cloneValues(inherited),
    lineage: input.lineage,
  };
}

function liveBudgetBounds(
  control: ShardConfigurationControl,
  config: SubstrateConfig,
  selectedModel: ShardModelSelection,
): ShardWorkerBudget {
  return {
    maxTurns: control.inherited.workerBudget.maxTurns,
    maxOutputTokens: Math.min(
      control.inherited.workerBudget.maxOutputTokens,
      selectedModel.maxOutputTokens,
    ),
    maxChargeUnits: Math.min(
      control.inherited.workerBudget.maxChargeUnits,
      config.chargePolicy?.runChargeQuotaByLane.shard
        ?? control.inherited.workerBudget.maxChargeUnits,
    ),
  };
}

function assertWithinBound(value: number, bound: number, field: string): void {
  if (value > bound) {
    throw new Error(`${field} cannot exceed inherited parent bound ${bound}`);
  }
}

export function applyShardConfigurationOverride(
  control: ShardConfigurationControl,
  patch: ShardConfigurationOverridePatch,
  liveParentConfig: SubstrateConfig,
  actor: string,
  updatedAt = Date.now(),
): void {
  const allowedModels = resolveParentAllowedShardModels(liveParentConfig);
  const nextModelOverride = patch.model === undefined
    ? control.override.model
    : patch.model;
  const requestedModel = nextModelOverride ?? {
    provider: control.inherited.model.provider,
    model: control.inherited.model.model,
  };
  const selectedModel = allowedModels.find(model => modelKey(model) === modelKey(requestedModel));
  if (!selectedModel) {
    throw new Error('model is not eligible under the live parent provider/model allowlist');
  }

  const nextBudgetOverride = patch.workerBudget === undefined
    ? control.override.workerBudget
    : patch.workerBudget === null
      ? {}
      : { ...control.override.workerBudget, ...patch.workerBudget };
  const bounds = liveBudgetBounds(control, liveParentConfig, selectedModel);
  for (const [field, value] of Object.entries(nextBudgetOverride) as Array<
    [keyof ShardWorkerBudget, number]
  >) {
    assertWithinBound(value, bounds[field], `workerBudget.${field}`);
  }
  const effectiveBudget: ShardWorkerBudget = {
    maxTurns: nextBudgetOverride.maxTurns ?? bounds.maxTurns,
    maxOutputTokens: nextBudgetOverride.maxOutputTokens ?? bounds.maxOutputTokens,
    maxChargeUnits: nextBudgetOverride.maxChargeUnits ?? bounds.maxChargeUnits,
  };
  control.override = {
    model: nextModelOverride ? { ...nextModelOverride } : null,
    workerBudget: { ...nextBudgetOverride },
    readOnly: null,
  };
  control.effective = {
    model: cloneModel(selectedModel),
    workerBudget: effectiveBudget,
    readOnly: cloneReadOnly(control.inherited.readOnly),
  };
  control.updatedAt = updatedAt;
  control.updatedBy = actor;
}

function cloneLineage(lineage: ShardResult['lineage']): ShardResult['lineage'] {
  return {
    ...lineage,
    companionProvenance: { ...lineage.companionProvenance },
    sourceMessage: { ...lineage.sourceMessage },
    ...(lineage.sourceContext ? { sourceContext: { ...lineage.sourceContext } } : {}),
    ...(lineage.satelliteRouting ? { satelliteRouting: { ...lineage.satelliteRouting } } : {}),
  };
}

export function snapshotShardConfiguration(
  control: ShardConfigurationControl,
  liveParentConfig: SubstrateConfig,
): ShardConfigurationSnapshot {
  return {
    schemaVersion: 1,
    shardId: control.shardId,
    parentCompanionId: control.parentCompanionId,
    lifecycleState: control.lifecycleState,
    health: control.health,
    source: { ...control.source },
    inherited: cloneValues(control.inherited),
    override: {
      model: control.override.model ? { ...control.override.model } : null,
      workerBudget: { ...control.override.workerBudget },
      readOnly: null,
    },
    effective: cloneValues(control.effective),
    allowed: {
      models: resolveParentAllowedShardModels(liveParentConfig).map(cloneModel),
      workerBudget: liveBudgetBounds(control, liveParentConfig, control.effective.model),
    },
    lineage: cloneLineage(control.lineage),
    ...(control.updatedAt !== undefined ? { updatedAt: control.updatedAt } : {}),
    ...(control.updatedBy !== undefined ? { updatedBy: control.updatedBy } : {}),
  };
}

export interface ShardConfigurationAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export class ShardConfigurationRegistry {
  private readonly controls = new Map<string, ShardConfigurationControl>();
  private readonly chargePolicies = new Map<string, ChargePolicyConfig>();

  constructor(private readonly deps: {
    liveParentConfig: () => SubstrateConfig;
    auditTrail?: ShardConfigurationAuditTrail | null;
  }) {}

  register(
    control: ShardConfigurationControl,
    chargePolicy: ChargePolicyConfig | null,
  ): void {
    if (this.controls.has(control.shardId)) {
      throw new Error(`Shard configuration control already exists for "${control.shardId}".`);
    }
    this.controls.set(control.shardId, control);
    if (chargePolicy) this.chargePolicies.set(control.shardId, chargePolicy);
  }

  release(shardId: string): void {
    this.controls.delete(shardId);
    this.chargePolicies.delete(shardId);
  }

  syncLifecycle(
    shardId: string,
    lifecycleState: ShardLifecycleState,
    health: ShardHealthState,
  ): void {
    const control = this.controls.get(shardId);
    if (!control) return;
    control.lifecycleState = lifecycleState;
    control.health = health;
  }

  effectiveWorkerBudget(shardId: string): ShardWorkerBudget {
    return this.requireControl(shardId).effective.workerBudget;
  }

  effectiveWorkerBudgetIfAvailable(shardId: string): ShardWorkerBudget | null {
    return this.controls.get(shardId)?.effective.workerBudget ?? null;
  }

  effectiveValues(shardId: string): ShardConfigurationValues {
    return this.requireControl(shardId).effective;
  }

  getSnapshot(
    parentCompanionId: string,
    shardId: string,
  ): ShardConfigurationSnapshot | null {
    const control = this.resolve(parentCompanionId, shardId);
    if (!control) return null;
    return snapshotShardConfiguration(control, this.deps.liveParentConfig());
  }

  update(input: {
    parentCompanionId: string;
    shardId: string;
    actor: string;
    override: unknown;
  }): ShardConfigurationMutationResult {
    const control = this.resolve(input.parentCompanionId, input.shardId);
    if (!control) {
      this.deps.auditTrail?.append('shard.configuration.override', {
        shardId: input.shardId,
        parentCompanionId: input.parentCompanionId,
        actor: input.actor,
        decision: 'denied',
        reason: 'not_found',
      });
      return {
        ok: false,
        code: 'not_found',
        message: 'Shard not found',
      };
    }

    const parentConfig = this.deps.liveParentConfig();
    const previous = snapshotShardConfiguration(control, parentConfig);
    try {
      const patch = parseShardConfigurationOverridePatch(input.override);
      applyShardConfigurationOverride(control, patch, parentConfig, input.actor);
      const chargePolicy = this.chargePolicies.get(input.shardId);
      if (chargePolicy) {
        chargePolicy.runChargeQuotaByLane.shard = control.effective.workerBudget.maxChargeUnits;
      }
      const snapshot = snapshotShardConfiguration(control, parentConfig);
      this.deps.auditTrail?.append('shard.configuration.override', {
        shardId: input.shardId,
        parentCompanionId: input.parentCompanionId,
        actor: input.actor,
        decision: 'approved',
        previous: {
          override: previous.override,
          effective: previous.effective,
        },
        effective: snapshot.effective,
        lineage: {
          shardId: control.lineage.shardId,
          parentCompanionId: control.lineage.companionProvenance.parentCompanionId,
          shardCompanionId: control.lineage.shardCompanionId,
        },
        capabilityGrant: control.inherited.readOnly.capabilityGrant,
      });
      return { ok: true, snapshot };
    } catch (error) {
      const message = toErrorMessage(error);
      this.deps.auditTrail?.append('shard.configuration.override', {
        shardId: input.shardId,
        parentCompanionId: input.parentCompanionId,
        actor: input.actor,
        decision: 'denied',
        reason: 'invalid_override',
        message,
        previous: {
          override: previous.override,
          effective: previous.effective,
        },
      });
      return {
        ok: false,
        code: 'invalid_override',
        message,
      };
    }
  }

  private resolve(
    parentCompanionId: string,
    shardId: string,
  ): ShardConfigurationControl | null {
    const control = this.controls.get(shardId);
    if (
      !control
      || control.lifecycleState === 'offline'
      || control.health === 'failed'
      || control.parentCompanionId !== parentCompanionId
      || control.lineage.coreCompanionId !== parentCompanionId
      || control.lineage.companionProvenance.parentCompanionId !== parentCompanionId
      || control.lineage.shardId !== shardId
    ) {
      return null;
    }
    return control;
  }

  private requireControl(shardId: string): ShardConfigurationControl {
    const control = this.controls.get(shardId);
    if (!control) {
      throw new Error(`Shard configuration control unavailable for "${shardId}".`);
    }
    return control;
  }
}
