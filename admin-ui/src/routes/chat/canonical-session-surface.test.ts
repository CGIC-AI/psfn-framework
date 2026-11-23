import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';

const { mockPage } = vi.hoisted(() => {
  let current = { url: new URL('http://localhost/chat') };
  const subscribers = new Set<(value: typeof current) => void>();
  return {
    mockPage: {
      subscribe(run: (value: typeof current) => void) {
        run(current);
        subscribers.add(run);
        return () => subscribers.delete(run);
      },
      set(next: typeof current) {
        current = next;
        for (const run of subscribers) run(current);
      },
    },
  };
});

vi.mock('$app/stores', () => ({
  page: mockPage,
}));

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
}));

import ChatPage from './+page.svelte';

describe('Conversations unified surface', () => {
  it('renders live chat by default with canonical tabs for sessions and recovery', () => {
    mockPage.set({ url: new URL('http://localhost/chat') });
    const body = render(ChatPage).body;

    expect(body).toContain('Conversations');
    expect(body).toContain('Live Chat');
    expect(body).toContain('Sessions &amp; Debug');
    expect(body).toContain('Session Recovery');
    expect(body).not.toContain('>Transcripts<');
    expect(body).not.toContain('Choose a session');
  });

  it('mounts the full sessions and turn-detail browser on ?tab=sessions', () => {
    mockPage.set({ url: new URL('http://localhost/chat?tab=sessions') });
    const body = render(ChatPage).body;

    expect(body).toContain('Search channels...');
    expect(body).toContain('Choose a session');
  });

  it('mounts fresh-lane session recovery on ?tab=recovery', () => {
    mockPage.set({ url: new URL('http://localhost/chat?tab=recovery') });
    const body = render(ChatPage).body;

    expect(body).toContain('Active Routes');
    expect(body).toContain('Start Fresh Lane');
  });
});
