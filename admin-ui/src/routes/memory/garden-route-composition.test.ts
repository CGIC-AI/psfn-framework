import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const routeSources = new Map(
  [
    ['memory', './+page.svelte'],
    ['biographical-profile', '../biographical-profile/+page.svelte'],
    ['episodic-memory', '../episodic-memory/LazyPageContent.svelte'],
    ['wiki', '../wiki/+page.svelte'],
    ['wishlist', '../wishlist/+page.svelte'],
    ['contacts', '../contacts/+page.svelte'],
    ['contact-approvals', '../contact-approvals/+page.svelte'],
    ['enrollment', '../enrollment/+page.svelte'],
    ['rooms', '../rooms/+page.svelte'],
    ['graph-proposals', '../graph-proposals/+page.svelte'],
    ['concerns', '../concerns/+page.svelte'],
    ['identity', '../identity/+page.svelte'],
    ['images', '../images/LazyPageContent.svelte'],
    ['values', '../values/+page.svelte'],
  ].map(([route, path]) => [route, readFileSync(new URL(path, import.meta.url), 'utf8')]),
);
const biographyPanel = readFileSync(new URL('./BiographicalClaimsPanel.svelte', import.meta.url), 'utf8');

describe('memory and identity Garden route composition', () => {
  it.each([...routeSources.entries()])('%s adopts the shared page shell and header', (_route, source) => {
    expect(source).toContain('GardenPageHeader');
    expect(source).toContain('garden-page');
    expect(source).toMatch(/garden-(?:section|toolbar|metric|split-view|empty|loading|error)/);
  });

  it.each([
    'memory',
    'episodic-memory',
    'wiki',
    'contacts',
    'contact-approvals',
    'rooms',
  ])('%s keeps dense list/detail content on the shared responsive split', (route) => {
    expect(routeSources.get(route)).toContain('garden-split-view');
  });

  it('uses the shared table hierarchy for dense roster and contact data', () => {
    for (const route of ['contacts', 'rooms', 'identity']) {
      const source = routeSources.get(route) ?? '';
      expect(source).toContain('garden-table-shell');
      expect(source).toContain('garden-table-scroll');
      expect(source).toContain('garden-table');
    }
  });

  it('keeps biography review redacted, exact-digest bound, and responsive', () => {
    expect(routeSources.get('memory')).not.toContain('<BiographicalClaimsPanel />');
    expect(routeSources.get('biographical-profile')).toContain('<BiographicalClaimsPanel />');
    expect(biographyPanel).toContain('Source bodies never appear here');
    expect(biographyPanel).toContain('garden-split-view');
    expect(biographyPanel).toContain('garden-table-shell');
    expect(biographyPanel).toContain('currentSourceSetDigest');
    expect(biographyPanel).toContain('claimDigest: detail.claim.claimDigest');
    expect(biographyPanel).toContain('hasActiveCurrentGrant()');
    expect(biographyPanel).not.toContain('sourceBody');
  });
});
