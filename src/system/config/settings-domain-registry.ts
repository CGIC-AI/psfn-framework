/**
 * Canonical settings-domain registry (psfn-framework-4ssd5.1, epic 4ssd5).
 *
 * This is the single typed authority for the eight operator-approved
 * configuration domains identified by the settings authority audit
 * (`working_docs/hardcoded-settings-audit-2026-08-06.md`, section 4):
 *
 *   core, models, channels, memory, scheduler, cogsec, economy, capabilities
 *
 * Each domain descriptor owns the metadata that runtime resolution and Garden
 * rendering must share: canonical file path, the real owner files that feed it
 * today, the named schema validator, human title/description, default units,
 * global-vs-companion scope, activation tier and failure scope, live/restart
 * apply mode, global/companion inheritance, security bounds, cross-domain
 * relationships, and Garden tab metadata.
 *
 * Boundary contract:
 *
 * - Exactly these eight domains are registered. Unknown or duplicate domains
 *   fail closed in {@link verifySettingsDomainRegistry}.
 * - Topology, authority, and namespaced-extension owner files
 *   (companions, fleet-auth, MCP servers, satellites, identity/world data) are
 *   explicitly enumerated in {@link SETTINGS_NON_DOMAIN_OWNER_FILES} and may
 *   never be claimed as a domain.
 * - The migration from the current catch-all `settings.json` to per-domain
 *   files (rename to `core.json`, carve out `memory.json`/`cogsec.json`/
 *   `economy.json`, consolidate `capabilities.json`) is NOT performed here.
 *   Each domain records both its canonical target file and the real files that
 *   feed it today; pre-split fields reuse the existing shared Garden section
 *   classification when that section already names a canonical domain.
 *
 * The module is deliberately a runtime leaf: it imports only the shared
 * `isRecord` guard and a type-only reference to {@link SettingsFieldScope}, so
 * the settings contract and Garden contract can depend on it without cycles.
 */

import type { SettingsFieldScope } from './settings-contract.js';
import { SETTINGS_GARDEN_FIELD_EXPOSURE } from '../../shared/contracts/settings-garden-contract.js';

// ── Closed value sets ───────────────────────────────────────────────────────

/**
 * The exactly-eight canonical configuration domains. Order is the canonical
 * Garden tab order and must stay stable; it is validated for uniqueness.
 */
export const SETTINGS_DOMAIN_IDS = [
  'core',
  'models',
  'channels',
  'memory',
  'scheduler',
  'cogsec',
  'economy',
  'capabilities',
] as const;

export type SettingsDomainId = (typeof SETTINGS_DOMAIN_IDS)[number];

const SETTINGS_DOMAIN_ID_SET: ReadonlySet<string> = new Set(SETTINGS_DOMAIN_IDS);

const SETTINGS_GARDEN_EXPOSURE_BY_KEY = SETTINGS_GARDEN_FIELD_EXPOSURE as Readonly<
  Record<string, { readonly sectionId: string } | undefined>
>;

/**
 * How a domain value is applied after it validates. Matches the audit's
 * live-application contract (section 5.6): most settings target `live`;
 * transport credentials, listeners, and topology target restart tiers.
 */
export const SETTINGS_APPLY_MODES = [
  'live',
  'component_restart',
  'process_restart',
  'deployment_restart',
  'immutable',
] as const;

export type SettingsApplyMode = (typeof SETTINGS_APPLY_MODES)[number];

const SETTINGS_APPLY_MODE_SET: ReadonlySet<string> = new Set(SETTINGS_APPLY_MODES);

/**
 * Activation tier from the audit's presence/activation contract (section 5.5).
 */
export const SETTINGS_ACTIVATION_TIERS = [
  'boot_critical',
  'required_when_enabled',
  'optional_policy',
] as const;

export type SettingsActivationTier = (typeof SETTINGS_ACTIVATION_TIERS)[number];

const SETTINGS_ACTIVATION_TIER_SET: ReadonlySet<string> = new Set(SETTINGS_ACTIVATION_TIERS);

/**
 * Failure scope names which startup tier a malformed value takes down
 * (audit section 5.5): one unconfigured optional companion feature must not
 * take down unrelated fleet services.
 */
export const SETTINGS_FAILURE_SCOPES = [
  'runtime',
  'gateway',
  'agent',
  'companion',
  'feature',
] as const;

export type SettingsFailureScope = (typeof SETTINGS_FAILURE_SCOPES)[number];

const SETTINGS_FAILURE_SCOPE_SET: ReadonlySet<string> = new Set(SETTINGS_FAILURE_SCOPES);

/**
 * How a sparse per-companion domain file relates to the fleet-global default
 * (audit section 5.8): `global_only` paths reject companion overrides;
 * `companion_override` paths merge a sparse companion file over the global
 * default; `companion_required` paths must exist in each companion root.
 */
