export type OverlayDrawer = 'activity' | 'companions' | 'settings' | 'wishlist' | null;

export type ActivityFilter =
  | 'all'
  | 'messages'
  | 'artifacts'
  | 'approvals'
  | 'voice'
  | 'tools'
  | 'system'
  | 'errors';

export type SpriteState =
  | 'attentive'
  | 'speaking'
  | 'listening'
  | 'thinking'
  | 'tool_use'
  | 'error';
