import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function routeSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('Configure and Fleet page composition', () => {
  it.each([
    ['channels', '../channels/+page.svelte'],
    ['theme', '../theme/+page.svelte'],
    ['operator guide', '../primer/+page.svelte'],
    ['fleet', '../fleet/+page.svelte'],
  ])('uses the shared Garden page header on %s', (_label, path) => {
    const source = routeSource(path);

    expect(source).toContain("import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte'");
    expect(source).toContain('<GardenPageHeader');
  });

  it('gives settings a responsive domain navigator and canonical owner-file guidance', () => {
    const source = routeSource('./SettingsPageController.svelte');
    const chrome = routeSource('../../lib/components/settings/SettingsPageChrome.svelte');

    expect(source).toContain('lg:grid-cols-[15rem_minmax(0,1fr)]');
    expect(source).toContain('lg:sticky lg:top-28 lg:h-fit');
    expect(source).toContain('aria-label="Settings domains"');
    expect(source).toContain('Direct canonical owner-file editors');
    expect(source).toContain('Raw JSON edits remain separately staged');
    expect(source).toContain('<SettingsPageChrome');
    expect(chrome).toContain('<GardenPageHeader');
  });

  it('keeps channel management usable as cards on narrow screens and a table on desktop', () => {
    const source = routeSource('../channels/+page.svelte');

    expect(source).toContain('garden-table-shell');
    expect(source).toContain('hidden overflow-hidden md:block');
    expect(source).toContain('grid gap-3 md:hidden');
    expect(source).toContain('Disclosure epochs');
  });

  it('surfaces aggregate and per-companion fleet health from the live projection', () => {
    const source = routeSource('../fleet/+page.svelte');

    expect(source).toContain('const fleetSummary = $derived.by');
    expect(source).toContain('Cluster health summary');
    expect(source).toContain('Companion health');
    expect(source).toContain('<FleetUsageSummary');
    expect(source).toContain('<FleetCostUsage');
  });
});
