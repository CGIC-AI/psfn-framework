import {
  resolveActiveEmanationState,
  type ActiveEmanationStateResolution,
} from './active-emanation-state.js';

export type PresenceKind = 'satellite' | 'embodiment' | 'emanation';

export interface SatellitePresenceMetadata {
  kind: 'satellite';
  satelliteId: string;
  companionId?: string;
  siteId?: string;
  channelId?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  embodimentId?: string;
  emanationId?: string;
}

export interface EmbodimentPresenceMetadata {
  kind: 'embodiment';
  embodimentId: string;
  companionId?: string;
  siteId?: string;
  channelId?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  satelliteId?: string;
  emanationId?: string;
}

export interface EmanationPresenceMetadata {
  kind: 'emanation';
  emanationId: string;
  companionId?: string;
  siteId?: string;
  channelId?: string;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  satelliteId?: string;
  embodimentId?: string;
}

export type CompanionPresenceMetadata =
  | SatellitePresenceMetadata
  | EmbodimentPresenceMetadata
  | EmanationPresenceMetadata;

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
  return resolveActiveEmanationState(value).presence;
}

export function resolvePresenceSubjectId(presence: CompanionPresenceMetadata | undefined): string | undefined {
  if (!presence) return undefined;
  if (presence.kind === 'satellite') return presence.satelliteId;
  if (presence.kind === 'embodiment') return presence.embodimentId;
  return presence.emanationId;
}

export function resolvePresenceMetadataResult(value: unknown): ActiveEmanationStateResolution {
  return resolveActiveEmanationState(value);
}
