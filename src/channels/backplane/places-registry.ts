import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AffordanceBackend,
  AffordanceConfig,
  AffordanceKind,
  AffordanceRole,
  PlaceConfig,
  PlaceKind,
  PlacesRegistryConfig,
  SiteConfig,
} from '../../shared/contracts/places-registry.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import { SATELLITE_REGISTRY_FILE_NAME } from '../../shared/contracts/satellite-registry.js';
import {
  AFFORDANCE_KINDS,
  PLACES_REGISTRY_FILE_NAME,
} from '../../shared/contracts/places-registry.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isRecord } from '../../shared/utils/types.js';

const ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PLACE_KINDS = new Set<string>(['physical', 'virtual']);
const AFFORDANCE_ROLES = new Set<string>(['perceiver', 'effector']);
const AFFORDANCE_BACKENDS = new Set<string>(['ha', 'satellite', 'vr']);
const AFFORDANCE_KIND_SET = new Set<string>(AFFORDANCE_KINDS);

export const EMPTY_PLACES_REGISTRY_CONFIG: PlacesRegistryConfig = Object.freeze({
  schemaVersion: 1,
  sites: [],
  places: [],
});

function parseConfiguredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const parsed = value.trim();
  if (!parsed) {
    throw new Error(`${fieldName} must not be empty`);
  }
  return parsed;
}

function parseOptionalConfiguredString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return parseConfiguredString(value, fieldName);
}

function assertIdToken(value: string, fieldName: string): string {
  if (!ID_TOKEN_PATTERN.test(value)) {
    throw new Error(`${fieldName} must use only letters, numbers, dot, underscore, dash, or colon`);
  }
  return value;
}

function parsePlaceKind(value: unknown, fieldName: string): PlaceKind {
  const parsed = parseConfiguredString(value, fieldName);
  if (!PLACE_KINDS.has(parsed)) {
    throw new Error(`${fieldName} must be one of: physical, virtual`);
  }
  return parsed as PlaceKind;
}

function parseAffordanceRole(value: unknown, fieldName: string): AffordanceRole {
  const parsed = parseConfiguredString(value, fieldName);
  if (!AFFORDANCE_ROLES.has(parsed)) {
    throw new Error(`${fieldName} must be one of: perceiver, effector`);
  }
  return parsed as AffordanceRole;
}

function parseAffordanceBackend(value: unknown, fieldName: string): AffordanceBackend {
  const parsed = parseConfiguredString(value, fieldName);
  if (!AFFORDANCE_BACKENDS.has(parsed)) {
    throw new Error(`${fieldName} must be one of: ha, satellite, vr`);
  }
  return parsed as AffordanceBackend;
}

function parseAffordanceKind(value: unknown, fieldName: string): AffordanceKind {
  const parsed = parseConfiguredString(value, fieldName);
  if (!AFFORDANCE_KIND_SET.has(parsed)) {
    throw new Error(`${fieldName} contains unknown affordance kind "${parsed}"`);
  }
  return parsed as AffordanceKind;
}

function parseControlVerbs(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error(`${fieldName} must contain only strings`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`${fieldName} must not contain empty strings`);
    }
    unique.add(trimmed);
  }
  if (unique.size === 0) {
    throw new Error(`${fieldName} must contain at least one value when present`);
  }
  return [...unique];
}

function parseAffordanceConfig(value: unknown, fieldName: string): AffordanceConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const affordanceId = assertIdToken(
    parseConfiguredString(value.affordanceId, `${fieldName}.affordanceId`),
    `${fieldName}.affordanceId`,
  );
  const role = parseAffordanceRole(value.role, `${fieldName}.role`);
  const kind = parseAffordanceKind(value.kind, `${fieldName}.kind`);
  const backend = parseAffordanceBackend(value.backend, `${fieldName}.backend`);
  const displayName = parseOptionalConfiguredString(value.displayName, `${fieldName}.displayName`);
  const entityId = parseOptionalConfiguredString(value.entityId, `${fieldName}.entityId`);
  const control = parseControlVerbs(value.control, `${fieldName}.control`);

  return {
    affordanceId,
    role,
    kind,
    backend,
    ...(displayName ? { displayName } : {}),
    ...(entityId ? { entityId } : {}),
    ...(control ? { control } : {}),
  };
}

function parseSiteConfig(value: unknown, fieldName: string): SiteConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return {
    siteId: assertIdToken(parseConfiguredString(value.siteId, `${fieldName}.siteId`), `${fieldName}.siteId`),
    displayName: parseConfiguredString(value.displayName, `${fieldName}.displayName`),
    kind: parsePlaceKind(value.kind, `${fieldName}.kind`),
  };
}