const SETTINGS_DOMAIN_INHERITANCE_MODES = [
  'global_only',
  'companion_override',
  'companion_required',
] as const;

type SettingsDomainInheritanceMode =
  (typeof SETTINGS_DOMAIN_INHERITANCE_MODES)[number];

const SETTINGS_DOMAIN_INHERITANCE_SET: ReadonlySet<string> = new Set(
  SETTINGS_DOMAIN_INHERITANCE_MODES,
);

const JSON_FILE_SUFFIX = '.json';

function isJsonFileName(value: string): boolean {
  return value.endsWith(JSON_FILE_SUFFIX) && value.length > JSON_FILE_SUFFIX.length;
}

// ── Descriptor shape ────────────────────────────────────────────────────────

/**
 * Cross-domain relationship descriptor. Related settings stay independent but
 * the contract describes their operational relationship (audit section 5.9).
 */
interface SettingsDomainRelation {
  readonly domain: SettingsDomainId;
  readonly kind: 'feeds' | 'constrains' | 'references';
  readonly description: string;
}

/**
 * Security bounds for a domain (audit sections 3.3, 5.5, 6.x). Code owns
 * non-bypassable floors and hard ceilings; operator JSON may only be equally
 * strict or stricter. Captured as metadata, not as bypassable values.
 */
interface SettingsDomainSecurityBounds {
  /** A code-owned floor exists that an operator value may never weaken. */
  readonly codeOwnedFloor: boolean;
  /** A code-owned hard ceiling exists that an operator value may never widen. */
  readonly codeOwnedCeiling: boolean;
  /**
   * CogSec-style policy: an operator may raise effective strictness but may
   * never silently weaken a code-owned invariant (audit section 6.6).
   */
  readonly stricterNeverWeaker: boolean;
  readonly description: string;
}

/**
 * Garden rendering metadata for one domain tab (audit section 5.7). Domain
 * tabs, search grouping, and ordering come from this registry rather than from
 * copied per-page config.
 */
export interface SettingsDomainGardenMeta {
  /** Stable tab id; equals the domain id. */
  readonly tabId: SettingsDomainId;
  /** Canonical render order across the eight tabs. */
  readonly order: number;
  readonly title: string;
  readonly description: string;
  /** Domain ids whose tabs should be reachable from this one. */
  readonly relatedTabs: readonly SettingsDomainId[];
}

/**
 * One named schema validator for a domain, pairing a real owner file with the
 * parse/normalize function that validates it. Stored as a stable string so the
 * descriptor stays serializable for Garden; the names mirror existing runtime
 * validators.
 */
interface SettingsDomainSchemaValidator {
  readonly ownerFile: string;
  readonly validator: string;
}

export interface SettingsDomainDescriptor {
  readonly id: SettingsDomainId;
  readonly title: string;
  readonly description: string;
  /** Canonical target file name after the domain split is complete. */
  readonly ownerFileName: string;
  /**
   * The real owner files that feed this domain today. Until the split
   * completes some domains consolidate several files (audit section 4 table).
   * `core` lists `settings.json` because the rename to `core.json` is deferred.
   */
  readonly currentOwnerFiles: readonly string[];
  /**
   * Named validators that parse each current owner file for this domain. A
   * missing or malformed owner file fails closed inside the named validator.
   */
  readonly schemaValidators: readonly SettingsDomainSchemaValidator[];
  /** Default unit hint for the domain's typical scalar fields. */
  readonly units: string;
  /** Domain-level predominant ownership scope. */
  readonly scope: SettingsFieldScope;
  readonly activationTier: SettingsActivationTier;
  readonly failureScope: SettingsFailureScope;
  readonly applyMode: SettingsApplyMode;
  readonly inheritance: SettingsDomainInheritanceMode;
  readonly securityBounds: SettingsDomainSecurityBounds;
  readonly relatedPaths: readonly SettingsDomainRelation[];
  readonly garden: SettingsDomainGardenMeta;
}

// ── The registry ────────────────────────────────────────────────────────────

