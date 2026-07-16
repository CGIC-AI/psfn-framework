export const GARDEN_FORWARD_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'WS',
] as const;
export type GardenForwardMethod = typeof GARDEN_FORWARD_METHODS[number];

export type GardenWorkspaceScope =
  | 'personal_workspace'
  | 'governed_shared_workspace'
  | 'garden_surface';

export type GardenResourceArea =
  | 'action_pipe'
  | 'attachments'
  | 'audit'
  | 'autonomy'
  | 'beads'
  | 'channels'
  | 'channel_artifacts'
  | 'charges'
  | 'cognitive_security'
  | 'companion'
  | 'confirmations'
  | 'contacts'
  | 'devices'
  | 'diagnostics'
  | 'filesystem'
  | 'garden_ui'
  | 'graph'
  | 'identity'
  | 'images'
  | 'memory'
  | 'models'
  | 'personal_settings'
  | 'places'
  | 'prompts'
  | 'scheduler'
  | 'sessions'
  | 'shared_workspace'
  | 'shell'
  | 'skills'
  | 'telemetry'
  | 'values'
  | 'wiki';
