export interface NavItem {
  id: string;
  path: string;
  defaultLabel: string;
  icon: string;
  groupId: string;
}

export interface NavGroup {
  id: string;
  defaultLabel: string;
  items: NavItem[];
}

type NavItemInput = Omit<NavItem, 'groupId'>;

function navGroup(id: string, defaultLabel: string, items: NavItemInput[]): NavGroup {
  return {
    id,
    defaultLabel,
    items: items.map(item => ({ ...item, groupId: id })),
  };
}

export const navGroups: NavGroup[] = [
  navGroup('operate', 'Live Operations', [
    { id: 'dashboard', path: '/', defaultLabel: 'Dashboard', icon: '\u{1F333}' },
    { id: 'chat', path: '/chat', defaultLabel: 'Chat', icon: '\u{1F4AC}' },
    { id: 'sessions', path: '/sessions', defaultLabel: 'Sessions', icon: '\u{1F332}' },
    { id: 'scheduler', path: '/scheduler', defaultLabel: 'Scheduler', icon: '\u{23F0}' },
    { id: 'action-pipe', path: '/action-pipe', defaultLabel: 'Action Pipe', icon: '\u{1F39B}\u{FE0F}' },
  ]),
  navGroup('memory', 'Memory & Identity', [
    { id: 'memory', path: '/memory', defaultLabel: 'Memory', icon: '\u{1F33F}' },
    { id: 'episodic-memory', path: '/episodic-memory', defaultLabel: 'L0.1 Episodes', icon: '\u{1F9F6}' },
    { id: 'contacts', path: '/contacts', defaultLabel: 'Contacts', icon: '\u{1F6AA}' },
    { id: 'identity', path: '/identity', defaultLabel: 'Identity', icon: '\u{1F331}' },
    { id: 'values', path: '/values', defaultLabel: 'Values', icon: '\u{1F4D6}' },
  ]),
  navGroup('runtime', 'Runtime & Tools', [
    { id: 'model-room', path: '/model-room', defaultLabel: 'Model Room', icon: '\u{1F9E0}' },
    { id: 'models', path: '/models', defaultLabel: 'Models', icon: '\u{1F9EA}' },
    { id: 'charge-budget', path: '/charge-budget', defaultLabel: 'Charge / Budget', icon: '\u{1F4B0}' },
    { id: 'tools', path: '/tools', defaultLabel: 'Tools', icon: '\u{1F527}' },
    { id: 'shards', path: '/shards', defaultLabel: 'Shards', icon: '\u{1F338}' },
    { id: 'skills', path: '/skills', defaultLabel: 'Skills', icon: '\u{2728}' },
  ]),
  navGroup('review', 'Review & Safety', [
    { id: 'prompts', path: '/prompts', defaultLabel: 'Prompts', icon: '\u{1FAB4}' },
    { id: 'prompt-monitor', path: '/prompt-monitor', defaultLabel: 'Prompt Monitor', icon: '\u{1F9F5}' },
    { id: 'confirmations', path: '/confirmations', defaultLabel: 'Confirmations', icon: '\u{1F512}' },
    { id: 'telemetry', path: '/telemetry', defaultLabel: 'Events & Audit', icon: '\u{1F4A7}' },
  ]),
  navGroup('configure', 'Configure Garden', [
    { id: 'settings', path: '/settings', defaultLabel: 'Settings', icon: '\u{2600}\u{FE0F}' },
    { id: 'theme', path: '/theme', defaultLabel: 'Theme', icon: '\u{1F3A8}' },
    { id: 'primer', path: '/primer', defaultLabel: 'Primer', icon: '\u{1F4DA}' },
  ]),
];

export const navItems: NavItem[] = navGroups.flatMap(group => group.items);
