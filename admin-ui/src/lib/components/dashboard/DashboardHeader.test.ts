import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { DASHBOARD_COST_WINDOW_OPTIONS } from '$lib/dashboard/cost-window';
import { DASHBOARD_SECTIONS } from './dashboard-view';
import DashboardHeader from './DashboardHeader.svelte';

describe('DashboardHeader section navigation', () => {
  it('renders every dashboard section as a native keyboard-activatable deep link', () => {
    const body = render(DashboardHeader, {
      props: {
        options: DASHBOARD_COST_WINDOW_OPTIONS,
        selectedWindow: 'today',
        freshnessState: 'fresh',
        refreshedAt: 'now',
        onSelectWindow: vi.fn(),
      },
    }).body;

    for (const section of DASHBOARD_SECTIONS) {
      expect(body).toContain(`href="${section.href}"`);
      expect(body).toContain(`>${section.label}</a>`);
    }
    expect(body.match(/aria-current="location"/gu)).toHaveLength(1);
  });

  it('keeps a real scroll target for every visible section link', () => {
    const dashboardPage = readFileSync(
      fileURLToPath(new URL('../../../routes/+page.svelte', import.meta.url)),
      'utf8',
    );

    for (const section of DASHBOARD_SECTIONS) {
      expect(dashboardPage).toContain(`id="${section.id}"`);
    }
  });
});
