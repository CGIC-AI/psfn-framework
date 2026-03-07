export interface NavItem {
  path: string;
  gardenName: string;
  technicalName: string;
  icon: string;
}

export const navItems: NavItem[] = [
  { path: '/garden', gardenName: 'The Trunk', technicalName: 'Dashboard', icon: '\u{1F333}' },
  { path: '/garden/memory', gardenName: 'The Roots', technicalName: 'Memory', icon: '\u{1F33F}' },
  { path: '/garden/sessions', gardenName: 'The Branches', technicalName: 'Sessions', icon: '\u{1F332}' },
  { path: '/garden/chat', gardenName: 'The Canopy', technicalName: 'Chat', icon: '\u{1F4AC}' },
  { path: '/garden/model-room', gardenName: 'The Atrium', technicalName: 'Model Room', icon: '\u{1F9E0}' },
  { path: '/garden/models', gardenName: 'The Conservatory', technicalName: 'Models', icon: '\u{1F9EA}' },
  { path: '/garden/contacts', gardenName: 'The Visitors', technicalName: 'Contacts', icon: '\u{1F6AA}' },
  { path: '/garden/identity', gardenName: 'The Seeds', technicalName: 'Identity', icon: '\u{1F331}' },
  { path: '/garden/prompts', gardenName: 'The Soil', technicalName: 'Prompts', icon: '\u{1FAB4}' },
  { path: '/garden/settings', gardenName: 'The Climate', technicalName: 'Settings', icon: '\u{2600}\u{FE0F}' },
  { path: '/garden/telemetry', gardenName: 'The Sap', technicalName: 'Events', icon: '\u{1F4A7}' },
  { path: '/garden/tools', gardenName: 'The Shed', technicalName: 'Tools', icon: '\u{1F527}' },
  { path: '/garden/shards', gardenName: 'The Blooms', technicalName: 'Shards', icon: '\u{1F338}' },
  { path: '/garden/scheduler', gardenName: 'The Rhythms', technicalName: 'Scheduler', icon: '\u{23F0}' },
  { path: '/garden/skills', gardenName: 'The Crafts', technicalName: 'Skills', icon: '\u{2728}' },
  { path: '/garden/confirmations', gardenName: 'The Gate', technicalName: 'Confirmations', icon: '\u{1F512}' },
  { path: '/garden/values', gardenName: 'The Journal', technicalName: 'Values', icon: '\u{1F4D6}' },
  { path: '/garden/primer', gardenName: 'The Almanac', technicalName: 'Primer', icon: '\u{1F4DA}' },
];
