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
  navGroup('operate', 'Live', [
    { id: 'dashboard', path: '/', defaultLabel: 'Dashboard', icon: '\u{1F333}' },
    { id: 'chat', path: '/chat', defaultLabel: 'Conversations', icon: '\u{1F4AC}' },
    { id: 'inbox', path: '/inbox', defaultLabel: 'Inbox', icon: '\u{1F4E5}' },
    { id: 'places', path: '/places', defaultLabel: 'Places', icon: '\u{1F5FA}\u{FE0F}' },
  ]),
  navGroup('memory', 'Mind & Memory', [
    { id: 'memory', path: '/memory', defaultLabel: 'Memory', icon: '\u{1F33F}' },
    { id: 'identity', path: '/identity', defaultLabel: 'Identity & Prompts', icon: '\u{1F343}' },
    { id: 'wiki', path: '/wiki', defaultLabel: 'Knowledge & Work', icon: '\u{1F4D8}' },
    { id: 'contacts', path: '/contacts', defaultLabel: 'Contacts', icon: '\u{1F6AA}' },
  ]),
  navGroup('runtime', 'Runtime', [
    { id: 'autonomy', path: '/autonomy', defaultLabel: 'Autonomy & Schedule', icon: '\u{1F331}' },
    { id: 'tools', path: '/tools', defaultLabel: 'Tools & Skills', icon: '\u{1F527}' },
    { id: 'models', path: '/models', defaultLabel: 'Models & Usage', icon: '\u{1F9EA}' },
    { id: 'subsystem-health', path: '/subsystem-health', defaultLabel: 'Safety & Health', icon: '\u{1FAC0}' },
  ]),
  navGroup('configure', 'Configure', [
    { id: 'settings', path: '/settings', defaultLabel: 'Settings', icon: '\u{2600}\u{FE0F}' },
    { id: 'channels', path: '/channels', defaultLabel: 'Channels', icon: '\u{1F4E1}' },
    { id: 'theme', path: '/theme', defaultLabel: 'Theme', icon: '\u{1F3A8}' },
    { id: 'operator-guide', path: '/primer', defaultLabel: 'Operator Guide', icon: '\u{1F4DA}' },
  ]),
];

export const navItems: NavItem[] = navGroups.flatMap(group => group.items);
