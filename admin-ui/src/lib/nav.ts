export interface NavItem {
  id: string;
  path: string;
  defaultLabel: string;
  icon: string;
}

export const navItems: NavItem[] = [
  { id: 'dashboard', path: '/garden', defaultLabel: 'Dashboard', icon: '\u{1F333}' },
  { id: 'memory', path: '/garden/memory', defaultLabel: 'Memory', icon: '\u{1F33F}' },
  { id: 'sessions', path: '/garden/sessions', defaultLabel: 'Sessions', icon: '\u{1F332}' },
  { id: 'chat', path: '/garden/chat', defaultLabel: 'Chat', icon: '\u{1F4AC}' },
  { id: 'model-room', path: '/garden/model-room', defaultLabel: 'Model Room', icon: '\u{1F9E0}' },
  { id: 'models', path: '/garden/models', defaultLabel: 'Models', icon: '\u{1F9EA}' },
  { id: 'contacts', path: '/garden/contacts', defaultLabel: 'Contacts', icon: '\u{1F6AA}' },
  { id: 'identity', path: '/garden/identity', defaultLabel: 'Identity', icon: '\u{1F331}' },
  { id: 'prompts', path: '/garden/prompts', defaultLabel: 'Prompts', icon: '\u{1FAB4}' },
  { id: 'settings', path: '/garden/settings', defaultLabel: 'Settings', icon: '\u{2600}\u{FE0F}' },
  { id: 'theme', path: '/garden/theme', defaultLabel: 'Theme', icon: '\u{1F3A8}' },
  { id: 'telemetry', path: '/garden/telemetry', defaultLabel: 'Events', icon: '\u{1F4A7}' },
  { id: 'tools', path: '/garden/tools', defaultLabel: 'Tools', icon: '\u{1F527}' },
  { id: 'shards', path: '/garden/shards', defaultLabel: 'Shards', icon: '\u{1F338}' },
  { id: 'scheduler', path: '/garden/scheduler', defaultLabel: 'Scheduler', icon: '\u{23F0}' },
  { id: 'skills', path: '/garden/skills', defaultLabel: 'Skills', icon: '\u{2728}' },
  { id: 'confirmations', path: '/garden/confirmations', defaultLabel: 'Confirmations', icon: '\u{1F512}' },
  { id: 'values', path: '/garden/values', defaultLabel: 'Values', icon: '\u{1F4D6}' },
  { id: 'primer', path: '/garden/primer', defaultLabel: 'Primer', icon: '\u{1F4DA}' },
];