export const SETTINGS_DOMAIN_REGISTRY: Readonly<Record<SettingsDomainId, SettingsDomainDescriptor>> = {
  core: {
    id: 'core',
    title: 'Core runtime and operations',
    description:
      'Sessions, lifecycle, tools, UI, imports, diagnostics, and operational behavior. '
      + 'Consolidates the catch-all settings.json plus backup policy; renames to core.json before public release.',
    ownerFileName: 'core.json',
    currentOwnerFiles: ['settings.json', 'backup.json'],
    schemaValidators: [
      { ownerFile: 'settings.json', validator: 'parseRuntimeSettingsOwnerPayload' },
      { ownerFile: 'backup.json', validator: 'loadBackupConfig' },
    ],
    units: 'ms',
    scope: 'global',
    activationTier: 'boot_critical',
    failureScope: 'runtime',
    applyMode: 'live',
    inheritance: 'companion_override',
    securityBounds: {
      codeOwnedFloor: true,
      codeOwnedCeiling: true,
      stricterNeverWeaker: false,
      description:
        'Lifecycle emergency ceilings (shutdown/drain/rollout/rollback) remain code-owned; '
        + 'operator JSON may only choose shorter operational timeouts.',
    },
    relatedPaths: [
      { domain: 'channels', kind: 'references', description: 'Transport enablement and voice destinations reference channel accounts.' },
      { domain: 'models', kind: 'references', description: 'Import/local-endpoint and MoA model selections reference the model registry.' },
    ],
    garden: {
      tabId: 'core',
      order: 0,
      title: 'Core',
      description: 'Sessions, lifecycle, tools, imports, and operations.',
      relatedTabs: ['channels', 'models'],
    },
  },

  models: {
    id: 'models',
    title: 'Models and inference',
    description:
      'Providers, model catalog, capabilities, purpose assignments, fallbacks, and every inference '
      + 'modality (text, audio, speech, image, video, embedding, classifier, MoA, tools). All inference '
      + 'consumers resolve through one purpose resolver.',
    ownerFileName: 'models.json',
    currentOwnerFiles: ['models.json', 'providers.json'],
    schemaValidators: [
      { ownerFile: 'models.json', validator: 'loadModelsConfig' },
      { ownerFile: 'providers.json', validator: 'loadProvidersConfig' },
    ],
    units: 'tokens',
    scope: 'global',
    activationTier: 'boot_critical',
    failureScope: 'runtime',
    applyMode: 'live',
    inheritance: 'companion_override',
    securityBounds: {
      codeOwnedFloor: false,
      codeOwnedCeiling: false,
      stricterNeverWeaker: false,
      description:
        'Provider/catalog definitions and default assignments are global-only; per-companion sparse '
        + 'models.json overrides only schema-approved assignment paths.',
    },
    relatedPaths: [
      { domain: 'core', kind: 'feeds', description: 'Purpose selections in core reference model assignments.' },
      { domain: 'capabilities', kind: 'references', description: 'Capability grants gate which model tools are reachable.' },
    ],
    garden: {
      tabId: 'models',
      order: 1,
      title: 'Models',
      description: 'Providers, catalog, capabilities, and purpose assignments.',
      relatedTabs: ['core', 'capabilities'],
    },
  },

  channels: {
    id: 'channels',
    title: 'Channels, transports, and routing',
    description:
      'Accounts, transports, channel roles, routing, notification sinks, privacy labels, and voice '
      + 'destinations. Fleet routing policy stays global; companion account selections and routes live '
      + 'in sparse companion files.',
    ownerFileName: 'channels.json',
    currentOwnerFiles: ['channels.json'],
    schemaValidators: [
      { ownerFile: 'channels.json', validator: 'loadRuntimeChannelsConfig' },
    ],
    units: 'id',
    scope: 'global',
    activationTier: 'boot_critical',
    failureScope: 'gateway',
    applyMode: 'component_restart',
    inheritance: 'companion_override',
    securityBounds: {
      codeOwnedFloor: true,
      codeOwnedCeiling: false,
      stricterNeverWeaker: true,
      description:
        'Routing is privacy-monotonic: private content never widens to a group, group content stays in '
        + 'its origin group or narrows to a verified private route, and there is no implicit last-active fallback.',
    },
    relatedPaths: [
      { domain: 'cogsec', kind: 'constrains', description: 'Disclosure and trust policy gate every routed destination.' },
      { domain: 'models', kind: 'references', description: 'Voice transports reference STT/TTS model assignments.' },
    ],
    garden: {
      tabId: 'channels',
      order: 2,
      title: 'Channels',
      description: 'Transports, accounts, roles, routing, and privacy.',
      relatedTabs: ['cogsec', 'models'],
    },
  },

  memory: {
    id: 'memory',
    title: 'Memory, retrieval, and relationships',
    description:
      'Memory retrieval, extraction, salience, relationships, affect shadows, profiles, and episodic '
      + 'policy. Carves memory fields out of settings.json and merges partner-affect-shadow policy under '
      + 'relationships; CogSec retains the trust/disclosure gates.',
    ownerFileName: 'memory.json',
    currentOwnerFiles: ['partner-affect-shadow.json'],
    schemaValidators: [
      { ownerFile: 'memory.json', validator: 'normalizeMemoryRetrievalPolicy' },
      { ownerFile: 'partner-affect-shadow.json', validator: 'validatePartnerAffectShadowConfig' },
    ],
    units: 'count',
    scope: 'global',
    activationTier: 'required_when_enabled',
    failureScope: 'feature',
    applyMode: 'live',
    inheritance: 'global_only',
    securityBounds: {
      codeOwnedFloor: true,
      codeOwnedCeiling: true,
      stricterNeverWeaker: false,
      description:
        'Hard integrity ceilings (unbounded-scan limits, oversized-write guards, retention bounds) stay '
        + 'code-owned; operator values may only tighten retrieval and extraction behavior.',
    },
    relatedPaths: [
      { domain: 'cogsec', kind: 'constrains', description: 'Audience scope and disclosure govern how relationship projections cross privacy boundaries.' },
      { domain: 'models', kind: 'references', description: 'Embedding identity (model and dimensions) is shared across pgvector schemas.' },
    ],
    garden: {
      tabId: 'memory',
      order: 3,
      title: 'Memory',
      description: 'Retrieval, extraction, salience, relationships, and profiles.',
      relatedTabs: ['cogsec', 'models'],
    },
  },

  scheduler: {
    id: 'scheduler',
    title: 'Scheduler and autonomy',
    description:
      'Cadence, quiet hours, wakeups, background lanes, and initiative triggers. Per-companion circadian '
      + 'cadence, rest window, and episodic policy root in each companion data dir.',
    ownerFileName: 'scheduler.json',
    currentOwnerFiles: ['scheduler.json'],
    schemaValidators: [
      { ownerFile: 'scheduler.json', validator: 'validateSchedulerConfig' },
    ],
    units: 'ms',
    scope: 'perCompanion',
    activationTier: 'required_when_enabled',
    failureScope: 'agent',
    applyMode: 'live',
    inheritance: 'companion_required',
    securityBounds: {
      codeOwnedFloor: false,
      codeOwnedCeiling: true,
      stricterNeverWeaker: false,
      description:
        'Cadence and enablement are operator-owned; resource ceilings that bound runaway lanes stay code-owned.',
    },
    relatedPaths: [
      { domain: 'economy', kind: 'constrains', description: 'Reflection and outreach budgets are named economy surfaces.' },
      { domain: 'models', kind: 'references', description: 'Reflection references a models.json purpose.' },
    ],
    garden: {
      tabId: 'scheduler',
      order: 4,
      title: 'Scheduler',
      description: 'Cadence, quiet hours, wakeups, lanes, and triggers.',
      relatedTabs: ['economy', 'models'],
    },
  },

  cogsec: {
    id: 'cogsec',
    title: 'Cognitive security and trust',
    description:
      'Intake, trust, disclosure, quarantine, persona conformance, screening, and approval policy. '
      + 'Consolidates trust-policy and intake-policy owners under one CogSec validator surface.',
    ownerFileName: 'cogsec.json',
    currentOwnerFiles: ['trust-policy.json', 'intake-policy.json'],
    schemaValidators: [
      { ownerFile: 'trust-policy.json', validator: 'loadTrustPolicyConfig' },
      { ownerFile: 'intake-policy.json', validator: 'validateIntakePolicy' },
    ],
    units: 'score',
    scope: 'global',
    activationTier: 'boot_critical',
    failureScope: 'runtime',
    applyMode: 'live',
    inheritance: 'global_only',
    securityBounds: {
      codeOwnedFloor: true,
      codeOwnedCeiling: false,
      stricterNeverWeaker: true,
      description:
        'Unknown policy data rejects. Code-owned security floors stay non-bypassable; Garden may expose '
        + 'stronger operator choices without offering unsafe downgrades.',
    },
    relatedPaths: [
      { domain: 'channels', kind: 'constrains', description: 'Trust and audience scope gate channel routing and disclosure.' },
      { domain: 'memory', kind: 'references', description: 'Disclosure controls how relationship projections surface.' },
    ],
    garden: {
      tabId: 'cogsec',
      order: 5,
      title: 'CogSec',
      description: 'Trust, intake, disclosure, quarantine, and persona policy.',
      relatedTabs: ['channels', 'memory'],
    },
  },

  economy: {
    id: 'economy',
    title: 'Charge, budgets, and resource stewardship',
    description:
      'Charge, quotas, fatigue reserves, paid-work budgets, and rate limits. Consumers request named '
      + 'budget surfaces; provider technical capacity stays in models and cadence stays in scheduler.',
    ownerFileName: 'economy.json',
    currentOwnerFiles: ['charge-policy.json'],
    schemaValidators: [
      { ownerFile: 'charge-policy.json', validator: 'validateChargePolicyConfig' },
    ],
    units: 'tokens',
    scope: 'perCompanion',
    activationTier: 'required_when_enabled',
    failureScope: 'feature',
    applyMode: 'live',
    inheritance: 'companion_required',
    securityBounds: {
      codeOwnedFloor: false,
      codeOwnedCeiling: true,
      stricterNeverWeaker: false,
      description:
        'Spend, quota, and attention budgets are operator-owned; hard resource ceilings that protect '
        + 'shared infrastructure remain code-owned and read-only.',
    },
    relatedPaths: [
      { domain: 'scheduler', kind: 'feeds', description: 'Lanes consume named budget surfaces.' },
      { domain: 'capabilities', kind: 'constrains', description: 'Capability grants bound which paid work is reachable.' },
    ],
    garden: {
      tabId: 'economy',
      order: 6,
      title: 'Economy',
      description: 'Charge, budgets, quotas, fatigue, and rate limits.',
      relatedTabs: ['scheduler', 'capabilities'],
    },
  },

  capabilities: {
    id: 'capabilities',
    title: 'Capabilities, skills, and roles',
    description:
      'Capability tier, tool grants, shard/subagent policy, role definitions, and skill enablement. '
      + 'Consolidates capability-tier, skills, and subagent-roles owners; extension-specific settings stay '
      + 'namespaced and reference shared core domains.',
    ownerFileName: 'capabilities.json',
    currentOwnerFiles: ['capability-tier.json', 'skills.json', 'subagent-roles.json'],
    schemaValidators: [
      { ownerFile: 'capability-tier.json', validator: 'loadCapabilityTierConfig' },
      { ownerFile: 'skills.json', validator: 'validateSkillsConfig' },
      { ownerFile: 'subagent-roles.json', validator: 'loadSubagentRolesConfig' },
    ],
    units: 'grant',
    scope: 'perCompanion',
    activationTier: 'boot_critical',
    failureScope: 'runtime',
    applyMode: 'component_restart',
    inheritance: 'companion_override',
    securityBounds: {
      codeOwnedFloor: true,
      codeOwnedCeiling: true,
      stricterNeverWeaker: true,
      description:
        'Shard/subagent concurrency, queue limits, tool grants, and shell policy are operator-tunable up '
        + 'to code-owned maxima; forbidden capabilities cannot be widened by an owner file.',
    },
    relatedPaths: [
      { domain: 'economy', kind: 'references', description: 'Paid-work grants reference economy budgets.' },
      { domain: 'models', kind: 'references', description: 'Subagent roles reference model purpose assignments.' },
    ],
    garden: {
      tabId: 'capabilities',
      order: 7,
      title: 'Capabilities',
      description: 'Tier, grants, skills, shard/subagent policy, and roles.',
      relatedTabs: ['economy', 'models'],
    },
  },
};

