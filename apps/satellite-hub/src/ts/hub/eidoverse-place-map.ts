import fs from "node:fs";

// Keep this identical to PLACE_ID_TOKEN_PATTERN in the framework's canonical
// src/shared/contracts/places-registry.ts contract. The Hub TypeScript project
// has an intentionally isolated rootDir and cannot import framework source.
const PLACE_ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface EidoverseWorldPlaceMapping {
  placeId: string;
  regions: Readonly<Record<string, string>>;
}

export interface EidoversePlaceMap {
  schemaVersion: 1;
  worlds: Readonly<Record<string, EidoverseWorldPlaceMapping>>;
}

export interface EidoversePlaceResolution {
  placeId?: string;
  contextNote?: string;
}

export function loadEidoversePlaceMap(filePath: string | undefined): EidoversePlaceMap | null {
  if (!filePath) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  return parseEidoversePlaceMap(raw);
}

export function parseEidoversePlaceMap(value: unknown): EidoversePlaceMap {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.worlds)) {
    throw new Error("Eidoverse place map must use schemaVersion 1 and contain a worlds object");
  }
  const worldEntries = Object.entries(value.worlds);
  if (worldEntries.length === 0) {
    throw new Error("Eidoverse place map must contain at least one world");
  }

  const worlds: Record<string, EidoverseWorldPlaceMapping> = Object.create(null) as Record<
    string,
    EidoverseWorldPlaceMapping
  >;
  for (const [world, mapping] of worldEntries) {
    requireExactLabel(world, "Eidoverse world");
    if (!isRecord(mapping)) {
      throw new Error(`Eidoverse world ${JSON.stringify(world)} mapping must be an object`);
    }
    const placeId = requirePlaceId(mapping.placeId, `Eidoverse world ${JSON.stringify(world)} placeId`);
    const regions = parseRegions(world, mapping.regions);
    worlds[world] = Object.freeze({ placeId, regions });
  }

  return Object.freeze({
    schemaVersion: 1,
    worlds: Object.freeze(worlds),
  });
}

export function resolveEidoversePlace(
  mapping: EidoversePlaceMap,
  world: string,
  region?: string,
): EidoversePlaceResolution {
  const worldMapping = mapping.worlds[world];
  if (!worldMapping) return {};
  if (region === undefined) return { placeId: worldMapping.placeId };

  const regionPlaceId = worldMapping.regions[region];
  if (regionPlaceId) return { placeId: regionPlaceId };
  return {
    placeId: worldMapping.placeId,
    contextNote: `Eidoverse region ${JSON.stringify(region)} in world ${JSON.stringify(world)} is not mapped to a more specific place; using the world's default place.`,
  };
}

function parseRegions(world: string, value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze(Object.create(null) as Record<string, string>);
  if (!isRecord(value)) {
    throw new Error(`Eidoverse world ${JSON.stringify(world)} regions must be an object`);
  }
  const regions: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [region, placeId] of Object.entries(value)) {
    requireExactLabel(region, `Eidoverse world ${JSON.stringify(world)} region`);
    regions[region] = requirePlaceId(
      placeId,
      `Eidoverse world ${JSON.stringify(world)} region ${JSON.stringify(region)} placeId`,
    );
  }
  return Object.freeze(regions);
}

function requirePlaceId(value: unknown, field: string): string {
  if (typeof value !== "string" || !PLACE_ID_TOKEN_PATTERN.test(value)) {
    throw new Error(`${field} must match the canonical places.json place ID pattern`);
  }
  return value;
}

function requireExactLabel(value: string, field: string): void {
  if (!value || value.trim() !== value) {
    throw new Error(`${field} label must be non-empty and have no surrounding whitespace`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