function parsePlaceConfig(value: unknown, fieldName: string): PlaceConfig {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  const placeId = assertIdToken(parseConfiguredString(value.placeId, `${fieldName}.placeId`), `${fieldName}.placeId`);
  const siteId = assertIdToken(parseConfiguredString(value.siteId, `${fieldName}.siteId`), `${fieldName}.siteId`);
  const displayName = parseConfiguredString(value.displayName, `${fieldName}.displayName`);
  const kind = parsePlaceKind(value.kind, `${fieldName}.kind`);
  const haAreaId = parseOptionalConfiguredString(value.haAreaId, `${fieldName}.haAreaId`);
  const description = parseOptionalConfiguredString(value.description, `${fieldName}.description`);
  if (value.affordances !== undefined && !Array.isArray(value.affordances)) {
    throw new Error(`${fieldName}.affordances must be an array`);
  }
  const affordanceValues = Array.isArray(value.affordances) ? value.affordances : [];
  const affordances = affordanceValues.map(
    (affordance, index) => parseAffordanceConfig(affordance, `${fieldName}.affordances[${index}]`),
  );

  const affordanceIds = new Set<string>();
  for (const affordance of affordances) {
    if (affordanceIds.has(affordance.affordanceId)) {
      throw new Error(`${fieldName} has duplicate affordanceId "${affordance.affordanceId}"`);
    }
    affordanceIds.add(affordance.affordanceId);
  }

  return {
    placeId,
    siteId,
    displayName,
    kind,
    ...(haAreaId ? { haAreaId } : {}),
    ...(description ? { description } : {}),
    affordances,
  };
}

function assertUniqueRegistryBindings(config: PlacesRegistryConfig): void {
  const siteIds = new Set<string>();
  for (const site of config.sites) {
    if (siteIds.has(site.siteId)) {
      throw new Error(`${PLACES_REGISTRY_FILE_NAME} has duplicate siteId "${site.siteId}"`);
    }
    siteIds.add(site.siteId);
  }

  const placeIds = new Set<string>();
  for (const place of config.places) {
    if (placeIds.has(place.placeId)) {
      throw new Error(`${PLACES_REGISTRY_FILE_NAME} has duplicate placeId "${place.placeId}"`);
    }
    placeIds.add(place.placeId);
    if (!siteIds.has(place.siteId)) {
      throw new Error(`${PLACES_REGISTRY_FILE_NAME} place "${place.placeId}" references unknown siteId "${place.siteId}"`);
    }
  }
}

export function parsePlacesRegistryConfig(
  rawConfig: unknown,
  sourceLabel = PLACES_REGISTRY_FILE_NAME,
): PlacesRegistryConfig {
  if (!isRecord(rawConfig)) {
    throw new Error(`${sourceLabel} must contain a JSON object at the root`);
  }
  if (rawConfig.schemaVersion !== 1) {
    throw new Error(`${sourceLabel}.schemaVersion must be 1`);
  }
  if (rawConfig.sites !== undefined && !Array.isArray(rawConfig.sites)) {
    throw new Error(`${sourceLabel}.sites must be an array`);
  }
  if (rawConfig.places !== undefined && !Array.isArray(rawConfig.places)) {
    throw new Error(`${sourceLabel}.places must be an array`);
  }
  const siteValues = Array.isArray(rawConfig.sites) ? rawConfig.sites : [];
  const placeValues = Array.isArray(rawConfig.places) ? rawConfig.places : [];
  const sites = siteValues.map((site, index) => parseSiteConfig(site, `${sourceLabel}.sites[${index}]`));
  const places = placeValues.map((place, index) => parsePlaceConfig(place, `${sourceLabel}.places[${index}]`));

  const config: PlacesRegistryConfig = {
    schemaVersion: 1,
    sites,
    places,
  };
  assertUniqueRegistryBindings(config);
  return config;
}

export function loadPlacesRegistryConfig(dataDir: string): PlacesRegistryConfig {
  const filePath = join(dataDir, PLACES_REGISTRY_FILE_NAME);
  if (!existsSync(filePath)) {
    return EMPTY_PLACES_REGISTRY_CONFIG;
  }

  try {
    const text = readFileSync(filePath, 'utf8');
    return parsePlacesRegistryConfig(JSON.parse(text), PLACES_REGISTRY_FILE_NAME);
  } catch (error) {
    throw new Error(`Failed to load places registry from ${filePath}: ${toErrorMessage(error)}`);
  }
}

export function resolvePlaceById(
  registry: PlacesRegistryConfig,
  placeId: string,
): PlaceConfig | undefined {
  return registry.places.find((place) => place.placeId === placeId);
}

export function resolveSiteById(
  registry: PlacesRegistryConfig,
  siteId: string,
): SiteConfig | undefined {
  return registry.sites.find((site) => site.siteId === siteId);
}

export function resolveAffordancesForPlace(
  registry: PlacesRegistryConfig,
  placeId: string,
): AffordanceConfig[] {
  return resolvePlaceById(registry, placeId)?.affordances ?? [];
}

/**
 * Fail-closed cross-registry check: every satellite that declares a static
 * `placeId` must resolve to a place in `places.json`. A bound placeId with an
 * absent or EMPTY places registry resolves nothing and therefore throws — this
 * single rule covers both unknown-placeId and missing-places.json. Satellites
 * with no `placeId` are unaffected (binding is opt-in and static-only).
 *
 * Wire this at every entrypoint that loads both registries so agent and gateway
 * boot paths reject the same misconfiguration.
 */
export function assertSatellitePlaceBindings(
  satelliteRegistry: SatelliteRegistryConfig,
  placesRegistry: PlacesRegistryConfig,
): void {
  for (const satellite of satelliteRegistry.satellites) {
    if (satellite.placeId === undefined) continue;
    if (!resolvePlaceById(placesRegistry, satellite.placeId)) {
      throw new Error(
        `${SATELLITE_REGISTRY_FILE_NAME} satellite "${satellite.satelliteId}" binds to placeId `
        + `"${satellite.placeId}" which does not exist in ${PLACES_REGISTRY_FILE_NAME}`,
      );
    }
  }
}
