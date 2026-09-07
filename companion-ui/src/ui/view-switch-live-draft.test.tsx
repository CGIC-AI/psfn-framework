import { act, fireEvent, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSatelliteHello } from '../lib/api/auth.js';
import type { SatelliteHubClientEventMap, SatelliteHubSnapshot } from '../lib/api/client.js';
import { HubStreamStore, type HubStreamClientLike } from '../lib/stream/hub-stream.js';
import { CompanionViewLayout, type CompanionView } from './companion-view-layout.js';
import { ThreadView } from './thread-view.js';

/**
 * Minimal transport stand-in: the store only consumes client events, so the
 * test drives real hub frames through the real reducer without a socket.
 */
class FakeHubClient implements HubStreamClientLike {
  private readonly listeners = new Map<keyof SatelliteHubClientEventMap, Set<(event: never) => void>>();
  private readonly hello = buildSatelliteHello();

  on<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    listener: (event: SatelliteHubClientEventMap[K]) => void,
  ): () => void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as (event: never) => void);
    return () => {
      listeners?.delete(listener as (event: never) => void);
    };
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  disconnect(): void {
    return;
  }

  sendUserText(): void {
    return;
  }

  interrupt(): void {
    return;
  }

  sendApprovalDecision(): void {
    return;
  }

  sendArtifactPreviewRequest(): void {
    return;
  }

  sendTouchInteraction(): void {
    return;
  }

  sendDeviceLocation(): void {
    return;
  }

  snapshot(): SatelliteHubSnapshot {
    return {
      state: 'idle',
      ready: false,
      url: 'ws://companion.invalid/',
      hello: this.hello,
      session: {},
    };
  }

  emit<K extends keyof SatelliteHubClientEventMap>(
    type: K,
    event: SatelliteHubClientEventMap[K],
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function CompanionSurface({ store }: { store: HubStreamStore }) {
  const [streamState, setStreamState] = useState(() => store.snapshot());
  const [activeView, setActiveView] = useState<CompanionView>('thread');
  useEffect(() => store.subscribe(setStreamState), [store]);

  return (
    <CompanionViewLayout
      activeView={activeView}
      onViewChange={setActiveView}
      thread={<ThreadView streamState={streamState} />}
      avatar={<p>Avatar surface</p>}
    />
  );
}

function surfaceFor(container: HTMLElement, view: CompanionView): HTMLElement {
  const surface = container.querySelector(`[data-companion-view="${view}"]`);
  if (!(surface instanceof HTMLElement)) throw new Error(`missing ${view} surface`);
  return surface;
}

describe('thread/avatar view switching mid-stream', () => {
  beforeAll(() => {
    // jsdom has no layout engine; ThreadView scrolls its tail into view on every delta.
    Element.prototype.scrollIntoView = () => undefined;
  });

  it('keeps the live assistant draft intact and still live across a view toggle', () => {
    const client = new FakeHubClient();
    const store = new HubStreamStore(client);
    const view = render(<CompanionSurface store={store} />);

    act(() => {
      client.emit('inbound', {
        message: {
          type: 'session.ready',
          sessionId: 'session-1',
          channelId: 'satellite.endpoint:session-1',
          deviceId: 'phone',
          deviceName: 'Phone',
          satelliteId: 'phone',
          audioFormat: 'text',
        },
      });
    });

    const delta = (content: string) => {
      act(() => {
        client.emit('inbound', {
          message: { type: 'message', data: { role: 'assistant', content, live: true } },
        });
      });
    };

    delta('I am still ');
    delta('thinking about ');
    expect(surfaceFor(view.container, 'thread').textContent).toContain('I am still thinking about');

    fireEvent.click(view.getByRole('button', { name: 'Avatar' }));
    expect(surfaceFor(view.container, 'thread').hidden).toBe(true);
    expect(surfaceFor(view.container, 'avatar').hidden).toBe(false);

    // The reply keeps streaming while the thread surface is hidden.
    delta('that.');

    fireEvent.click(view.getByRole('button', { name: 'Thread' }));

    const draft = 'I am still thinking about that.';
    expect(surfaceFor(view.container, 'thread').hidden).toBe(false);
    expect(view.getByText(draft).closest('.message-row')?.className).toContain('assistant live');
    expect(store.snapshot().liveAssistant?.content).toBe(draft);
    expect(store.snapshot().liveAssistant?.final).toBe(false);
    expect(store.snapshot().phase).toBe('responding');
    expect(store.snapshot().messages).toEqual([]);
  });
});
