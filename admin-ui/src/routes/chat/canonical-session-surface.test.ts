import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ChatPage from './+page.svelte';

describe('Chat Canopy session ownership', () => {
  it('renders chat without a duplicate transcript browser', () => {
    const body = render(ChatPage).body;

    expect(body).toContain('The Canopy');
    expect(body).not.toContain('>Transcripts<');
    expect(body).not.toContain('Chat console views');
    expect(body).not.toContain('Filter sessions by text');
  });
});
