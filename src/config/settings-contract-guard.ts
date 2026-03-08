import { createRequire } from 'node:module';
import {
  buildSettingsContractData,
  type SettingsContractData,
  type SettingsSubsystemId,
} from './settings-contract.js';

interface GardenSettingsFieldExposure {
  sectionId: string;
  surface: 'advanced' | 'custom';
  editorId?: string;
}

interface SettingsGardenContractModule {
  SETTINGS_GARDEN_FIELD_EXPOSURE: Record<string, GardenSettingsFieldExposure | undefined>;
  SETTINGS_GARDEN_GENERIC_FIELD_TYPES: readonly string[];
  SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY: Record<string, string>;
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY: Record<string, SettingsSubsystemId>;
  SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS: readonly string[];
  listGardenSettingsFieldExposureKeys: () => string[];
}

const require = createRequire(import.meta.url);
const settingsGardenContract = require('../../admin-ui/src/lib/settings-garden-contract.ts') as SettingsGardenContractModule;
const {
  SETTINGS_GARDEN_FIELD_EXPOSURE,
  SETTINGS_GARDEN_GENERIC_FIELD_TYPES,
  SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY,
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
  SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS,
  listGardenSettingsFieldExposureKeys,
} = settingsGardenContract;

export interface SettingsContractGuardOptions {
  contractData?: SettingsContractData;
  uiFieldExposureKeys?: readonly string[];
  rawSubsystemIds?: readonly string[];
}

export interface SettingsContractGuardResult {
  ok: boolean;
  errors: string[];
}

function quoteList(values: readonly string[]): string {
  return values.map(value => `"${value}"`).join(', ');
}

export function verifySettingsContractGuard(
  options: SettingsContractGuardOptions = {},
): SettingsContractGuardResult {
  const contractData = options.contractData ?? buildSettingsContractData();
  const uiFieldExposureKeys = new Set(
    options.uiFieldExposureKeys
      ?? listGardenSettingsFieldExposureKeys(),
  );
  const rawSubsystemIds = new Set(
    options.rawSubsystemIds
      ?? SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS,
  );
  const genericFieldTypes = new Set<string>(SETTINGS_GARDEN_GENERIC_FIELD_TYPES);
  const errors: string[] = [];

  const subsystemIds = new Set<SettingsSubsystemId>(
    Object.keys(contractData.subsystems) as SettingsSubsystemId[],
  );
  const rawEditorOwnerFiles = new Map<SettingsSubsystemId, string>();
  for (const [rawEditorKey, subsystemId] of Object.entries(
    SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
  ) as Array<[keyof typeof SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY, SettingsSubsystemId]>) {
    const previousOwnerFile = rawEditorOwnerFiles.get(subsystemId);
    if (previousOwnerFile) {
      errors.push(`Garden raw editor metadata defines multiple raw editors for subsystem "${subsystemId}".`);
      continue;
    }
    rawEditorOwnerFiles.set(
      subsystemId,
      SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY[rawEditorKey],
    );
  }
  const ownerFiles = new Map<string, SettingsSubsystemId>();
  for (const [subsystemId, subsystem] of Object.entries(contractData.subsystems) as Array<
    [SettingsSubsystemId, SettingsContractData['subsystems'][SettingsSubsystemId]]
  >) {
    const ownerFile = subsystem.ownerFile.trim();
    if (!ownerFile) {
      errors.push(`Subsystem "${subsystemId}" is missing ownerFile metadata.`);
      continue;
    }
    const previousOwner = ownerFiles.get(ownerFile);
    if (previousOwner && previousOwner !== subsystemId) {
      errors.push(
        `Owner file "${ownerFile}" is claimed by multiple subsystems: "${previousOwner}" and "${subsystemId}".`,
      );
      continue;
    }
    ownerFiles.set(ownerFile, subsystemId);

    const rawEditorOwnerFile = rawEditorOwnerFiles.get(subsystemId);
    if (!rawEditorOwnerFile) {
      continue;
    }
    if (rawEditorOwnerFile !== ownerFile) {
      errors.push(
        `Garden raw editor owner file "${rawEditorOwnerFile}" does not match subsystem `
        + `"${subsystemId}" owner file "${ownerFile}".`,
      );
    }
  }

  for (const [fieldKey, field] of Object.entries(contractData.fields)) {
    const exposure = SETTINGS_GARDEN_FIELD_EXPOSURE[fieldKey];
    if (!subsystemIds.has(field.ownerSubsystem)) {
      errors.push(`Field "${fieldKey}" references unknown owner subsystem "${field.ownerSubsystem}".`);
      continue;
    }
    const subsystem = contractData.subsystems[field.ownerSubsystem];
    if (field.ownerFile !== subsystem.ownerFile) {
      errors.push(
        `Field "${fieldKey}" owner file "${field.ownerFile}" does not match subsystem `
        + `"${field.ownerSubsystem}" owner file "${subsystem.ownerFile}".`,
      );
    }
    if (!uiFieldExposureKeys.has(fieldKey)) {
      errors.push(`Field "${fieldKey}" is missing Garden UI exposure metadata.`);
    }
    if (!exposure) {
      errors.push(`Field "${fieldKey}" is missing detailed Garden exposure metadata.`);
      continue;
    }
    if (exposure.surface === 'advanced') {
      if (field.ownerSubsystem !== 'runtime') {
        errors.push(
          `Advanced field "${fieldKey}" must remain runtime-owned because Garden advanced editors read from runtime config.`,
        );
      }
      if (!genericFieldTypes.has(field.type)) {
        errors.push(`Advanced field "${fieldKey}" uses unsupported Garden generic field type "${field.type}".`);
      }
    }
    if (exposure.surface === 'custom' && !exposure.editorId) {
      errors.push(`Custom field "${fieldKey}" is missing a Garden custom editor binding.`);
    }
    if (field.ownerSubsystem === 'runtime' && !genericFieldTypes.has(field.type)) {
      errors.push(`Runtime field "${fieldKey}" uses unsupported Garden generic field type "${field.type}".`);
    }
  }

  const contractFieldKeys = new Set(Object.keys(contractData.fields));
  const unknownUiFields = [...uiFieldExposureKeys]
    .filter((fieldKey) => !contractFieldKeys.has(fieldKey))
    .sort();
  if (unknownUiFields.length > 0) {
    errors.push(
      `Garden UI exposure metadata references fields missing from backend schema: ${quoteList(unknownUiFields)}.`,
    );
  }

  const missingRawSubsystems = [...subsystemIds]
    .filter((subsystemId) => !rawSubsystemIds.has(subsystemId))
    .sort();
  if (missingRawSubsystems.length > 0) {
    errors.push(
      `Garden raw settings editors are missing subsystem coverage for: ${quoteList(missingRawSubsystems)}.`,
    );
  }

  const unknownRawSubsystems = [...rawSubsystemIds]
    .filter((subsystemId) => !subsystemIds.has(subsystemId as SettingsSubsystemId))
    .sort();
  if (unknownRawSubsystems.length > 0) {
    errors.push(
      `Garden raw settings editors reference unknown subsystems: ${quoteList(unknownRawSubsystems)}.`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export const SETTINGS_CONTRACT_GARDEN_FIELD_EXPOSURE = SETTINGS_GARDEN_FIELD_EXPOSURE;
