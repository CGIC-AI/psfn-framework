import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import WikiScopeTabs from './WikiScopeTabs.svelte';

describe('WikiScopeTabs', () => {
  it('presents exactly personal and shared Wiki writing surfaces', () => {
    const body = render(WikiScopeTabs, {
      props: {
        activeScopeKey: 'personal',
        personalCount: 3,
        sharedScopes: [
          { scope: 'shared_world', siteId: 'home', displayName: 'Home', documentCount: 4 },
          { scope: 'shared_world', siteId: 'studio', displayName: 'Studio', documentCount: 2 },
        ],
        onSelectPersonal: vi.fn(),
        onSelectShared: vi.fn(),
      },
    }).body;

    expect(body.match(/role="tab"/g)).toHaveLength(2);
    expect(body).toContain('Personal Wiki');
    expect(body).toContain('Shared Wiki');
    expect(body).not.toContain('>Home<');
    expect(body).not.toContain('>Studio<');
  });

  it('keeps individual shared locations available inside the shared Wiki surface', () => {
    const body = render(WikiScopeTabs, {
      props: {
        activeScopeKey: 'home',
        personalCount: 3,
        sharedScopes: [
          { scope: 'shared_world', siteId: 'home', displayName: 'Home', documentCount: 4 },
          { scope: 'shared_world', siteId: 'studio', displayName: 'Studio', documentCount: 2 },
        ],
        onSelectPersonal: vi.fn(),
        onSelectShared: vi.fn(),
      },
    }).body;

    expect(body).toContain('Shared Wiki location');
    expect(body).toContain('<option value="home" selected="">Home (4)</option>');
    expect(body).toContain('<option value="studio">Studio (2)</option>');
  });
});
