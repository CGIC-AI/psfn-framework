export type OverlayDrawer = 'activity' | 'settings' | null;

export type ActivityFilter =
  | 'all'
  | 'messages'
  | 'artifacts'
  | 'approvals'
  | 'voice'
  | 'tools'
  | 'system'
  | 'errors';

export type MicMode = 'dictation' | 'voice';

export type SpriteState =
  | 'attentive'
  | 'speaking'
  | 'listening'
  | 'thinking'
  | 'tool_use'
  | 'error';

export type AttachmentKind = 'file' | 'image' | 'camera';

export interface PendingAttachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  mediaType: string;
  size: number;
}
