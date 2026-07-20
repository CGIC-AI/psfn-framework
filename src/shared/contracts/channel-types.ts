// ── Channel-agnostic message types ──

// 'companion' is the same-cluster inter-companion lane (sprint 10, W6): peer
// messages routed by the gateway enter the receiving agent as ordinary inbound
// channel turns so fatigue/trust apply with zero new mechanism.
// 'companion-ui' is the first-class named channel for the companion-ui PWA
// (bead 8ora): browser turns that reach the runtime via the satellite hub relay
// and the companion-ui WebSocket, authenticated server-side by their hub-device
// attachment (never a client-supplied channel-type header). Discord-SSO'd humans
// land bound to their canonical contact via the attachment's contact binding.
export const CHANNEL_TYPES = ['discord', 'terminal', 'api', 'telegram', 'psfn-amica', 'companion', 'companion-ui'] as const;
export type ChannelType = typeof CHANNEL_TYPES[number];
