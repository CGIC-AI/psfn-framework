import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';

describe('concern action escalation ceremony', () => {
  it('renders the audited reason and exact-action confirmation contract', () => {
    const rendered = render(Page);

    expect(rendered.body).toContain('Audited concern action');
    expect(rendered.body).toContain('concern-escalation-reason');
    expect(rendered.body).toContain('single-use grant');
    expect(rendered.body).toContain('exact concern action');
  });
});
