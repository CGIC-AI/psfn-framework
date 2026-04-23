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
