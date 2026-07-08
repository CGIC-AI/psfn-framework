// E3.2 — Garden channel Context Envelope endpoints.

import { apiGet, apiPost } from '../client';

export type ChannelPrivacy = 'private' | 'invite_only' | 'public';
export type ContactTrackingMode = 'auto' | 'approval' | 'role_gated';
export type ChannelClassificationSource = 'channel_label' | 'operator_override' | 'derived_default';

export interface ChannelEnvelopeLabel {
  privacy?: ChannelPrivacy;
  broadcast?: boolean;
  contactTracking?: ContactTrackingMode;
  needsReview?: boolean;
}

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
}

export interface ChannelEnvelopeSaveResponse {
  ok: boolean;
  message: string;
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
