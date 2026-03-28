import type {
  CompanionPresenceMetadata,
  EmbodimentPresenceMetadata,
  EmanationPresenceMetadata,
  SatellitePresenceMetadata,
} from './presence-metadata.js';
import { isRecord } from '../utils/types.js';

export interface ActiveEmanationStateResolution {
  presence?: CompanionPresenceMetadata;
  error?: string;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
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

function comparePresence(lhs: CompanionPresenceMetadata, rhs: CompanionPresenceMetadata): boolean {
  return JSON.stringify(lhs) === JSON.stringify(rhs);
}

function conflictError(): ActiveEmanationStateResolution {
  return {
    error: 'conflicting active emanation metadata',
  };
}

function hasPresenceMarkers(record: Record<string, unknown>): boolean {
  return typeof record.kind === 'string'
    || typeof record.presenceKind === 'string'
    || typeof record.embodimentId === 'string'
    || typeof record.embodiment_id === 'string'
    || typeof record.emanationId === 'string'
    || typeof record.emanation_id === 'string'
    || typeof record.isPrimary === 'boolean'
    || typeof record.primary === 'boolean'
    || typeof record.isActive === 'boolean'
    || typeof record.active === 'boolean';
}

function resolveRecord(record: Record<string, unknown>): ActiveEmanationStateResolution {
  const kind = readString(record, ['kind', 'presenceKind']);
  const isActive = readBoolean(record, ['isActive', 'active']);
  const isPrimary = readBoolean(record, ['isPrimary', 'primary']);
  const siteId = readString(record, ['siteId', 'site_id']);
  const channelId = readString(record, ['channelId', 'channel_id']);
  const companionId = readString(record, ['companionId', 'companion_id']);
  const label = readString(record, ['label', 'name']);

  const satelliteId = readString(record, ['satelliteId', 'satellite_id', 'id']);
  const embodimentId = readString(record, ['embodimentId', 'embodiment_id', 'id']);
  const emanationId = readString(record, ['emanationId', 'emanation_id', 'id']);
  const satelliteRef = readString(record, ['satelliteId', 'satellite_id']);
  const embodimentRef = readString(record, ['embodimentId', 'embodiment_id']);
  const emanationRef = readString(record, ['emanationId', 'emanation_id']);

  if (kind === 'satellite' || (satelliteId && !embodimentId && !emanationId)) {
    if (isActive === true || isPrimary === true) {
      return conflictError();
    }
    if (!satelliteId) return conflictError();
    const presence: SatellitePresenceMetadata = {
      kind: 'satellite',
      satelliteId,
      ...(siteId ? { siteId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(companionId ? { companionId } : {}),
      ...(label ? { label } : {}),
      ...(isPrimary !== undefined ? { isPrimary } : {}),
      ...(isActive !== undefined ? { isActive } : {}),
      ...(embodimentRef ? { embodimentId: embodimentRef } : {}),
      ...(emanationRef ? { emanationId: emanationRef } : {}),
    };
    return { presence };
  }

  if (kind === 'embodiment' || (embodimentId && !emanationId)) {
    if (isActive === true || isPrimary === false) {
      return conflictError();
    }
    if (!embodimentId) return conflictError();
    const presence: EmbodimentPresenceMetadata = {
      kind: 'embodiment',
      embodimentId,
      ...(siteId ? { siteId } : {}),
      ...(satelliteRef ? { satelliteId: satelliteRef } : {}),
      ...(channelId ? { channelId } : {}),
      ...(companionId ? { companionId } : {}),
      ...(label ? { label } : {}),
      isPrimary: true,
      ...(emanationRef ? { emanationId: emanationRef } : {}),
    };
    return { presence };
  }

  if (kind === 'emanation' || emanationId) {
    if (isPrimary === true || isActive === false) {
      return conflictError();
    }
    if (!emanationId) return conflictError();
    const presence: EmanationPresenceMetadata = {
      kind: 'emanation',
      emanationId,
      ...(siteId ? { siteId } : {}),
      ...(satelliteRef ? { satelliteId: satelliteRef } : {}),
      ...(embodimentRef ? { embodimentId: embodimentRef } : {}),
      ...(channelId ? { channelId } : {}),
      ...(companionId ? { companionId } : {}),
      ...(label ? { label } : {}),
      isActive: true,
    };
    return { presence };
  }

  return undefined;
}

export function resolveActiveEmanationState(value: unknown): ActiveEmanationStateResolution {
  if (!isRecord(value)) {
    return {};
  }

  const nested = isRecord(value.presence) ? resolveActiveEmanationState(value.presence) : undefined;
  const direct = hasPresenceMarkers(value) ? resolveRecord(value) : undefined;

  if (nested?.error) {
    return nested;
  }
  if (direct?.error) {
    return direct;
  }

  if (nested?.presence && direct?.presence && !comparePresence(nested.presence, direct.presence)) {
    return {
      error: 'conflicting active emanation metadata',
    };
  }

  if (nested?.presence) {
    return nested;
  }

  if (direct?.presence) {
    return direct;
  }

  return {};
}

export function resolveCanonicalEmbodimentContext(
  value: unknown,
): EmbodimentPresenceMetadata | undefined {
  const resolution = resolveActiveEmanationState(value);
  if (resolution.error || !resolution.presence) {
    return undefined;
  }

  const presence = resolution.presence;
  if (presence.kind === 'embodiment') {
    return presence;
  }

  if (presence.kind !== 'emanation' || !presence.embodimentId) {
    return undefined;
  }

  return {
    kind: 'embodiment',
    embodimentId: presence.embodimentId,
    ...(presence.siteId ? { siteId: presence.siteId } : {}),
    ...(presence.satelliteId ? { satelliteId: presence.satelliteId } : {}),
    ...(presence.channelId ? { channelId: presence.channelId } : {}),
    ...(presence.companionId ? { companionId: presence.companionId } : {}),
    ...(presence.label ? { label: presence.label } : {}),
    isPrimary: true,
  };
}
