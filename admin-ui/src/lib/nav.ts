// ── Navigation configuration ──

export interface NavItem {
  path: string;
  gardenName: string;
  techName: string;
  icon: string;  // SVG path data for a 24x24 viewBox
}

// SVG path data (heroicons-style, 24x24 viewBox)
const ICONS = {
  // Tree trunk
  tree: 'M12 2C8 2 5 5.5 5 10c0 2.5 1 4.5 2.5 6H11v4h2v-4h3.5c1.5-1.5 2.5-3.5 2.5-6 0-4.5-3-8-7-8z',
  // Roots
  roots: 'M12 2v6m0 0l-4 4m4-4l4 4m-8 0l-2 4m2-4v6m6-6l2 4m-2-4v6m-8 2h16',
  // Branch
  branch: 'M6 3v12m0 0c0 2.2 1.8 4 4 4h4m-8-4h8m4-12v8m0 0c0 2.2-1.8 4-4 4',
  // Leaf canopy
  canopy: 'M12 3c-4 0-7 3-7 7 0 2 .8 3.8 2 5.2V21h10v-5.8c1.2-1.4 2-3.2 2-5.2 0-4-3-7-7-7zm-2 13v2m4-2v2',
  // Soil layers
  soil: 'M3 8h18M3 12h18M3 16h18M6 4l2 4M16 4l-2 4M8 16l-1 4m9-4l1 4',
  // Flower bloom
  flower: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-7.07l-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14l2.83 2.83m4.48 4.48l2.83 2.83',
  // Gate
  gate: 'M3 21V7a2 2 0 012-2h2a2 2 0 012 2v14M15 21V7a2 2 0 012-2h2a2 2 0 012 2v14M7 10h10M7 14h10M1 21h22',
  // Seed
  seed: 'M12 22c4.4 0 8-3.6 8-8 0-6-8-12-8-12S4 8 4 14c0 4.4 3.6 8 8 8zm0-4a4 4 0 01-4-4c0-2.2 4-6 4-6s4 3.8 4 6a4 4 0 01-4 4z',
  // Sun and cloud
  climate: 'M12 3v2m0 14v2m9-9h-2M5 12H3m15.36-6.36l-1.42 1.42M8.06 15.94l-1.42 1.42m12.72 0l-1.42-1.42M8.06 8.06L6.64 6.64M16 12a4 4 0 11-8 0 4 4 0 018 0z',
  // Droplet
  droplet: 'M12 2C12 2 5 10 5 15a7 7 0 0014 0c0-5-7-13-7-13z',
  // Tool shed
  shed: 'M3 21h18M5 21V9l7-6 7 6v12M9 21v-6h6v6m-3-12v0',
} as const;

export const NAV_ITEMS: NavItem[] = [
  { path: '/',          gardenName: 'The Trunk',    techName: 'Dashboard',     icon: ICONS.tree },
  { path: '/memory',    gardenName: 'The Roots',    techName: 'Memory',        icon: ICONS.roots },
  { path: '/sessions',  gardenName: 'The Branches', techName: 'Sessions',      icon: ICONS.branch },
  { path: '/chat',      gardenName: 'The Canopy',   techName: 'Chat',          icon: ICONS.canopy },
  { path: '/prompts',   gardenName: 'The Soil',     techName: 'Prompts',       icon: ICONS.soil },
  { path: '/shards',    gardenName: 'The Blooms',   techName: 'Shards',        icon: ICONS.flower },
  { path: '/contacts',  gardenName: 'The Visitors', techName: 'Contacts',      icon: ICONS.gate },
  { path: '/identity',  gardenName: 'The Seeds',    techName: 'Identity',      icon: ICONS.seed },
  { path: '/settings',  gardenName: 'The Climate',  techName: 'Settings',      icon: ICONS.climate },
  { path: '/telemetry', gardenName: 'The Sap',      techName: 'Telemetry',     icon: ICONS.droplet },
  { path: '/tools',     gardenName: 'The Shed',     techName: 'Tools',         icon: ICONS.shed },
];
