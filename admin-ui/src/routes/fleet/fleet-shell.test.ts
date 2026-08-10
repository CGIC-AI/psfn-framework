import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function routeSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

describe('Fleet narrow-rail shell (gh62x)', () => {
  it('routes /fleet through the cluster rail instead of the shell bypass', () => {
    const layout = routeSource('+layout.svelte');
    expect(layout).toContain(
      "import FleetNavigation from '$lib/components/navigation/FleetNavigation.svelte'",
    );
    expect(layout).toContain('activeView={activeFleetView}');
    expect(layout).toContain('bind:mobileOpen={mobileNavOpen}');
    // The old bypass rendered /fleet with no navigation and a floating sign-out.
    expect(layout).not.toContain('fixed bottom-4 right-4');
  });

  it('keeps the fleet page on the real projection, detail, and panel components', () => {
    const page = routeSource('fleet/+page.svelte');
    expect(page).toContain('fetchFleetPortalProjection');
    expect(page).toContain('fetchFleetCardDetails');
    expect(page).toContain('FleetUsageSummary');
    expect(page).toContain('FleetCostUsage');
    expect(page).toContain('FleetGlobalFirewall');
    expect(page).toContain('resolveFleetCardHealth');
  });

  it('drives fleet surfaces from the rail views instead of in-page tabs', () => {
    const page = routeSource('fleet/+page.svelte');
    expect(page).toContain('resolveFleetView');
    expect(page).not.toContain('aria-label="Cluster administration"');
    expect(page).not.toContain('activeTab');
  });

  it('keeps health and posture semantics truthful and non-disclosing', () => {
    const page = routeSource('fleet/+page.svelte');
    expect(page).toContain('unknown is not treated as down');
    expect(page).toContain('Posture unavailable');
    expect(page).toContain('Stale report');
    expect(page).toContain('Garden reachability unknown');
    expect(page).toContain('Admin transport unreachable');
  });

  it('preserves the 100rem content ceiling without a nested viewport shell', () => {
    const page = routeSource('fleet/+page.svelte');
    expect(page).toContain('max-w-[100rem]');
    expect(page).not.toContain('min-h-screen');
  });
});
