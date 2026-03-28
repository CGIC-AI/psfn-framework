import { isRecord } from '../utils/types.js';

export type PresenceKind = 'satellite' | 'embodiment' | 'emanation';

interface PresenceBase {
  companionId?: string;
  siteId?: string;
  channelId?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
}

export interface SatellitePresenceMetadata extends PresenceBase {
  kind: 'satellite';
  satelliteId: string;
  embodimentId?: string;
  emanationId?: string;
}

export interface EmbodimentPresenceMetadata extends PresenceBase {
  kind: 'embodiment';
  embodimentId: string;
  satelliteId?: string;
  emanationId?: string;
}

export interface EmanationPresenceMetadata extends PresenceBase {
  kind: 'emanation';
  emanationId: string;
  satelliteId?: string;
  embodimentId?: string;
}

export type CompanionPresenceMetadata =
  | SatellitePresenceMetadata
  | EmbodimentPresenceMetadata
  | EmanationPresenceMetadata;

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function readBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return undefined;
}

function buildBasePresence(record: Record<string, unknown>): PresenceBase {
  return {
    ...(readString(record, ['companionId', 'companion_id'])
      ? { companionId: readString(record, ['companionId', 'companion_id']) }
      : {}),
    ...(readString(record, ['siteId', 'site_id']) ? { siteId: readString(record, ['siteId', 'site_id']) } : {}),
    ...(readString(record, ['channelId', 'channel_id']) ? { channelId: readString(record, ['channelId', 'channel_id']) } : {}),
    ...(readString(record, ['label', 'name']) ? { label: readString(record, ['label', 'name']) } : {}),
    ...(readBoolean(record, ['isPrimary', 'primary']) !== undefined
      ? { isPrimary: readBoolean(record, ['isPrimary', 'primary']) }
      : {}),
    ...(readBoolean(record, ['isActive', 'active']) !== undefined
      ? { isActive: readBoolean(record, ['isActive', 'active']) }
      : {}),
  };
}

export function buildSatellitePresenceMetadata(input: {
  satelliteId: string;
  siteId?: string;
  channelId?: string;
  companionId?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  embodimentId?: string;
  emanationId?: string;
}): SatellitePresenceMetadata {
  return {
    kind: 'satellite',
    satelliteId: input.satelliteId,
    ...(input.siteId ? { siteId: input.siteId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.companionId ? { companionId: input.companionId } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.embodimentId ? { embodimentId: input.embodimentId } : {}),
    ...(input.emanationId ? { emanationId: input.emanationId } : {}),
  };
}

export function buildEmbodimentPresenceMetadata(input: {
  embodimentId: string;
  siteId?: string;
  satelliteId?: string;
  channelId?: string;
  companionId?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  emanationId?: string;
}): EmbodimentPresenceMetadata {
  return {
    kind: 'embodiment',
    embodimentId: input.embodimentId,
    ...(input.siteId ? { siteId: input.siteId } : {}),
    ...(input.satelliteId ? { satelliteId: input.satelliteId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.companionId ? { companionId: input.companionId } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.emanationId ? { emanationId: input.emanationId } : {}),
  };
}

export function buildEmanationPresenceMetadata(input: {
  emanationId: string;
  siteId?: string;
  satelliteId?: string;
  embodimentId?: string;
  channelId?: string;
  companionId?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
}): EmanationPresenceMetadata {
  return {
    kind: 'emanation',
    emanationId: input.emanationId,
    ...(input.siteId ? { siteId: input.siteId } : {}),
    ...(input.satelliteId ? { satelliteId: input.satelliteId } : {}),
    ...(input.embodimentId ? { embodimentId: input.embodimentId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.companionId ? { companionId: input.companionId } : {}),
    ...(input.label ? { label: input.label } : {}),
    ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  };
}

export function normalizePresenceMetadata(value: unknown): CompanionPresenceMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nestedPresence = isRecord(value.presence) ? normalizePresenceMetadata(value.presence) : undefined;
  if (nestedPresence) {
    return nestedPresence;
  }

  const record = value;
  const kind = readString(record, ['kind', 'presenceKind']) as PresenceKind | undefined;
  const base = buildBasePresence(record);

  if (kind === 'satellite') {
    const satelliteId = readString(record, ['satelliteId', 'satellite_id', 'id']);
    if (!satelliteId) return undefined;
    return {
      kind: 'satellite',
      satelliteId,
      ...base,
      ...(readString(record, ['embodimentId', 'embodiment_id']) ? { embodimentId: readString(record, ['embodimentId', 'embodiment_id']) } : {}),
      ...(readString(record, ['emanationId', 'emanation_id']) ? { emanationId: readString(record, ['emanationId', 'emanation_id']) } : {}),
    };
  }

  if (kind === 'embodiment') {
    const embodimentId = readString(record, ['embodimentId', 'embodiment_id', 'id']);
    if (!embodimentId) return undefined;
    return {
      kind: 'embodiment',
      embodimentId,
      ...base,
      ...(readString(record, ['satelliteId', 'satellite_id']) ? { satelliteId: readString(record, ['satelliteId', 'satellite_id']) } : {}),
      ...(readString(record, ['emanationId', 'emanation_id']) ? { emanationId: readString(record, ['emanationId', 'emanation_id']) } : {}),
    };
  }

  if (kind === 'emanation') {
    const emanationId = readString(record, ['emanationId', 'emanation_id', 'id']);
    if (!emanationId) return undefined;
    return {
      kind: 'emanation',
      emanationId,
      ...base,
      ...(readString(record, ['satelliteId', 'satellite_id']) ? { satelliteId: readString(record, ['satelliteId', 'satellite_id']) } : {}),
      ...(readString(record, ['embodimentId', 'embodiment_id']) ? { embodimentId: readString(record, ['embodimentId', 'embodiment_id']) } : {}),
    };
  }

  const satelliteId = readString(record, ['satelliteId', 'satellite_id']);
  if (satelliteId) {
    return {
      kind: 'satellite',
      satelliteId,
      ...base,
      ...(readString(record, ['embodimentId', 'embodiment_id']) ? { embodimentId: readString(record, ['embodimentId', 'embodiment_id']) } : {}),
      ...(readString(record, ['emanationId', 'emanation_id']) ? { emanationId: readString(record, ['emanationId', 'emanation_id']) } : {}),
    };
  }

  const embodimentId = readString(record, ['embodimentId', 'embodiment_id']);
  if (embodimentId) {
    return {
      kind: 'embodiment',
      embodimentId,
      ...base,
      ...(readString(record, ['satelliteId', 'satellite_id']) ? { satelliteId: readString(record, ['satelliteId', 'satellite_id']) } : {}),
      ...(readString(record, ['emanationId', 'emanation_id']) ? { emanationId: readString(record, ['emanationId', 'emanation_id']) } : {}),
    };
  }

  const emanationId = readString(record, ['emanationId', 'emanation_id']);
  if (emanationId) {
    return {
      kind: 'emanation',
      emanationId,
      ...base,
      ...(readString(record, ['satelliteId', 'satellite_id']) ? { satelliteId: readString(record, ['satelliteId', 'satellite_id']) } : {}),
      ...(readString(record, ['embodimentId', 'embodiment_id']) ? { embodimentId: readString(record, ['embodimentId', 'embodiment_id']) } : {}),
    };
  }

  return undefined;
}

export function resolvePresenceSubjectId(presence: CompanionPresenceMetadata | undefined): string | undefined {
  if (!presence) return undefined;
  if (presence.kind === 'satellite') return presence.satelliteId;
  if (presence.kind === 'embodiment') return presence.embodimentId;
  return presence.emanationId;
}