// ── Topology / authority / extension boundary ───────────────────────────────

/**
 * Owner files that are topology, authority, content, or namespaced extension
 * data rather than general settings (audit section 4.1). They are explicitly
 * outside the eight domains and may never be claimed by a domain descriptor.
 */
export const SETTINGS_NON_DOMAIN_OWNER_FILES: readonly string[] = [
  'companions.json',
  'fleet-auth.json',
  'mcp-servers.json',
  'satellites.json',
];

const SETTINGS_NON_DOMAIN_OWNER_FILE_SET: ReadonlySet<string> = new Set(
  SETTINGS_NON_DOMAIN_OWNER_FILES,
);

// ── Structural input for field resolution ───────────────────────────────────

/**
 * Minimal structural view of a settings contract field, so the registry can
 * resolve a field's domain without a value import of the contract module.
 */
interface SettingsFieldOwnerRef {
  readonly ownerFile: string;
}

/**
 * Index of field key to its owner-file reference. Accepts the
 * {@link SettingsContractData} `fields` map directly.
 */
export type SettingsFieldOwnerIndex = Readonly<Record<string, SettingsFieldOwnerRef>>;

// ── Registry validation (fail closed) ───────────────────────────────────────

export interface SettingsDomainRegistryGuardResult {
  ok: boolean;
  errors: string[];
}

