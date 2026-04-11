import type {
  CompanionPresenceMetadata,
  EmbodimentPresenceMetadata,
  EmanationPresenceMetadata,
  SatellitePresenceMetadata,
} from './presence-metadata.js';
import { isRecord } from '../../shared/utils/types.js';
import { normalizeChannelVisibility, type ChannelVisibility } from '../../system/trust/types.js';

export interface ActiveEmanationStateResolution {
  presence?: CompanionPresenceMetadata;
  error?: string;
}

export interface ActiveEmanationAuthoritySnapshot {
  sourceKey: string;
  presence: CompanionPresenceMetadata;
}

export interface ActiveEmanationAuthorityResolveOptions {
  sourceKey?: string;
  allowPrimaryEmbodimentHandoff?: boolean;
  handoffFromEmbodimentId?: string;
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

function readChannelPrivacy(record: Record<string, unknown>, keys: string[]): ChannelVisibility | undefined {
  for (const key of keys) {
    const value = normalizeChannelVisibility(record[key]);
    if (value) return value;
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

function resolveRecord(record: Record<string, unknown>): ActiveEmanationStateResolution | undefined {
  const kind = readString(record, ['kind', 'presenceKind']);
  const isActive = readBoolean(record, ['isActive', 'active']);
  const isPrimary = readBoolean(record, ['isPrimary', 'primary']);
  const siteId = readString(record, ['siteId', 'site_id']);
  const channelId = readString(record, ['channelId', 'channel_id']);
  const channelPrivacy = readChannelPrivacy(record, [
    'channelPrivacy',
    'channel_privacy',
    'privacyLevel',
    'visibility',
  ]);
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
    if (!satelliteId || !companionId) return conflictError();
    const presence: SatellitePresenceMetadata = {
      kind: 'satellite',
      satelliteId,
      companionId,
      ...(siteId ? { siteId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(channelPrivacy ? { channelPrivacy } : {}),
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
    if (!embodimentId || !companionId) return conflictError();
    const presence: EmbodimentPresenceMetadata = {
      kind: 'embodiment',
      embodimentId,
      companionId,
      ...(siteId ? { siteId } : {}),
      ...(satelliteRef ? { satelliteId: satelliteRef } : {}),
      ...(channelId ? { channelId } : {}),
      ...(channelPrivacy ? { channelPrivacy } : {}),
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
    if (!emanationId || !companionId) return conflictError();
    const presence: EmanationPresenceMetadata = {
      kind: 'emanation',
      emanationId,
      companionId,
      ...(siteId ? { siteId } : {}),
      ...(satelliteRef ? { satelliteId: satelliteRef } : {}),
      ...(embodimentRef ? { embodimentId: embodimentRef } : {}),
      ...(channelId ? { channelId } : {}),
      ...(channelPrivacy ? { channelPrivacy } : {}),
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

  if (presence.kind === 'satellite' && presence.embodimentId) {
    return {
      kind: 'embodiment',
      embodimentId: presence.embodimentId,
      companionId: presence.companionId,
      ...(presence.siteId ? { siteId: presence.siteId } : {}),
      ...(presence.satelliteId ? { satelliteId: presence.satelliteId } : {}),
      ...(presence.channelId ? { channelId: presence.channelId } : {}),
      ...(presence.channelPrivacy ? { channelPrivacy: presence.channelPrivacy } : {}),
      ...(presence.label ? { label: presence.label } : {}),
      isPrimary: true,
      ...(presence.emanationId ? { emanationId: presence.emanationId } : {}),
    };
  }

  if (presence.kind !== 'emanation' || !presence.embodimentId) {
    return undefined;
  }

  return {
    kind: 'embodiment',
    embodimentId: presence.embodimentId,
    companionId: presence.companionId,
    ...(presence.siteId ? { siteId: presence.siteId } : {}),
    ...(presence.satelliteId ? { satelliteId: presence.satelliteId } : {}),
    ...(presence.channelId ? { channelId: presence.channelId } : {}),
    ...(presence.channelPrivacy ? { channelPrivacy: presence.channelPrivacy } : {}),
    ...(presence.label ? { label: presence.label } : {}),
    isPrimary: true,
  };
}

export function resolveCanonicalSatelliteContext(
  value: unknown,
): SatellitePresenceMetadata | undefined {
  const resolution = resolveActiveEmanationState(value);
  if (resolution.error || !resolution.presence) {
    return undefined;
  }

  const presence = resolution.presence;
  if (presence.kind !== 'satellite') {
    return undefined;
  }

  return {
    kind: 'satellite',
    satelliteId: presence.satelliteId,
    companionId: presence.companionId,
    ...(presence.siteId ? { siteId: presence.siteId } : {}),
    ...(presence.channelId ? { channelId: presence.channelId } : {}),
    ...(presence.channelPrivacy ? { channelPrivacy: presence.channelPrivacy } : {}),
    ...(presence.label ? { label: presence.label } : {}),
    ...(presence.isPrimary !== undefined ? { isPrimary: presence.isPrimary } : {}),
    ...(presence.isActive !== undefined ? { isActive: presence.isActive } : {}),
    ...(presence.embodimentId ? { embodimentId: presence.embodimentId } : {}),
    ...(presence.emanationId ? { emanationId: presence.emanationId } : {}),
  };
}

interface ActiveEmbodiedPresenceState {
  sourceKey: string;
  presence: CompanionPresenceMetadata;
  embodimentContext: EmbodimentPresenceMetadata;
}

function normalizeSourceKey(sourceKey: string | undefined): string | undefined {
  const normalized = sourceKey?.trim();
  return normalized ? normalized : undefined;
}

function buildPrimaryEmbodimentHandoffError(
  currentEmbodimentId: string,
  nextEmbodimentId: string,
): ActiveEmanationStateResolution {
  return {
    error: `primary embodiment handoff required: ${currentEmbodimentId} -> ${nextEmbodimentId}`,
  };
}

function buildPrimaryEmbodimentHandoffMismatchError(
  expectedEmbodimentId: string,
  providedEmbodimentId: string,
): ActiveEmanationStateResolution {
  return {
    error: `primary embodiment handoff source mismatch: expected ${expectedEmbodimentId}, received ${providedEmbodimentId}`,
  };
}

export class ActiveEmanationAuthority {
  private bySource = new Map<string, CompanionPresenceMetadata>();
  private primaryEmbodiedState: ActiveEmbodiedPresenceState | null = null;

  resolve(
    value: unknown,
    options: ActiveEmanationAuthorityResolveOptions = {},
  ): ActiveEmanationStateResolution {
    const resolution = resolveActiveEmanationState(value);
    if (resolution.error) {
      return resolution;
    }

    const sourceKey = normalizeSourceKey(options.sourceKey);
    const sourcePresence = sourceKey ? this.bySource.get(sourceKey) : undefined;
    const incomingPresence = resolution.presence;
    if (!incomingPresence) {
      return sourcePresence ? { presence: sourcePresence } : {};
    }

    const embodimentContext = resolveCanonicalEmbodimentContext(incomingPresence);
    if (!sourceKey) {
      return { presence: incomingPresence };
    }

    if (!embodimentContext) {
      if (sourcePresence && resolveCanonicalEmbodimentContext(sourcePresence)) {
        return { presence: sourcePresence };
      }
      return { presence: incomingPresence };
    }

    const currentPrimary = this.primaryEmbodiedState;
    const nextEmbodimentId = embodimentContext.embodimentId;
    if (
      currentPrimary
      && currentPrimary.embodimentContext.embodimentId !== nextEmbodimentId
    ) {
      if (!options.allowPrimaryEmbodimentHandoff) {
        return buildPrimaryEmbodimentHandoffError(
          currentPrimary.embodimentContext.embodimentId,
          nextEmbodimentId,
        );
      }

      if (
        options.handoffFromEmbodimentId
        && options.handoffFromEmbodimentId !== currentPrimary.embodimentContext.embodimentId
      ) {
        return buildPrimaryEmbodimentHandoffMismatchError(
          currentPrimary.embodimentContext.embodimentId,
          options.handoffFromEmbodimentId,
        );
      }

      this.bySource.delete(currentPrimary.sourceKey);
    }

    this.bySource.set(sourceKey, incomingPresence);
    this.primaryEmbodiedState = {
      sourceKey,
      presence: incomingPresence,
      embodimentContext,
    };
    return { presence: incomingPresence };
  }

  clearSource(sourceKey: string): void {
    const normalized = normalizeSourceKey(sourceKey);
    if (!normalized) return;
    this.bySource.delete(normalized);
    if (this.primaryEmbodiedState?.sourceKey === normalized) {
      this.primaryEmbodiedState = null;
    }
  }

  captureSnapshot(): ActiveEmanationAuthoritySnapshot | undefined {
    if (!this.primaryEmbodiedState) {
      return undefined;
    }

    return {
      sourceKey: this.primaryEmbodiedState.sourceKey,
      presence: this.primaryEmbodiedState.presence,
    };
  }

  restoreSnapshot(snapshot: ActiveEmanationAuthoritySnapshot | undefined): ActiveEmanationStateResolution {
    if (!snapshot) {
      this.bySource.clear();
      this.primaryEmbodiedState = null;
      return {};
    }

    this.bySource.clear();
    this.primaryEmbodiedState = null;
    return this.resolve(snapshot.presence, {
      sourceKey: snapshot.sourceKey,
      allowPrimaryEmbodimentHandoff: true,
    });
  }
}
