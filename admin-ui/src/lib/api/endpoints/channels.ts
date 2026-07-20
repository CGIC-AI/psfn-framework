// E3.2 — Garden channel Context Envelope endpoints.
// jp36.6.2 — invite-only → public click-to-accept demotion flow.

import { apiGet, apiPost } from '../client';
import type {
  ChannelClassificationEpoch as CanonicalChannelClassificationEpoch,
  ChannelEnvelopeLabel as CanonicalChannelEnvelopeLabel,
  ChannelPrivacy as CanonicalChannelPrivacy,
  ContactTrackingMode as CanonicalContactTrackingMode,
} from '../../../../../src/system/trust/context-envelope.js';
import type {
  ChannelClassificationSource as CanonicalChannelClassificationSource,
} from '../../../../../src/system/trust/policy.js';

export type ChannelPrivacy = CanonicalChannelPrivacy;
export type ContactTrackingMode = CanonicalContactTrackingMode;
export type ChannelClassificationSource = CanonicalChannelClassificationSource;
export type ChannelClassificationEpoch = CanonicalChannelClassificationEpoch;

export type ChannelEnvelopeLabel = CanonicalChannelEnvelopeLabel;

export interface ChannelEnvelopeRow {
  channelId: string;
  privacy: ChannelPrivacy;
  broadcast: boolean;
  contactTracking: ContactTrackingMode;
  source: ChannelClassificationSource;
  needsReview: boolean;
  hasLabel: boolean;
  label?: ChannelEnvelopeLabel;
}

export interface ChannelEnvelopeData {
  channels: ChannelEnvelopeRow[];
  prefixOverrides: Record<string, string>;
  privatePrefixes: string[];
  broadcastPrefixes: string[];
  /** Operator-signed invite-only → public epoch boundaries, newest first. */
  epochs: ChannelClassificationEpoch[];
}

export interface ChannelEnvelopeSaveResponse {
  ok: boolean;
  message: string;
  data: ChannelEnvelopeData;
}

/** Click-to-accept demotion notice for one channel (jp36.6.2). */
export interface ChannelDemotionNotice {
  channelId: string;
  currentPrivacy: ChannelPrivacy;
  from: 'invite_only';
  to: 'public';
  demotable: boolean;
  reason?: string;
  notice: string;
  noticeVersion: string;
}

export interface ChannelDemotionResponse {
  ok: boolean;
  message: string;
  epoch?: ChannelClassificationEpoch;
  data: ChannelEnvelopeData;
}

export function getChannelEnvelopeData(): Promise<ChannelEnvelopeData> {
  return apiGet<ChannelEnvelopeData>('/api/admin/channels/context-envelope');
}

export function saveChannelEnvelopeLabel(
  channelId: string,
  label: ChannelEnvelopeLabel | null,
): Promise<ChannelEnvelopeSaveResponse> {
  return apiPost<ChannelEnvelopeSaveResponse>('/api/admin/channels/context-envelope', {
    channelId,
    label,
  });
}

export function getChannelDemotionNotice(channelId: string): Promise<ChannelDemotionNotice> {
  return apiGet<ChannelDemotionNotice>(
    `/api/admin/channels/context-envelope/demotion-notice?channelId=${encodeURIComponent(channelId)}`,
  );
}

export function demoteChannelToPublic(
  channelId: string,
  acknowledgedNoticeVersion: string,
): Promise<ChannelDemotionResponse> {
  return apiPost<ChannelDemotionResponse>('/api/admin/channels/context-envelope/demote', {
    channelId,
    acknowledgedNoticeVersion,
  });
}
