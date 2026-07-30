import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as adminUiGardenContract from '../../../admin-ui/src/lib/settings-garden-contract.js';
import {
  SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS,
  SETTINGS_GARDEN_FIELD_EXPOSURE,
  SETTINGS_GARDEN_GENERIC_FIELD_TYPES,
  SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY,
  SETTINGS_GARDEN_RAW_EDITOR_KEYS,
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
  SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS,
  SETTINGS_GARDEN_SECTION_FIELDS,
  listGardenSettingsFieldExposureKeys,
  listGardenSettingsOwnerFileCoverage,
  listGardenSettingsTunableFieldCoverage,
} from '../../shared/contracts/settings-garden-contract.js';
import { buildSettingsContractData } from './settings-contract.js';
import { verifySettingsContractGuard } from './settings-contract-guard.js';
import { validateCompanionsConfig } from './companions-config.js';
import { COMPANION_SETTINGS_OVERLAY_WHITELIST } from './settings-overlay.js';
import { isRecord } from '../../shared/utils/types.js';

function readSettingsSeed(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync('config/settings.seed.json', 'utf-8'));
  if (!isRecord(parsed)) {
    throw new Error('Canonical settings seed must contain a JSON object');
  }
  return parsed;
}

describe('settings contract guard', () => {
  it('keeps backend schema, Garden exposure metadata, and owner files aligned', () => {
    const result = verifySettingsContractGuard();
    expect(result).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('exposes the filesystem read page default as an advanced runtime setting', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.fsReadMaxBytes).toEqual({
      key: 'fsReadMaxBytes',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'integer',
      scope: 'global',
      minimum: 1,
      maximum: 200_000,
    });
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE.fsReadMaxBytes).toEqual({
      sectionId: 'analysis-workbench',
      surface: 'advanced',
    });
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS['analysis-workbench'])
      .toContain('fsReadMaxBytes');
    expect(readSettingsSeed().fsReadMaxBytes).toBe(100_000);
  });

  it('keeps the fleet Garden listener process-owned and out of companions settings authority', () => {
    const contractData = buildSettingsContractData();
    const companionsSeed: unknown = JSON.parse(
      readFileSync('config/companions.seed.json', 'utf-8'),
    );
    const fleet = validateCompanionsConfig(companionsSeed, 'config/companions.seed.json');

    expect(contractData.fields).not.toHaveProperty('gardenPort');
    expect(contractData.fields).not.toHaveProperty('ADMIN_PORT');
    for (const companion of fleet.companions) {
      expect(companion).not.toHaveProperty('gardenPort');
    }
  });

  it('keeps the admin-ui Garden contract shim pinned to the shared canonical module', () => {
    expect(adminUiGardenContract.SETTINGS_GARDEN_FIELD_EXPOSURE).toBe(SETTINGS_GARDEN_FIELD_EXPOSURE);
    expect(adminUiGardenContract.SETTINGS_GARDEN_GENERIC_FIELD_TYPES).toBe(SETTINGS_GARDEN_GENERIC_FIELD_TYPES);
    expect(adminUiGardenContract.SETTINGS_GARDEN_SECTION_FIELDS).toBe(SETTINGS_GARDEN_SECTION_FIELDS);
    expect(adminUiGardenContract.SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS).toBe(
      SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS,
    );
    expect(adminUiGardenContract.SETTINGS_GARDEN_RAW_EDITOR_KEYS).toBe(SETTINGS_GARDEN_RAW_EDITOR_KEYS);
    expect(adminUiGardenContract.SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY).toBe(
      SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
    );
    expect(adminUiGardenContract.SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY).toBe(
      SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY,
    );
    expect(adminUiGardenContract.SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS).toBe(SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS);
    expect(adminUiGardenContract.listGardenSettingsFieldExposureKeys).toBe(listGardenSettingsFieldExposureKeys);
    expect(adminUiGardenContract.listGardenSettingsOwnerFileCoverage).toBe(listGardenSettingsOwnerFileCoverage);
    expect(adminUiGardenContract.listGardenSettingsTunableFieldCoverage).toBe(listGardenSettingsTunableFieldCoverage);
  });

  it('records a global-vs-perCompanion scope for every settings field (dnll.1)', () => {
    const contractData = buildSettingsContractData();
    const overlayKeys = new Set<string>(COMPANION_SETTINGS_OVERLAY_WHITELIST);

    for (const field of Object.values(contractData.fields)) {
      expect(field.scope).toBe(overlayKeys.has(field.key) ? 'perCompanion' : 'global');
    }

    // Every whitelisted overlay key must exist in the contract and be per-companion.
    for (const key of overlayKeys) {
      expect(contractData.fields[key], `missing contract field for overlay key ${key}`).toBeDefined();
      expect(contractData.fields[key].scope).toBe('perCompanion');
    }

    // Representative cluster-global keys stay global.
    expect(contractData.fields.capabilityTier.scope).toBe('global');
    expect(contractData.fields.sessionHistoryBudgetPct.scope).toBe('global');
  });

  it('publishes per-companion image defaults with catalog-backed enum metadata', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.imageProvider).toEqual({
      key: 'imageProvider',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'enum',
      scope: 'perCompanion',
      enumValues: ['fal', 'comfyui'],
    });
    expect(contractData.fields.imageFalCreateModel).toMatchObject({
      type: 'enum',
      scope: 'perCompanion',
      enumValues: expect.arrayContaining(['xai/grok-imagine-image']),
    });
    expect(contractData.fields.imageFalEditModel).toMatchObject({
      type: 'enum',
      scope: 'perCompanion',
      enumValues: expect.arrayContaining(['xai/grok-imagine-image/quality/edit']),
    });
    expect(contractData.fields.imageSelfieEditModel).toMatchObject({
      type: 'enum',
      scope: 'perCompanion',
      enumValues: expect.arrayContaining(['xai/grok-imagine-image/quality/edit']),
    });
    for (const key of [
      'imageProvider',
      'imageFalCreateModel',
      'imageFalEditModel',
      'imageSelfieEditModel',
    ]) {
      expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.channels).toContain(key);
    }
  });

  it('publishes per-companion LLM/vision lane model selection (23pp)', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.modelPurposeSelection).toEqual({
      key: 'modelPurposeSelection',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'object',
      scope: 'perCompanion',
    });
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.llm).toContain('modelPurposeSelection');

    // MoA model choices ride the same per-companion selection rule.
    expect(contractData.fields.moaReferenceModels.scope).toBe('perCompanion');
    expect(contractData.fields.moaAggregatorModel.scope).toBe('perCompanion');
    // MoA enablement/limits stay global.
    expect(contractData.fields.moaEnabled.scope).toBe('global');

    // The catalog and its projections stay models.json-owned and global.
    expect(contractData.fields.modelCatalog.scope).toBe('global');
    expect(contractData.fields.modelCatalog.ownerFile).toBe('models.json');
    // Embedding identity stays global: dimensions are baked into shared pgvector schemas.
    expect(contractData.fields.embeddingModel.scope).toBe('global');
    expect(contractData.fields.embeddingDims.scope).toBe('global');
  });

  it('keeps the Garden tunable-setting inventory aligned to backend owner metadata', () => {
    const contractData = buildSettingsContractData();
    const inventory = listGardenSettingsTunableFieldCoverage();
    const inventoryKeys = inventory.map((entry) => entry.fieldKey);
    const nonDeprecatedContractKeys = Object.values(contractData.fields)
      .filter((field) => field.deprecated !== true)
      .map((field) => field.key)
      .sort();

    expect(inventoryKeys).toEqual(nonDeprecatedContractKeys);
    expect(inventoryKeys).toEqual(listGardenSettingsFieldExposureKeys());

    for (const entry of inventory) {
      const field = contractData.fields[entry.fieldKey];
      expect(field).toBeDefined();
      expect(SETTINGS_GARDEN_SECTION_FIELDS[entry.sectionId]).toContain(entry.fieldKey);

      if (entry.surface === 'advanced') {
        expect(field.ownerFile).toBe('settings.json');
      }
      if (entry.editorId === 'models') {
        expect(field.ownerFile).toBe('models.json');
      }
      if (entry.editorId === 'scheduler') {
        expect(field.ownerFile).toBe('scheduler.json');
      }
      if (entry.editorId === 'capabilities') {
        expect(field.ownerFile).toBe('capability-tier.json');
      }
    }
  });

  it('projects every advanced-surface field into its section for the generic "All Fields" editor', () => {
    // The generic advanced editor renders SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS,
    // independent of whether a field is present in the persisted runtime settings,
    // so admins can discover and edit settings still on their built-in defaults
    // (psfn-framework-zet.3). This projection must contain exactly the
    // advanced-surface fields and must never leak a custom-surface field, which
    // the runtime write path would reject as wrong_owner.
    const advancedByKey = new Map<string, string>();
    for (const [sectionId, keys] of Object.entries(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS)) {
      for (const key of keys) {
        expect(advancedByKey.has(key)).toBe(false); // no field lands in two sections
        advancedByKey.set(key, sectionId);
      }
    }

    // Every entry is advanced-surface and mapped to the section it declares.
    for (const [key, sectionId] of advancedByKey) {
      const exposure = SETTINGS_GARDEN_FIELD_EXPOSURE[
        key as keyof typeof SETTINGS_GARDEN_FIELD_EXPOSURE
      ];
      expect(exposure).toBeDefined();
      expect(exposure.surface).toBe('advanced');
      expect(exposure.sectionId).toBe(sectionId);
      // Advanced fields must also stay listed in the raw section index.
      expect(SETTINGS_GARDEN_SECTION_FIELDS[exposure.sectionId]).toContain(key);
    }

    // The projection is exactly the set of advanced-surface exposure keys.
    const expectedAdvancedKeys = Object.entries(SETTINGS_GARDEN_FIELD_EXPOSURE)
      .filter(([, exposure]) => exposure.surface === 'advanced')
      .map(([key]) => key)
      .sort();
    expect([...advancedByKey.keys()].sort()).toEqual(expectedAdvancedKeys);

    // Custom-surface fields keep their dedicated editors and must never appear.
    for (const customKey of [
      'modelCatalog',
      'capabilityTier',
      'customTokens',
      'salienceDecayIntervalMs',
      'episodicProcessingEnabled',
      'episodicProcessingInactivityThresholdMinutes',
    ]) {
      expect(advancedByKey.has(customKey)).toBe(false);
    }

    // High-impact fields that were previously invisible until first persisted
    // (absent from the seed settings.json) are now surfaced in their sections.
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.channels).toContain('promotedExtendedTools');
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.memory).toContain('emotionScoping');
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.memory).toContain('embeddingProvider');
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.sessions).toContain('sessionMirrorEnabled');
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.sessions).toContain('continuityMessageLimit');
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.sessions).toContain('observationMaskingWindow');
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.channels).toContain('imageWorkflows');
    expect(SETTINGS_GARDEN_ADVANCED_SECTION_FIELDS.channels).toContain('moaEnabled');
  });

  it('keeps the Garden owner-file inventory exact and aligned to backend subsystems', () => {
    const contractData = buildSettingsContractData();
    const inventory = listGardenSettingsOwnerFileCoverage();

    expect(inventory).toEqual([
      { rawEditorKey: 'settings', subsystemId: 'runtime', ownerFile: 'settings.json' },
      { rawEditorKey: 'models', subsystemId: 'models', ownerFile: 'models.json' },
      { rawEditorKey: 'providers', subsystemId: 'providers', ownerFile: 'providers.json' },
      { rawEditorKey: 'channels', subsystemId: 'channels', ownerFile: 'channels.json' },
      { rawEditorKey: 'skills', subsystemId: 'skills', ownerFile: 'skills.json' },
      { rawEditorKey: 'scheduler', subsystemId: 'scheduler', ownerFile: 'scheduler.json' },
      { rawEditorKey: 'trust-policy', subsystemId: 'trustPolicy', ownerFile: 'trust-policy.json' },
      { rawEditorKey: 'intake-policy', subsystemId: 'intakePolicy', ownerFile: 'intake-policy.json' },
      { rawEditorKey: 'capabilities', subsystemId: 'capabilities', ownerFile: 'capability-tier.json' },
      { rawEditorKey: 'charge-policy', subsystemId: 'chargePolicy', ownerFile: 'charge-policy.json' },
      { rawEditorKey: 'partner-affect-shadow', subsystemId: 'partnerAffectShadow', ownerFile: 'partner-affect-shadow.json' },
      { rawEditorKey: 'backup', subsystemId: 'backup', ownerFile: 'backup.json' },
    ]);

    for (const entry of inventory) {
      expect(contractData.subsystems[entry.subsystemId]).toEqual(
        expect.objectContaining({
          id: entry.subsystemId,
          ownerFile: entry.ownerFile,
        }),
      );
    }
  });

  it('declares channels as a raw-only owner-file subsystem', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.subsystems.channels).toEqual({
      id: 'channels',
      ownerFile: 'channels.json',
      mode: 'raw_only',
      scope: 'global',
    });
  });

  it('declares charge-policy as a raw-only owner-file subsystem', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.subsystems.chargePolicy).toEqual({
      id: 'chargePolicy',
      ownerFile: 'charge-policy.json',
      mode: 'raw_only',
      scope: 'perCompanion',
    });
  });

  it('declares intake-policy as a raw-only owner-file subsystem', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.subsystems.intakePolicy).toEqual({
      id: 'intakePolicy',
      ownerFile: 'intake-policy.json',
      mode: 'raw_only',
      scope: 'global',
    });
  });

  it('fails closed when a schema field loses Garden exposure metadata', () => {
    const contractData = buildSettingsContractData();
    const uiFieldExposureKeys = Object.keys(contractData.fields).filter((fieldKey) => fieldKey !== 'sessionHistoryBudgetPct');

    const result = verifySettingsContractGuard({
      contractData,
      uiFieldExposureKeys,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Field "sessionHistoryBudgetPct" is missing Garden UI exposure metadata.');
  });

  it('fails closed when an advanced Garden field drifts to a non-runtime owner', () => {
    const contractData = buildSettingsContractData();
    contractData.fields.sessionHistoryBudgetPct = {
      ...contractData.fields.sessionHistoryBudgetPct,
      ownerSubsystem: 'scheduler',
      ownerFile: contractData.subsystems.scheduler.ownerFile,
    };

    const result = verifySettingsContractGuard({ contractData });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'Advanced field "sessionHistoryBudgetPct" must remain runtime-owned because Garden advanced editors read from runtime config.',
    );
  });

  it('allows deprecated schema fields to stay out of Garden exposure metadata', () => {
    const contractData = buildSettingsContractData();
    const uiFieldExposureKeys = Object.keys(contractData.fields).filter((fieldKey) => (
      fieldKey !== 'primaryModel'
      && fieldKey !== 'webFetchLocalCrawlerEnabled'
    ));

    const result = verifySettingsContractGuard({
      contractData,
      uiFieldExposureKeys,
    });

    expect(result).toEqual({
      ok: true,
      errors: [],
    });
  });
});