function quoteList(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ');
}

/**
 * Validate the canonical domain registry. Fails closed on:
 * - unknown, missing, or duplicate domain ids;
 * - duplicate canonical file names or overlapping current owner files;
 * - invalid activation/security/apply/scope/inheritance metadata;
 * - Garden tab ids or orders that drift from the domain id/order;
 * - cross-domain references to unknown domains;
 * - any non-domain topology/authority/extension file claimed by a domain.
 *
 * Wired into the settings contract guard so `npm run verify:settings-contract`
 * continuously asserts the registry.
 */
/**
 * Wide structural shape used only to validate potentially programmatic or
 * corrupted domain descriptors. Enum-typed fields widen to `string` and the
 * nested metadata objects become optional so every defensive check inside
 * {@link verifySettingsDomainRegistry} is type-honest rather than tautological.
 * The canonical {@link SettingsDomainDescriptor} is always assignable to it.
 */
interface SettingsDomainDescriptorInput {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly ownerFileName: string;
  readonly currentOwnerFiles: readonly string[];
  readonly schemaValidators: readonly {
    readonly ownerFile: string;
    readonly validator: string;
  }[];
  readonly units: string;
  readonly scope: string;
  readonly activationTier: string;
  readonly failureScope: string;
  readonly applyMode: string;
  readonly inheritance: string;
  readonly securityBounds?: {
    readonly codeOwnedFloor: unknown;
    readonly codeOwnedCeiling: unknown;
    readonly stricterNeverWeaker: unknown;
    readonly description: string;
  };
  readonly relatedPaths: readonly {
    readonly domain: string;
    readonly kind: string;
    readonly description: string;
  }[];
  readonly garden?: {
    readonly tabId: string;
    readonly order: number;
    readonly title: string;
    readonly description: string;
    readonly relatedTabs: readonly string[];
  };
}

