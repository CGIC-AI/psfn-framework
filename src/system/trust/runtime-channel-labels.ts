// ── Runtime channel-owned envelope labels (E3.2) ──
// Process-wide holder for the channels.json `contextEnvelope.channels`
// section, mirroring the runtime-policy pattern (src/system/trust/
// runtime-policy.ts). Startup hydration loads channels.json fail-closed
// (loadRuntimeChannelsConfig -> parseChannelContextEnvelopeSection) and
// publishes the validated labels here; classifyChannelEnvelope consumes them
// as the HIGHEST-precedence source for a channel's privacy pair:
//   channel-owned label > operator trust-policy override > derived default.
// Contract: docs/context-envelope.md.

import type { ChannelEnvelopeLabel } from './context-envelope.js';

const EMPTY_LABELS: Readonly<Record<string, ChannelEnvelopeLabel>> = Object.freeze({});

let activeLabels: Readonly<Record<string, ChannelEnvelopeLabel>> = EMPTY_LABELS;

export function getRuntimeChannelEnvelopeLabels(): Readonly<Record<string, ChannelEnvelopeLabel>> {
  return activeLabels;
}

export function setRuntimeChannelEnvelopeLabels(
  labels: Record<string, ChannelEnvelopeLabel>,
): void {
  activeLabels = Object.freeze({ ...labels });
}

export function resetRuntimeChannelEnvelopeLabels(): void {
  activeLabels = EMPTY_LABELS;
}
