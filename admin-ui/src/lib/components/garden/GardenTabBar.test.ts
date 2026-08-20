import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import GardenTabBar from './GardenTabBar.svelte';

describe('GardenTabBar keyboard navigation', () => {
  it('renders one roving-tabstop tablist and handles standard tab keys', () => {
    const onSelect = vi.fn();
    const body = render(GardenTabBar, {
      props: {
        tabs: [
          { id: 'physical', label: 'Physical' },
          { id: 'virtual', label: 'Virtual' },
          { id: 'satellites', label: 'Satellites' },
        ],
        activeId: 'physical',
        onSelect,
        label: 'Places views',
      },
    }).body;

    expect(body).toContain('role="tablist"');
    expect(body).toContain('aria-label="Places views"');
    expect(body.match(/role="tab"/gu)).toHaveLength(3);
    expect(body.match(/tabindex="0"/gu)).toHaveLength(1);
    expect(body.match(/tabindex="-1"/gu)).toHaveLength(2);
    expect(body).toMatch(/Physical[\s\S]*Virtual[\s\S]*Satellites/u);

    const source = readFileSync(
      fileURLToPath(new URL('./GardenTabBar.svelte', import.meta.url)),
      'utf8',
    );
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(source).toContain(`'${key}'`);
    }
    expect(source).toContain('onkeydown={(event) => onTabKeydown(event, index)}');
  });
});
