import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('Garden dashboard intention routing adoption', () => {
  it('renders the content-free runtime projection returned by the dashboard API', () => {
    expect(dashboardSource).toContain('IntentionFollowUpRoutingCard');
    expect(dashboardSource).toContain('routing={stats.intentionFollowUpRouting}');
  });
});
