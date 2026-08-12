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

export const GARDEN_WORKSPACE_SCOPES = [
  'personal_workspace',
  'governed_shared_workspace',
  'garden_surface',
] as const;
export type GardenWorkspaceScope = typeof GARDEN_WORKSPACE_SCOPES[number];

export const GARDEN_RESOURCE_AREAS = [
  'action_pipe',
  'attachments',
  'audit',
  'automata',
  'autonomy',
  'beads',
  'channels',
  'channel_artifacts',
  'charges',
  'cognitive_security',
  'companion',
  'confirmations',
  'contacts',
  'devices',
  'diagnostics',
  'filesystem',
  'garden_ui',
  'graph',
  'identity',
  'images',
  'memory',
  'models',
  'personal_settings',
  'places',
  'prompts',
  'scheduler',
  'sessions',
  'shared_workspace',
  'shell',
  'skills',
  'telemetry',
  'values',
  'wiki',
] as const;
export type GardenResourceArea = typeof GARDEN_RESOURCE_AREAS[number];
