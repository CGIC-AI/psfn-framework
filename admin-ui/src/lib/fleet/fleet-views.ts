/**
 * Cluster-scoped fleet views for the /fleet narrow-rail shell.
 *
 * Design source: Magic Patterns project gpkjwgpcw9ex6tq43nvvvd, artifact
 * 7d5a7b67-f0c2-4aa1-b71b-e5d54f95ef12 (components/IconRail.tsx, pages/Cluster.tsx).
 * The rail is a cluster navigation context: every destination maps to a real
 * /fleet surface and none of them imply that a companion is selected.
 */

export type FleetView = 'info' | 'usage' | 'costs' | 'firewall';

export interface FleetViewDestination {
  readonly id: FleetView;
  readonly label: string;
  readonly description: string;
}

export const FLEET_VIEW_DESTINATIONS: readonly FleetViewDestination[] = [
  {
    id: 'info',
    label: 'Cluster health',
    description: 'Live companion health and posture',
  },
  {
    id: 'usage',
    label: 'Usage summary',
    description: 'Today’s authorized request and token totals',
  },
  {
    id: 'costs',
    label: 'Cost & usage',
    description: 'Per-companion spend across the cluster',
  },
  {
    id: 'firewall',
    label: 'Global firewall',
    description: 'Cluster-owned shared gateway posture',
  },
];

export function isFleetView(value: string | null): value is FleetView {
  return FLEET_VIEW_DESTINATIONS.some(destination => destination.id === value);
}

export function fleetViewHref(view: FleetView): string {
  return view === 'info' ? '/fleet' : `/fleet?view=${view}`;
}

/**
 * Resolve the active fleet view from the current URL. The explicit `view`
 * query parameter wins; the legacy `#fleet-costs` / `#fleet-usage` fragments
 * (emitted by fleetCostNavigationPath and the usage summary anchor) still map
 * onto their views. Anything else falls back to the cluster health overview.
 */
export function resolveFleetView(search: string, hash: string = ''): FleetView {
  const param = new URLSearchParams(search).get('view');
  if (isFleetView(param)) return param;
  if (hash === '#fleet-costs') return 'costs';
  if (hash === '#fleet-usage') return 'usage';
  return 'info';
}
