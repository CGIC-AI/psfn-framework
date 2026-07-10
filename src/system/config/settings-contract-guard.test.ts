import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as adminUiGardenContract from '../../../admin-ui/src/lib/settings-garden-contract.js';
import {
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

describe('settings contract guard', () => {
  it('keeps backend schema, Garden exposure metadata, and owner files aligned', () => {
    const result = verifySettingsContractGuard();
    expect(result).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('keeps the admin-ui Garden contract shim pinned to the shared canonical module', () => {
    expect(adminUiGardenContract.SETTINGS_GARDEN_FIELD_EXPOSURE).toBe(SETTINGS_GARDEN_FIELD_EXPOSURE);
    expect(adminUiGardenContract.SETTINGS_GARDEN_GENERIC_FIELD_TYPES).toBe(SETTINGS_GARDEN_GENERIC_FIELD_TYPES);
    expect(adminUiGardenContract.SETTINGS_GARDEN_SECTION_FIELDS).toBe(SETTINGS_GARDEN_SECTION_FIELDS);
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
    });
  });

  it('declares charge-policy as a raw-only owner-file subsystem', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.subsystems.chargePolicy).toEqual({
      id: 'chargePolicy',
      ownerFile: 'charge-policy.json',
      mode: 'raw_only',
    });
  });

  it('declares intake-policy as a raw-only owner-file subsystem', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.subsystems.intakePolicy).toEqual({
      id: 'intakePolicy',
      ownerFile: 'intake-policy.json',
      mode: 'raw_only',
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

// Sprint 10 / Workstream F2: the Home Assistant connection settings are the only
// runtime toggles the location/world surface adds to the settings contract
// (places.json stays a soft registry with no owner-file boot gate). These named
// assertions fail closed if a future change drops the HA fields' owner-file
// assignment, Garden exposure metadata, or seed defaults out of sync.
describe('home assistant connection settings compliance', () => {
  const HA_FIELD_KEYS = ['homeAssistantEnabled', 'homeAssistantBaseUrl'] as const;

  it('registers the HA connection settings as runtime-owned contract fields', () => {
    const contractData = buildSettingsContractData();

    expect(contractData.fields.homeAssistantEnabled).toEqual({
      key: 'homeAssistantEnabled',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'boolean',
    });
    expect(contractData.fields.homeAssistantBaseUrl).toEqual({
      key: 'homeAssistantBaseUrl',
      ownerSubsystem: 'runtime',
      ownerFile: 'settings.json',
      type: 'string',
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
    expect(seed.homeAssistantBaseUrl).toBe('');

    for (const key of HA_FIELD_KEYS) {
      expect(key in seed).toBe(true);
      expect(contractData.fields[key]).toBeDefined();
    }
  });
});
