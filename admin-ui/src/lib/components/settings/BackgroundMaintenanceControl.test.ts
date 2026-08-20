import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import BackgroundMaintenanceControl from './BackgroundMaintenanceControl.svelte';

describe('BackgroundMaintenanceControl', () => {
  it('is a compact, collapsed, keyboard-operable row by default', () => {
    const body = render(BackgroundMaintenanceControl, {
      props: {
        intervalMs: 3_600_000,
        inputClass: 'input',
        source: 'scheduler.json',
        authority: {
          sourceLabel: 'scheduler.json',
          detail: 'Saved to scheduler.json.',
        },
      },
    }).body;

    expect(body).toContain('Bundled Background Maintenance');
    expect(body).toContain('aria-expanded="false"');
    expect(body).not.toContain('One shared hourly tick');
    expect(body).not.toContain('type="number"');
  });
});
