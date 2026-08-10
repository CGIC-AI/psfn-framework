import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import FleetNavigation from './FleetNavigation.svelte';

function renderRail(activeView: 'info' | 'usage' | 'costs' | 'firewall' = 'info'): string {
  return render(FleetNavigation, {
    props: { activeView, onLogout: () => {} },
  }).body;
}

describe('FleetNavigation (gh62x)', () => {
  it('presents a cluster identity instead of a companion scope', () => {
    const body = renderRail();
    expect(body).toContain('aria-label="Cluster sections"');
    expect(body).toContain('Garden Cluster');
    expect(body).toContain('All companions · no companion selected');
  });

  it('links every real fleet surface from the rail', () => {
    const body = renderRail();
    expect(body).toContain('href="/fleet"');
    expect(body).toContain('href="/fleet?view=usage"');
    expect(body).toContain('href="/fleet?view=costs"');
    expect(body).toContain('href="/fleet?view=firewall"');
    expect(body).toContain('Cluster health');
    expect(body).toContain('Usage summary');
    expect(body).toContain('Cost &amp; usage');
    expect(body).toContain('Global firewall');
  });

  it('integrates the sign-out action into the rail and the drawer', () => {
    const body = renderRail();
    const signOutOccurrences = body.split('Sign out').length - 1;
    expect(signOutOccurrences).toBeGreaterThanOrEqual(2);
  });

  it('marks the active view with aria-current', () => {
    const info = renderRail('info');
    expect(info).toMatch(/href="\/fleet"[^>]*aria-current="page"/u);
    const firewall = renderRail('firewall');
    expect(firewall).toMatch(/href="\/fleet\?view=firewall"[^>]*aria-current="page"/u);
  });

  it('never exposes companion-only navigation or a companion switcher', () => {
    const body = renderRail();
    expect(body).not.toContain('rail-companion-switcher');
    expect(body).not.toContain('<select');
    expect(body).not.toContain('Active scope');
    expect(body).not.toContain('Scheduler');
    expect(body).not.toContain('Memory');
  });

  it('provides a compact mobile drawer that stays off-screen until opened', () => {
    const body = renderRail();
    expect(body).toContain('aria-label="Cluster navigation"');
    expect(body).toContain('-translate-x-full');
    expect(body).toContain('lg:hidden');
  });
});