describe('memory retrieval policy settings compliance', () => {
  it('exposes committed voice segmenter tuning through the Garden voice editor', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.voiceReplySegmenter).toEqual({
      key: 'voiceReplySegmenter',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'object',
      scope: 'global',
    });
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE.voiceReplySegmenter).toEqual({
      sectionId: 'voice',
      surface: 'advanced',
    });
    expect(SETTINGS_GARDEN_SECTION_FIELDS.voice).toContain('voiceReplySegmenter');

    const seed = readSettingsSeed();
    expect(seed.voiceReplySegmenter).toEqual({
      minSegmentLength: 24,
      maxBufferLength: 240,
    });
  });

  it('exposes strict wiki startup hydration tuning through the Garden memory editor', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.wikiStartupHydration).toEqual({
      key: 'wikiStartupHydration',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'object',
      scope: 'global',
    });
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE.wikiStartupHydration).toEqual({
      sectionId: 'memory',
      surface: 'advanced',
    });
    expect(SETTINGS_GARDEN_SECTION_FIELDS.memory).toContain('wikiStartupHydration');

    const seed = readSettingsSeed();
    expect(seed.wikiStartupHydration).toEqual({
      recentSessionLimit: 4,
      recentMessageLimit: 18,
      maxContextChars: 6_000,
    });
  });

  it('surfaces the strict settings.json policy as a Garden memory object editor', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.memoryRetrievalPolicy).toEqual({
      key: 'memoryRetrievalPolicy',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'object',
      scope: 'global',
    });
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE.memoryRetrievalPolicy).toEqual({
      sectionId: 'memory',
      surface: 'advanced',
    });
    expect(SETTINGS_GARDEN_SECTION_FIELDS.memory).toContain('memoryRetrievalPolicy');
  });

  it('surfaces lifecycle Kubernetes policy as one global Garden object editor', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.lifecycleKubernetes).toEqual({
      key: 'lifecycleKubernetes',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'object',
      scope: 'global',
    });
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE.lifecycleKubernetes).toEqual({
      sectionId: 'sessions',
      surface: 'advanced',
    });
    expect(SETTINGS_GARDEN_SECTION_FIELDS.sessions).toContain('lifecycleKubernetes');

    const seed = readSettingsSeed();
    expect(seed.lifecycleKubernetes).toEqual(expect.objectContaining({
      lifecycleCommandTimeoutMs: 30_000,
      operatorCommandTimeoutMs: 600_000,
      rolloutWaitTimeoutMs: 180_000,
      rollbackWaitTimeoutMs: 180_000,
      postRolloutValidationHistoryLimit: 20,
      rollbackHistoryLimit: 50,
    }));
  });

  it('ships every matrix knob in the canonical seed policy', () => {
    const seed = JSON.parse(readFileSync('config/settings.seed.json', 'utf-8')) as {
      memoryRetrievalPolicy?: Record<string, unknown>;
    };

    expect(seed.memoryRetrievalPolicy).toEqual(expect.objectContaining({
      typePolicies: expect.objectContaining({
        episodic: expect.any(Object),
        semantic: expect.any(Object),
        emotional: expect.any(Object),
        procedural: expect.any(Object),
        boundary: expect.any(Object),
        reflection: expect.any(Object),
        relational: expect.any(Object),
      }),
      proceduralTaskRetrievalPrior: 1.2,
      selectionCaps: { reflection: 2, procedural: 2 },
      nonTemporalRecencyFloor: 0.35,
      lexicalAugment: {
        pageSize: 256,
        maxScan: 2_048,
        selectedLimit: 12,
        minOverlap: 2,
        baseSimilarity: 0.62,
      },
      scoreGuaranteeMinK: 3,
      scoreGuaranteeFloor: 0.01,
      episodic: {
        scanLimit: 1_000,
        maxChains: 3,
        maxDepth: 2,
        maxEpisodesPerChain: 5,
        timelineLimit: 8,
        timelineScanLimit: 200,
        timelineMaxDepth: 1,
        timelineMaxEpisodesPerRoot: 3,
        arcScanLimit: 8,
        minRootMatchScore: 0.18,
        minRelatedMatchScore: 0.08,
      },
      emotionalIntensityPersistenceMaxMultiplier: 6,
    }));
  });
});

