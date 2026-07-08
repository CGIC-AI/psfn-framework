import type { ChannelPrivacy } from '../../../../system/trust/context-envelope.js';
import type { SessionRoleEnvelopePreview } from '../../../../core/internal-role-envelopes/projections.js';

export interface AdminSessionRoleEnvelopePreview {
  sessionEntryId: number;
  preview: SessionRoleEnvelopePreview;
}

export interface AdminContinuityProvenanceView {
  sessionEntryId: number;
  turnId: string;
  continuityUserId: string;
  sourceChannelId: string;
  sourceVisibility: ChannelPrivacy;
  currentChannelId: string;
  currentVisibility: ChannelPrivacy;
  carriedAcrossChannels: boolean;
}
