import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSettingsContractData,
  ownerFileScope,
  type SettingsContractData,
  type SettingsSubsystemId,
} from './settings-contract.js';
import {
  SETTINGS_GARDEN_FIELD_EXPOSURE,
  SETTINGS_GARDEN_GENERIC_FIELD_TYPES,
  SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY,
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
  SETTINGS_GARDEN_RAW_SUBSYSTEM_IDS,
  listGardenSettingsFieldExposureKeys,
} from '../../shared/contracts/settings-garden-contract.js';
import {
  SETTINGS_FILE_NAME,
  type EditableSettings,
} from '../settings/contracts.js';
import { parseRuntimeSettingsOwnerPayload } from '../settings/schema.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  buildSettingsFieldDomainProjection,
  verifySettingsDomainRegistry,
} from './settings-domain-registry.js';

export interface SettingsContractGuardOptions {
  contractData?: SettingsContractData;
  uiFieldExposureKeys?: readonly string[];
  rawSubsystemIds?: readonly string[];
  /** When true (default), also assert the canonical domain registry. */
  verifyDomainRegistry?: boolean;
}

export interface SettingsContractGuardResult {
  ok: boolean;
  errors: string[];
}

/**
 * Resolve the default-bearing runtime fields from the canonical seed under the
 * same ownership contract Garden exposes. Optional fields without a seed value
 * remain optional; every future runtime field added with a seed default becomes
 * backfillable without a key-specific migration.
 */
export function loadRuntimeSettingsContractDefaults(
  seedDir: string,
  contractData: SettingsContractData = buildSettingsContractData(),
): EditableSettings {
  const seedPath = join(seedDir, 'settings.seed.json');
  const raw: unknown = JSON.parse(readFileSync(seedPath, 'utf8'));
  if (!isRecord(raw)) {
    throw new Error(`Canonical settings defaults at ${seedPath} must be an object`);
  }
  parseRuntimeSettingsOwnerPayload(raw);

  const defaults: EditableSettings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(contractData.fields, key)) {
      throw new Error(`Canonical settings default "${key}" has no settings contract field`);
    }
    const field = contractData.fields[key];
    if (!field) {
      throw new Error(`Canonical settings default "${key}" has no settings contract field`);
    }
    if (field.ownerFile !== SETTINGS_FILE_NAME || field.ownerSubsystem !== 'runtime') {
      throw new Error(
        `Canonical settings default "${key}" is owned by ${field.ownerFile}, not ${SETTINGS_FILE_NAME}`,
      );
    }
    if (!field.deprecated) {
      Object.assign(defaults, { [key]: structuredClone(value) });
    }
  }
  return defaults;
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

  if (options.verifyDomainRegistry !== false) {
    const domainResult = verifySettingsDomainRegistry();
    if (!domainResult.ok) {
      errors.push(...domainResult.errors);
    }
    // Every registered settings field must resolve to exactly one of the eight
    // canonical domains. A field whose owner file is topology/authority/
    // extension data, or which drifts out of the registry, fails closed.
    const domainProjection = buildSettingsFieldDomainProjection(contractData.fields);
    if (domainProjection.unresolved.length > 0) {
      errors.push(
        `Settings fields are owned by non-domain files: ${quoteList(domainProjection.unresolved)}.`,
      );
    }
  }

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
    // Per-companion vs cluster-global rooting must match the owner-file registry
    // (dnll.2). Catches a relocated owner file whose subsystem scope drifted.
    const expectedScope = ownerFileScope(ownerFile);
    if (subsystem.scope !== expectedScope) {
      errors.push(
        `Subsystem "${subsystemId}" owner file "${ownerFile}" is rooted `
        + `${expectedScope} but its contract scope is "${subsystem.scope}".`,
      );
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
    const exposure = SETTINGS_GARDEN_FIELD_EXPOSURE[
      fieldKey as keyof typeof SETTINGS_GARDEN_FIELD_EXPOSURE
    ];
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
    if (field.deprecated) {
      continue;
    }
    if (!uiFieldExposureKeys.has(fieldKey)) {
      errors.push(`Field "${fieldKey}" is missing Garden UI exposure metadata.`);
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
