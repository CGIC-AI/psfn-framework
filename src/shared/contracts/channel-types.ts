// ── Channel-agnostic message types ──

// 'companion' is the same-cluster inter-companion lane (sprint 10, W6): peer
// messages routed by the gateway enter the receiving agent as ordinary inbound
// channel turns so fatigue/trust apply with zero new mechanism.
// 'companion-ui' is the first-class named channel for the companion-ui PWA
// (bead 8ora): browser turns that reach the runtime via the satellite hub relay
// and the companion-ui WebSocket, authenticated server-side by their hub-device
// attachment (never a client-supplied channel-type header). Discord-SSO'd humans
// land bound to their canonical contact via the attachment's contact binding.
export const CHANNEL_TYPES = ['discord', 'terminal', 'api', 'telegram', 'multica', 'psfn-amica', 'companion', 'companion-ui'] as const;
export type ChannelType = typeof CHANNEL_TYPES[number];

interface ChannelPolicy {
  scheduledContinuity: boolean;
  liveWakeup: boolean;
}

/** Central policy authority for channel behavior consumed outside adapters. */
const CHANNEL_BEHAVIOR: Readonly<Record<ChannelType, ChannelPolicy>> = Object.freeze({
  discord: { scheduledContinuity: true, liveWakeup: true },
  terminal: { scheduledContinuity: true, liveWakeup: false },
  api: { scheduledContinuity: true, liveWakeup: true },
  telegram: { scheduledContinuity: true, liveWakeup: true },
  multica: { scheduledContinuity: false, liveWakeup: false },
  'psfn-amica': { scheduledContinuity: true, liveWakeup: true },
  companion: { scheduledContinuity: false, liveWakeup: false },
  'companion-ui': { scheduledContinuity: false, liveWakeup: true },
});

export function supportsScheduledContinuity(channelType: ChannelType): boolean {
  return CHANNEL_BEHAVIOR[channelType].scheduledContinuity;
}

export function supportsLiveWakeup(channelType: string | undefined): boolean {
  if (channelType === undefined) return true;
  if (channelType === 'subagent') return false;
  if (!(CHANNEL_TYPES as readonly string[]).includes(channelType)) return channelType === 'wyoming';
  return CHANNEL_BEHAVIOR[channelType as ChannelType].liveWakeup;
}
