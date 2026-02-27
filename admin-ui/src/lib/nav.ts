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
  { path: '/garden/contacts', gardenName: 'The Visitors', technicalName: 'Contacts', icon: '\u{1F6AA}' },
  { path: '/garden/identity', gardenName: 'The Seeds', technicalName: 'Identity', icon: '\u{1F331}' },
  { path: '/garden/prompts', gardenName: 'The Soil', technicalName: 'Prompts', icon: '\u{1FAB4}' },
  { path: '/garden/settings', gardenName: 'The Climate', technicalName: 'Settings', icon: '\u{2600}\u{FE0F}' },
  { path: '/garden/telemetry', gardenName: 'The Sap', technicalName: 'Events', icon: '\u{1F4A7}' },
  { path: '/garden/tools', gardenName: 'The Shed', technicalName: 'Tools', icon: '\u{1F527}' },
  { path: '/garden/shards', gardenName: 'The Blooms', technicalName: 'Shards', icon: '\u{1F338}' },
];
