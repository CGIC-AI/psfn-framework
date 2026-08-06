import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Page from './+page.svelte';

describe('concern action escalation ceremony', () => {
  it('adopts one mandatory-justification prompt with one exact-action submission', () => {
    const rendered = render(Page);
    const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

    expect(rendered.body).toContain('Protected concern actions');
    expect(rendered.body).toContain('Click an action to provide its mandatory justification');
    expect(rendered.body).toContain('single-use grant');
    expect(source).toContain('ConcernActionEscalationModal');
    expect(source).not.toContain('ConfirmationModal');
    expect(source).not.toContain('!escalationReason.trim()');
  });
});
