import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import ContactChannelPrivacy from './ContactChannelPrivacy.svelte';

describe('contact privacy controls', () => {
  it.each(['api:hermes', 'discord', 'telegram'])('uses the same badge and inline dropdown for %s', channel => {
    const props = { level: 'invite_only' as const, label: `${channel} privacy` };
    const badge = render(ContactChannelPrivacy, { props }).body;
    expect(badge).toContain('Invite-Only');
    expect(badge).not.toContain('href=');
    const editor = render(ContactChannelPrivacy, { props: { ...props, editing: true } }).body;
    expect(editor).toContain('<select');
    expect(editor).toContain(`aria-label="${channel} privacy"`);
    for (const level of ['private', 'invite_only', 'public']) expect(editor).toContain(`value="${level}"`);
    expect(editor).not.toContain('href=');
  });
  it('disables privacy editing when its authoritative value could not be loaded', () => {
    const editor = render(ContactChannelPrivacy, { props: { label: 'api:hermes privacy', editing: true } }).body;
    expect(editor).toContain('disabled');
    expect(editor).toContain('Unavailable');
  });
});