export function verifySettingsDomainRegistry(
  registry: Readonly<Record<string, SettingsDomainDescriptorInput>> = SETTINGS_DOMAIN_REGISTRY,
): SettingsDomainRegistryGuardResult {
  const errors: string[] = [];

  const presentIds = Object.keys(registry);
  const expectedIds = [...SETTINGS_DOMAIN_IDS];
  const presentSet = new Set(presentIds);
  for (const id of expectedIds) {
    if (!presentSet.has(id)) {
      errors.push(`Domain registry is missing canonical domain "${id}".`);
    }
  }
  const unknownIds = presentIds.filter(id => !SETTINGS_DOMAIN_ID_SET.has(id));
  if (unknownIds.length > 0) {
    errors.push(`Domain registry contains unknown domain ids: ${quoteList(unknownIds)}.`);
  }

  const canonicalFiles = new Map<string, string>();
  const currentFileOwner = new Map<string, string>();
  const gardenOrders = new Map<number, string>();
  const gardenTabIds = new Map<string, string>();
  for (const id of expectedIds) {
    const descriptor = registry[id];
    if (!descriptor) {
      continue;
    }
    if (descriptor.id !== id) {
      errors.push(`Domain "${id}" descriptor id "${descriptor.id}" does not match its key.`);
    }
    if (!descriptor.title.trim()) {
      errors.push(`Domain "${id}" is missing a title.`);
    }
    if (!descriptor.description.trim()) {
      errors.push(`Domain "${id}" is missing a description.`);
    }
    if (!isJsonFileName(descriptor.ownerFileName)) {
      errors.push(`Domain "${id}" canonical ownerFileName "${descriptor.ownerFileName}" is not a .json file name.`);
    }
    const previousCanonical = canonicalFiles.get(descriptor.ownerFileName);
    if (previousCanonical) {
      errors.push(
        `Canonical ownerFileName "${descriptor.ownerFileName}" is claimed by domains "${previousCanonical}" and "${id}".`,
      );
    } else {
      canonicalFiles.set(descriptor.ownerFileName, id);
    }
    if (descriptor.currentOwnerFiles.length === 0) {
      errors.push(`Domain "${id}" must list at least one current owner file.`);
    }
    if (!descriptor.schemaValidators.every(v => isJsonFileName(v.ownerFile) && v.validator.trim().length > 0)) {
      errors.push(`Domain "${id}" has a malformed schema validator entry.`);
    }
    if (descriptor.scope !== 'global' && descriptor.scope !== 'perCompanion') {
      errors.push(`Domain "${id}" has invalid scope "${descriptor.scope}".`);
    }
    if (!SETTINGS_ACTIVATION_TIER_SET.has(descriptor.activationTier)) {
      errors.push(`Domain "${id}" has invalid activationTier "${descriptor.activationTier}".`);
    }
    if (!SETTINGS_FAILURE_SCOPE_SET.has(descriptor.failureScope)) {
      errors.push(`Domain "${id}" has invalid failureScope "${descriptor.failureScope}".`);
    }
    if (!SETTINGS_APPLY_MODE_SET.has(descriptor.applyMode)) {
      errors.push(`Domain "${id}" has invalid applyMode "${descriptor.applyMode}".`);
    }
    if (!SETTINGS_DOMAIN_INHERITANCE_SET.has(descriptor.inheritance)) {
      errors.push(`Domain "${id}" has invalid inheritance "${descriptor.inheritance}".`);
    }
    const bounds = descriptor.securityBounds;
    if (
      bounds === undefined
      || typeof bounds.codeOwnedFloor !== 'boolean'
      || typeof bounds.codeOwnedCeiling !== 'boolean'
      || typeof bounds.stricterNeverWeaker !== 'boolean'
      || typeof bounds.description !== 'string'
      || bounds.description.trim().length === 0
    ) {
      errors.push(`Domain "${id}" has malformed security bounds.`);
    }
    for (const relation of descriptor.relatedPaths) {
      if (!SETTINGS_DOMAIN_ID_SET.has(relation.domain)) {
        errors.push(`Domain "${id}" references unknown related domain "${relation.domain}".`);
      }
      if (relation.kind !== 'feeds' && relation.kind !== 'constrains' && relation.kind !== 'references') {
        errors.push(`Domain "${id}" relation to "${relation.domain}" has invalid kind "${relation.kind}".`);
      }
      if (!relation.description.trim()) {
        errors.push(`Domain "${id}" relation to "${relation.domain}" is missing a description.`);
      }
    }
    const garden = descriptor.garden;
    if (!garden || garden.tabId !== id) {
      errors.push(`Domain "${id}" Garden tabId "${garden?.tabId ?? '<missing>'}" must equal the domain id.`);
    }
    if (typeof garden?.order !== 'number' || !Number.isInteger(garden.order) || garden.order < 0) {
      errors.push(`Domain "${id}" Garden order "${garden?.order}" must be a non-negative integer.`);
    } else {
      const previousOrder = gardenOrders.get(garden.order);
      if (previousOrder) {
        errors.push(`Garden tab order ${garden.order} is shared by "${previousOrder}" and "${id}".`);
      } else {
        gardenOrders.set(garden.order, id);
      }
    }
    if (garden?.tabId) {
      const previousTab = gardenTabIds.get(garden.tabId);
      if (previousTab && previousTab !== id) {
        errors.push(`Garden tabId "${garden.tabId}" is shared by "${previousTab}" and "${id}".`);
      } else {
        gardenTabIds.set(garden.tabId, id);
      }
    }
    for (const tab of garden?.relatedTabs ?? []) {
      if (!SETTINGS_DOMAIN_ID_SET.has(tab)) {
        errors.push(`Domain "${id}" Garden relatedTab "${tab}" is not a canonical domain.`);
      }
    }
    for (const file of descriptor.currentOwnerFiles) {
      if (!isJsonFileName(file)) {
        errors.push(`Domain "${id}" current owner file "${file}" is not a .json file name.`);
      }
      if (SETTINGS_NON_DOMAIN_OWNER_FILE_SET.has(file)) {
        errors.push(
          `Domain "${id}" claims topology/authority/extension file "${file}" which is explicitly outside the eight domains.`,
        );
      }
      const previousFileOwner = currentFileOwner.get(file);
      if (previousFileOwner && previousFileOwner !== id) {
        errors.push(
          `Current owner file "${file}" is claimed by domains "${previousFileOwner}" and "${id}".`,
        );
      } else {
        currentFileOwner.set(file, id);
      }
    }
  }

  if (gardenOrders.size !== expectedIds.length) {
    errors.push('Garden tab orders must cover each domain exactly once.');
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

// ── Resolution helpers ──────────────────────────────────────────────────────

export function assertSettingsDomainId(value: string): SettingsDomainId {
  if (!SETTINGS_DOMAIN_ID_SET.has(value)) {
    throw new Error(`Unknown settings domain "${value}"`);
  }
  return value as SettingsDomainId;
}

export function resolveSettingsDomainById(
  id: string,
  registry: Readonly<Record<string, SettingsDomainDescriptor>> = SETTINGS_DOMAIN_REGISTRY,
): SettingsDomainDescriptor {
  const descriptor = registry[id];
  if (!SETTINGS_DOMAIN_ID_SET.has(id) || !descriptor) {
    throw new Error(`Unknown settings domain "${id}"`);
  }
  return descriptor;
}

export function listSettingsDomains(
  registry: Readonly<Record<SettingsDomainId, SettingsDomainDescriptor>> = SETTINGS_DOMAIN_REGISTRY,
): readonly SettingsDomainDescriptor[] {
  return SETTINGS_DOMAIN_IDS.map(id => registry[id]);
}

const CURRENT_OWNER_FILE_TO_DOMAIN = (() => {
  const map = new Map<string, SettingsDomainId>();
  for (const id of SETTINGS_DOMAIN_IDS) {
    const descriptor = SETTINGS_DOMAIN_REGISTRY[id];
    for (const file of descriptor.currentOwnerFiles) {
      map.set(file, id);
    }
    map.set(descriptor.ownerFileName, id);
  }
  return map;
})();

/**
 * Resolve the domain that owns a given owner file today. Returns `undefined`
 * for topology/authority/extension files and any unknown file so callers fail
 * closed rather than guessing.
 */
export function resolveSettingsDomainForOwnerFile(
  ownerFile: string,
): SettingsDomainId | undefined {
  return CURRENT_OWNER_FILE_TO_DOMAIN.get(ownerFile);
}

/**
 * Resolve the canonical domain for a settings field. While settings.json is
 * still split incrementally, a shared Garden section whose id is already one
 * of the eight canonical domains supplies the field classification. Otherwise
 * the field's current owner file maps to a domain. Fields owned by a
 * non-domain topology/authority/extension file fail closed.
 */
export function resolveSettingsDomainForField(
  fieldKey: string,
  fields: SettingsFieldOwnerIndex,
): SettingsDomainId {
  const sectionId = SETTINGS_GARDEN_EXPOSURE_BY_KEY[fieldKey]?.sectionId;
  if (sectionId !== undefined && SETTINGS_DOMAIN_ID_SET.has(sectionId)) {
    return sectionId as SettingsDomainId;
  }
  const field = fields[fieldKey];
  if (!field) {
    throw new Error(`Settings field "${fieldKey}" is not present in the contract.`);
  }
  const domain = resolveSettingsDomainForOwnerFile(field.ownerFile);
  if (!domain) {
    throw new Error(
      `Settings field "${fieldKey}" owner file "${field.ownerFile}" is not a settings domain owner.`,
    );
  }
  return domain;
}

/**
 * Build a field-key → domain projection for every field in a contract. Used to
 * share one domain classification between runtime and Garden. Fields owned by
 * non-domain files are reported in `unresolved` so the caller fails closed
 * instead of silently dropping them.
 */
export interface SettingsFieldDomainProjection {
  readonly fieldDomains: Readonly<Record<string, SettingsDomainId>>;
  readonly unresolved: readonly string[];
}

export function buildSettingsFieldDomainProjection(
  fields: SettingsFieldOwnerIndex,
): SettingsFieldDomainProjection {
  const fieldDomains: Record<string, SettingsDomainId> = {};
  const unresolved: string[] = [];
  for (const fieldKey of Object.keys(fields)) {
    const sectionId = SETTINGS_GARDEN_EXPOSURE_BY_KEY[fieldKey]?.sectionId;
    if (sectionId !== undefined && SETTINGS_DOMAIN_ID_SET.has(sectionId)) {
      fieldDomains[fieldKey] = sectionId as SettingsDomainId;
      continue;
    }
    const field = fields[fieldKey];
    if (!field) {
      unresolved.push(fieldKey);
      continue;
    }
    const domain = resolveSettingsDomainForOwnerFile(field.ownerFile);
    if (domain) {
      fieldDomains[fieldKey] = domain;
    } else {
      unresolved.push(fieldKey);
    }
  }
  return { fieldDomains, unresolved };
}

// ── Garden projection ───────────────────────────────────────────────────────

export interface SettingsDomainGardenTab {
  readonly tabId: SettingsDomainId;
  readonly order: number;
  readonly title: string;
  readonly description: string;
  readonly relatedTabs: readonly SettingsDomainId[];
}

/**
 * Garden tabs for every domain, in canonical order, derived from the registry.
 * This is the single source Garden consults so domain tabs are never copied
 * into per-page config.
 */
export const SETTINGS_DOMAIN_GARDEN_TABS: readonly SettingsDomainGardenTab[] =
  SETTINGS_DOMAIN_IDS.map(id => {
    const garden = SETTINGS_DOMAIN_REGISTRY[id].garden;
    return {
      tabId: garden.tabId,
      order: garden.order,
      title: garden.title,
      description: garden.description,
      relatedTabs: garden.relatedTabs,
    };
  });

export function resolveSettingsDomainGardenMeta(
  domainId: SettingsDomainId,
): SettingsDomainGardenMeta {
  return resolveSettingsDomainById(domainId).garden;
}

/**
 * Resolve the Garden domain tab a field renders under, derived purely from the
 * registry. Garden rendering and runtime resolution therefore share one
 * domain descriptor per field.
 */
export function resolveSettingsFieldGardenDomainTab(
  fieldKey: string,
  fields: SettingsFieldOwnerIndex,
): SettingsDomainGardenTab {
  const domainId = resolveSettingsDomainForField(fieldKey, fields);
  const tab = SETTINGS_DOMAIN_GARDEN_TABS.find(entry => entry.tabId === domainId);
  if (!tab) {
    throw new Error(`No Garden tab registered for domain "${domainId}"`);
  }
  return tab;
}

/**
 * Stable projection served to Garden alongside the settings contract so the UI
 * receives per-field domain ownership and the canonical tab order from one
 * registry.
 */
export interface SettingsDomainGardenProjection {
  readonly domainIds: readonly SettingsDomainId[];
  readonly tabs: readonly SettingsDomainGardenTab[];
  readonly fieldDomains: Readonly<Record<string, SettingsDomainId>>;
  readonly unresolvedFields: readonly string[];
}

export function buildSettingsDomainGardenProjection(
  fields: SettingsFieldOwnerIndex,
): SettingsDomainGardenProjection {
  const projection = buildSettingsFieldDomainProjection(fields);
  return {
    domainIds: [...SETTINGS_DOMAIN_IDS],
    tabs: SETTINGS_DOMAIN_GARDEN_TABS,
    fieldDomains: projection.fieldDomains,
    unresolvedFields: projection.unresolved,
  };
}
