import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  Z02LinkConnection,
  Z02LinkConnector,
  Z02LinkProgress,
} from '../lib/z02/web-bluetooth.js';
import { useZ02Link } from './use-z02-link.js';

describe('useZ02Link', () => {
  it('reports stock PCM receipt and relays it through the supplied phone transport', async () => {
    const disconnect = vi.fn();
    const relayMicrophonePcm = vi.fn(() => true);
    let emitPcm: ((pcm: Uint8Array) => void) | undefined;
    let remoteDisconnect: (() => void) | null = null;
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        remoteDisconnect = callbacks.disconnected;
        emitPcm = callbacks.audioPcm;
        for (const phase of ['selecting', 'connecting', 'authenticating', 'subscribing'] as Z02LinkProgress[]) {
          callbacks.progress?.(phase);
        }
        return {
          deviceName: 'Z02 Test Badge',
          disconnect,
          microphone: 'pcm16-16khz',
          transport: 'stock-rcsp',
        } satisfies Z02LinkConnection;
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector, { relayMicrophonePcm }));

    expect(result.current.state.phase).toBe('idle');
    await act(async () => { await result.current.link(); });
    expect(result.current.state).toMatchObject({
      phase: 'linked',
      deviceName: 'Z02 Test Badge',
      audioFrames: 0,
      microphone: 'pcm16-16khz',
      transport: 'stock-rcsp',
    });

    act(() => { emitPcm?.(Uint8Array.of(0x00, 0x01)); });
    expect(relayMicrophonePcm).toHaveBeenCalledWith(Uint8Array.of(0x00, 0x01));
    expect(result.current.state).toMatchObject({ audioFrames: 1, relayedFrames: 1 });
    expect(result.current.state.detail).toContain('PCM relay active');

    act(() => { remoteDisconnect?.(); });
    expect(result.current.state).toMatchObject({ phase: 'idle', detail: 'Badge disconnected.' });

    act(() => { result.current.disconnect(); });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('truthfully reports phone receipt while the Companion transport cannot take PCM', async () => {
    let emitPcm: ((pcm: Uint8Array) => void) | undefined;
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        emitPcm = callbacks.audioPcm;
        return {
          deviceName: 'Z02 Test Badge',
          disconnect: vi.fn(),
          microphone: 'pcm16-16khz',
          transport: 'stock-rcsp',
        } satisfies Z02LinkConnection;
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector, {
      relayMicrophonePcm: () => false,
    }));

    await act(async () => { await result.current.link(); });
    act(() => { emitPcm?.(Uint8Array.of(0x00, 0x01)); });

    expect(result.current.state).toMatchObject({ audioFrames: 1, relayedFrames: 0 });
    expect(result.current.state.detail).toContain('Waiting for Companion audio relay');
  });

  it('shows when Stark Ruby begins delivering Omi microphone frames', async () => {
    let emitAudio: ((frame: {
      firstSequence: number;
      lastSequence: number;
      opus: Uint8Array;
    }) => void) | undefined;
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        emitAudio = callbacks.audioFrame;
        return {
          deviceName: 'Omi',
          disconnect: vi.fn(),
          microphone: 'opus-16khz',
          transport: 'omi-audio',
        } satisfies Z02LinkConnection;
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });
    expect(result.current.state).toMatchObject({
      phase: 'linked',
      audioFrames: 0,
      microphone: 'opus-16khz',
      transport: 'omi-audio',
    });

    act(() => emitAudio?.({ firstSequence: 0, lastSequence: 0, opus: Uint8Array.of(0xaa) }));
    expect(result.current.state.audioFrames).toBe(1);
    expect(result.current.state.detail).toContain('Audio stream active');
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

  it('preserves an authentication-time disconnect as the visible reason', async () => {
    const connector: Z02LinkConnector = {
      connect: vi.fn(async callbacks => {
        callbacks.disconnected();
        throw new Error('Z02 link failed');
      }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });

    expect(result.current.state).toEqual({ phase: 'idle', detail: 'Badge disconnected.' });
  });

  it('turns transport timeouts into a useful non-secret retry state', async () => {
    const connector: Z02LinkConnector = {
      connect: vi.fn(async () => { throw new Error('Z02 notification subscription timed out'); }),
    };
    const { result } = renderHook(() => useZ02Link(connector));

    await act(async () => { await result.current.link(); });

    expect(result.current.state).toEqual({
      phase: 'error',
      detail: 'The badge stopped responding before the link completed. Tap Link Z02 to retry.',
    });
  });

  it('reports unsupported browsers without starting discovery', async () => {
    const { result } = renderHook(() => useZ02Link(null));

    await act(async () => { await result.current.link(); });

    expect(result.current.state.phase).toBe('unsupported');
  });
});
