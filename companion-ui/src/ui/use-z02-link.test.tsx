import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  Z02LinkConnection,
  Z02LinkConnector,
  Z02LinkProgress,
} from '../lib/z02/web-bluetooth.js';
import { useZ02Link } from './use-z02-link.js';

describe('useZ02Link', () => {
  it('reports progress and keeps an authenticated badge linked until disconnect', async () => {
    const disconnect = vi.fn();
    let remoteDisconnect: (() => void) | null = null;
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        remoteDisconnect = callbacks.disconnected;
        for (const phase of ['selecting', 'connecting', 'authenticating'] as Z02LinkProgress[]) {
          callbacks.progress?.(phase);
        }
        return { deviceName: 'Z02 Test Badge', disconnect } satisfies Z02LinkConnection;
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    expect(result.current.state.phase).toBe('idle');
    await act(async () => { await result.current.link(); });
    expect(result.current.state).toMatchObject({
      phase: 'linked',
      deviceName: 'Z02 Test Badge',
    });

    act(() => { remoteDisconnect?.(); });
    expect(result.current.state).toMatchObject({ phase: 'idle', detail: 'Badge disconnected.' });

    act(() => { result.current.disconnect(); });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('shows a safe retry state after authentication failure', async () => {
    const connector: Z02LinkConnector = {
      connect: vi.fn(async () => { throw new Error('Z02 authentication failed'); }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });

    expect(result.current.state).toEqual({
      phase: 'error',
      detail: 'The badge rejected stock authentication.',
    });
  });

  it('reports unsupported browsers without starting discovery', async () => {
    const { result } = renderHook(() => useZ02Link(null));

    await act(async () => { await result.current.link(); });

    expect(result.current.state.phase).toBe('unsupported');
  });
});
