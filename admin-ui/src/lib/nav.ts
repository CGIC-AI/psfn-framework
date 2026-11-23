export interface NavItem {
  id: string;
  path: string;
  defaultLabel: string;
  icon: string;
  groupId: string;
  indicatorTone?: 'attention' | 'waiting';
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
    { id: 'chat', path: '/chat', defaultLabel: 'Conversations', icon: '\u{1F4AC}' },
    { id: 'inbox', path: '/inbox', defaultLabel: 'Inbox', icon: '\u{1F4E5}' },
    { id: 'scheduler', path: '/scheduler', defaultLabel: 'Scheduler', icon: '\u{23F0}' },
    { id: 'automata', path: '/automata', defaultLabel: 'Automata', icon: '\u{2699}\u{FE0F}' },
    { id: 'places', path: '/places', defaultLabel: 'Places', icon: '\u{1F5FA}\u{FE0F}' },
    { id: 'action-pipe', path: '/action-pipe', defaultLabel: 'Action Pipe', icon: '\u{1F39B}\u{FE0F}' },
    { id: 'autonomy', path: '/autonomy', defaultLabel: 'Autonomy', icon: '\u{1F331}' },
    { id: 'room-arbiter', path: '/room-arbiter', defaultLabel: 'Cluster Command', icon: '\u{1F5E3}\u{FE0F}' },
  ]),
  navGroup('memory', 'Memory & Identity', [
    { id: 'memory', path: '/memory', defaultLabel: 'Memory', icon: '\u{1F33F}' },
    { id: 'biographical-profile', path: '/biographical-profile', defaultLabel: 'Stable Biography', icon: '\u{1F331}' },
    { id: 'episodic-memory', path: '/episodic-memory', defaultLabel: 'L0.1 Episodes', icon: '\u{1F9F6}' },
    { id: 'wiki', path: '/wiki', defaultLabel: 'Wiki', icon: '\u{1F4D8}' },
    { id: 'wishlist', path: '/wishlist', defaultLabel: 'Wishlist', icon: '\u{1F49B}' },
    { id: 'contacts', path: '/contacts', defaultLabel: 'Contacts', icon: '\u{1F6AA}' },
    { id: 'enrollment', path: '/enrollment', defaultLabel: 'Enrollment', icon: '\u{1FAAA}' },
    { id: 'concerns', path: '/concerns', defaultLabel: 'Concerns', icon: '\u{1F4AD}' },
    { id: 'identity', path: '/identity', defaultLabel: 'Identity', icon: '\u{1F343}' },
    { id: 'images', path: '/images', defaultLabel: 'Images', icon: '\u{1F5BC}\u{FE0F}' },
    { id: 'values', path: '/values', defaultLabel: 'Values', icon: '\u{1F4D6}' },
  ]),
  navGroup('runtime', 'Runtime & Tools', [
    { id: 'models', path: '/models', defaultLabel: 'Models', icon: '\u{1F9EA}' },
    { id: 'analysis-workbench', path: '/analysis-workbench', defaultLabel: 'Analysis Workbench', icon: '\u{1F52C}' },
    { id: 'charge-budget', path: '/charge-budget', defaultLabel: 'Charge / Budget', icon: '\u{1F4B0}' },
    { id: 'fleet-costs', path: '/fleet-costs', defaultLabel: 'Cluster Costs', icon: '\u{1F4B8}' },
    { id: 'tools', path: '/tools', defaultLabel: 'Tools', icon: '\u{1F527}' },
    { id: 'shards', path: '/shards', defaultLabel: 'Shards', icon: '\u{1F338}' },
    { id: 'skills', path: '/skills', defaultLabel: 'Skills', icon: '\u{2728}' },
  ]),
  navGroup('review', 'Review & Safety', [
    { id: 'prompts', path: '/prompts', defaultLabel: 'Prompts', icon: '\u{1FAB4}' },
    { id: 'prompt-monitor', path: '/prompt-monitor', defaultLabel: 'Prompt Monitor', icon: '\u{1F9F5}' },
    { id: 'evals-emotion-sidecar', path: '/evals/emotion-sidecar', defaultLabel: 'Evals', icon: '\u{1F4CA}' },
    { id: 'subsystem-health', path: '/subsystem-health', defaultLabel: 'Subsystem Health', icon: '\u{1FAC0}' },
    { id: 'telemetry', path: '/telemetry', defaultLabel: 'Events & Audit', icon: '\u{1F4A7}' },
  ]),
  navGroup('cognitive-security', 'Cognitive Security', [
    { id: 'cogsec-firewall', path: '/cognitive-security/firewall', defaultLabel: 'Firewall', icon: '\u{1F9F1}' },
    { id: 'cogsec-drift', path: '/cognitive-security/drift', defaultLabel: 'Drift Review', icon: '\u{1F4C9}' },
    { id: 'cogsec-custody', path: '/cognitive-security/custody', defaultLabel: 'Chain of Custody', icon: '\u{1F517}' },
  ]),
  navGroup('configure', 'Configure Garden', [
    { id: 'settings', path: '/settings', defaultLabel: 'Settings', icon: '\u{2600}\u{FE0F}' },
    { id: 'channels', path: '/channels', defaultLabel: 'Channels', icon: '\u{1F4E1}' },
    { id: 'theme', path: '/theme', defaultLabel: 'Theme', icon: '\u{1F3A8}' },
    { id: 'operator-guide', path: '/primer', defaultLabel: 'Operator Guide', icon: '\u{1F4DA}' },
  ]),
];

export const navItems: NavItem[] = navGroups.flatMap(group => group.items);
