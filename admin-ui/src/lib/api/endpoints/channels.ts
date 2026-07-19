// E3.2 — Garden channel Context Envelope endpoints.

import { apiGet, apiPost } from '../client';
import type {
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
