import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import { SharedWorldWikiStore } from './store.js';
import {
  buildSiteWikiPages,
  PLACES_PUBLICATION_TAG,
  publishSiteWiki,
} from './places-wiki-publication.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeSystemDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-shared-wiki-'));
  tempDirs.push(dir);
  return dir;
}

const REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'home', displayName: 'Home', kind: 'physical' }],
  places: [
    {
      placeId: 'living_room',
      siteId: 'home',
      displayName: 'Living Room',
      kind: 'physical',
      description: 'The main shared living space.',
      affordances: [
        { affordanceId: 'lr_lights', role: 'effector', kind: 'light', backend: 'ha', displayName: 'Living Room Lights', entityId: 'light.living_room', control: ['on', 'off'] },
        { affordanceId: 'lr_presence', role: 'perceiver', kind: 'presence', backend: 'ha', displayName: 'Living Room Presence' },
      ],
    },
    {
      placeId: 'kitchen',
      siteId: 'home',
      displayName: 'Kitchen',
      kind: 'physical',
      affordances: [
        { affordanceId: 'kitchen_lights', role: 'effector', kind: 'light', backend: 'ha', displayName: 'Kitchen Lights' },
      ],
    },
  ],
};

describe('buildSiteWikiPages', () => {
  it('is registry-driven and fails closed on an unknown site', () => {
    const pages = buildSiteWikiPages(REGISTRY, 'home');
    // one overview + one page per place
    expect(pages.map(p => p.id)).toEqual(['site-overview', 'place-living_room', 'place-kitchen']);
    expect(pages[0].body).toContain('Living Room');
    expect(pages[0].body).toContain('Kitchen');
    const lr = pages.find(p => p.id === 'place-living_room');
    expect(lr?.body).toContain('The main shared living space.');
    expect(lr?.body).toContain('Living Room Lights');
    expect(lr?.body).toContain('Living Room Presence');
    for (const page of pages) expect(page.tags).toContain(PLACES_PUBLICATION_TAG);

    expect(() => buildSiteWikiPages(REGISTRY, 'nonexistent')).toThrow(/unknown siteId/);
  });
});

describe('publishSiteWiki', () => {
  it('writes shared-world-scoped pages and is idempotent on re-run', () => {
    const systemDataDir = makeSystemDataDir();
    const store = new SharedWorldWikiStore(systemDataDir, 'home', {
      now: () => new Date('2026-07-08T00:00:00.000Z'),
    });

    const first = publishSiteWiki(store, REGISTRY, 'home');
    expect(first.created.sort()).toEqual(['place-kitchen', 'place-living_room', 'site-overview']);
    expect(first.updated).toEqual([]);

    // Scope correctness: every generated doc is shared_world:home.
    for (const entry of store.list()) {
      expect(entry.scope).toBe('shared_world:home');
    }

    // Idempotent: an unchanged registry re-run touches nothing (no version churn).
    const second = publishSiteWiki(store, REGISTRY, 'home');
    expect(second.created).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual(['place-kitchen', 'place-living_room', 'site-overview']);
    expect(store.get('site-overview')?.version).toBe(1);
  });

  it('refreshes changed pages and prunes pages for removed places', () => {
    const systemDataDir = makeSystemDataDir();
    const store = new SharedWorldWikiStore(systemDataDir, 'home');
    publishSiteWiki(store, REGISTRY, 'home');

    // Drop the kitchen place; its generated page must be pruned on refresh.
    const trimmed: PlacesRegistryConfig = {
      ...REGISTRY,
      places: REGISTRY.places.filter(place => place.placeId !== 'kitchen'),
    };
    const report = publishSiteWiki(store, trimmed, 'home');
    expect(report.deleted).toContain('place-kitchen');
    expect(store.get('place-kitchen')).toBeNull();
    expect(store.get('place-living_room')).not.toBeNull();
  });

  it('fails closed when the store site does not match the requested site', () => {
    const systemDataDir = makeSystemDataDir();
    const store = new SharedWorldWikiStore(systemDataDir, 'home');
    expect(() => publishSiteWiki(store, REGISTRY, 'studio')).toThrow(/does not match/);
  });
});
