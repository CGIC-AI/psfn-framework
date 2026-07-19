import type { ChannelPrivacy } from './trust-contracts.js';

export type PresenceKind = 'satellite' | 'embodiment' | 'emanation';

export interface SatellitePresenceMetadata {
  kind: 'satellite';
  satelliteId: string;
  companionId: string;
  siteId?: string;
  channelId?: string;
  channelPrivacy?: ChannelPrivacy;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  embodimentId?: string;
  emanationId?: string;
}

export interface EmbodimentPresenceMetadata {
  kind: 'embodiment';
  embodimentId: string;
  companionId: string;
  siteId?: string;
  channelId?: string;
  channelPrivacy?: ChannelPrivacy;
  label?: string;
  isPrimary?: boolean;
  isActive?: boolean;
  satelliteId?: string;
  emanationId?: string;
}

export interface EmanationPresenceMetadata {
  kind: 'emanation';
  emanationId: string;
  companionId: string;
  siteId?: string;
  channelId?: string;
  channelPrivacy?: ChannelPrivacy;
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
