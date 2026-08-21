import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import RoomsPage from '../rooms/+page.svelte';
import SatellitesPage from '../satellites/+page.svelte';

const PLACES_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));

describe('canonical Places surface', () => {
  it('owns Physical, Virtual, and Satellites as directly addressable tabs', () => {
    const source = readFileSync(PLACES_PAGE, 'utf8');

    expect(source).toContain('PLACES_TABS');
    expect(source).toContain('resolvePlacesTab($page.url.searchParams)');
    expect(source).toContain('canonicalPlacesPath(tab)');
    expect(source).toContain('<GardenTabBar');
    expect(source).toContain('<RoomsPage embedded />');
    expect(source).toContain('<SatellitesPage embedded />');
  });

  it('embeds unique virtual-room actions without a second page title', () => {
    const body = render(RoomsPage, { props: { embedded: true } }).body;

    expect(body).toContain('Virtual spaces');
    expect(body).toContain('Conversation channels');
    expect(body).not.toContain('>Rooms</h1>');
  });

  it('embeds the satellite registry without a second page title', () => {
    const body = render(SatellitesPage, { props: { embedded: true } }).body;

    expect(body).toContain('Claim authority');
    expect(body).toContain('Capability-mapped ports');
    expect(body).not.toContain('>Satellites</h1>');
  });

  it('leaves old route components as redirect-only shells', () => {
    const rooms = render(RoomsPage).body;
    const satellites = render(SatellitesPage).body;

    expect(rooms).toContain('Rooms now live in the Virtual tab under Places. Redirecting');
    expect(rooms).not.toContain('Virtual spaces');
    expect(satellites).toContain('Satellites now live in the Satellites tab under Places. Redirecting');
    expect(satellites).not.toContain('Claim authority');
  });
});