// Sprint 10 / Workstream F2: the Home Assistant connection settings are the only
// runtime toggles the location/world surface adds to the settings contract
// (places.json stays a soft registry with no owner-file boot gate). These named
// assertions fail closed if a future change drops the HA fields' owner-file
// assignment, Garden exposure metadata, or seed defaults out of sync.
describe('home assistant connection settings compliance', () => {
  const HA_FIELD_KEYS = ['homeAssistantEnabled'] as const;

  it('registers the HA connection settings as runtime-owned contract fields', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.homeAssistantEnabled).toEqual({
      key: 'homeAssistantEnabled',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'boolean',
      scope: 'global',
    });
    for (const key of HA_FIELD_KEYS) {
      expect(contractData.fields[key].deprecated).toBeUndefined();
    }
  });

  it('exposes the HA connection settings through Garden advanced metadata', () => {
    const exposureKeys = new Set(listGardenSettingsFieldExposureKeys());

    for (const key of HA_FIELD_KEYS) {
      expect(exposureKeys.has(key)).toBe(true);
      const exposure = SETTINGS_GARDEN_FIELD_EXPOSURE[key];
      expect(exposure.surface).toBe('advanced');
      // Advanced fields must land in a section the shared Garden contract renders.
      expect(SETTINGS_GARDEN_SECTION_FIELDS[exposure.sectionId]).toContain(key);
    }
  });

  it('keeps the HA connection settings covered by the contract guard with no gaps', () => {
    expect(verifySettingsContractGuard()).toEqual({ ok: true, errors: [] });

    const tunableKeys = listGardenSettingsTunableFieldCoverage().map((entry) => entry.fieldKey);
    for (const key of HA_FIELD_KEYS) {
      expect(tunableKeys).toContain(key);
    }
  });

  it('keeps settings.seed.json HA defaults in sync with the contract', () => {
    const seed = JSON.parse(readFileSync('config/settings.seed.json', 'utf-8')) as Record<string, unknown>;
    const contractData = buildSettingsContractData();

    expect(seed.homeAssistantEnabled).toBe(false);

    for (const key of HA_FIELD_KEYS) {
      expect(key in seed).toBe(true);
      expect(contractData.fields[key]).toBeDefined();
    }
  });
});
