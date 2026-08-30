import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { describeLocationNotice, describeLocationStatus } from './settings-drawer.js';
import { useDeviceLocation } from './use-device-location.js';

class FakeGeolocation {
  private success: ((position: GeolocationPosition) => void) | null = null;
  private error: ((error: GeolocationPositionError) => void) | null = null;
  public readonly clearWatch = vi.fn();

  watchPosition(
    success: (position: GeolocationPosition) => void,
    error?: (error: GeolocationPositionError) => void,
  ): number {
    this.success = success;
    this.error = error ?? null;
    return 1;
  }

  emitFix(): void {
    this.success?.({
      coords: { latitude: 37.42, longitude: -122.08, accuracy: 10 },
      timestamp: 1_700_000_000_000,
    } as unknown as GeolocationPosition);
  }

  emitError(code: number): void {
    this.error?.({
      code,
      message: 'browser detail',
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    } as GeolocationPositionError);
  }
}

describe('useDeviceLocation', () => {
  it('distinguishes Hub resolution states from browser permission state', () => {
    const geolocation = new FakeGeolocation();
    const { result, rerender } = renderHook(
      ({ hubStatus }) => useDeviceLocation({
        enabled: true,
        canSend: true,
        send: vi.fn(),
        geolocation: geolocation as unknown as Geolocation,
        hubStatus,
      }),
      { initialProps: { hubStatus: null as 'located' | 'unzoned' | 'poor_accuracy' | 'rejected' | null } },
    );

    expect(result.current).toBe('watching');
    rerender({ hubStatus: 'poor_accuracy' });
    expect(result.current).toBe('poor-accuracy');
    rerender({ hubStatus: 'unzoned' });
    expect(result.current).toBe('unzoned');
    rerender({ hubStatus: 'rejected' });
    expect(result.current).toBe('hub-rejected');
    rerender({ hubStatus: 'located' });
    expect(result.current).toBe('located');
  });

  it('recovers a transient browser error on the next valid fix', () => {
    const geolocation = new FakeGeolocation();
    const { result } = renderHook(() => useDeviceLocation({
      enabled: true,
      canSend: true,
      send: vi.fn(),
      geolocation: geolocation as unknown as Geolocation,
      hubStatus: 'located',
    }));

    act(() => geolocation.emitError(2));
    expect(result.current).toBe('error');
    act(() => geolocation.emitFix());
    expect(result.current).toBe('located');
  });
});

describe('location recovery copy', () => {
  it('does not misreport recoverable resolution states as broken permission', () => {
    expect(describeLocationNotice('poor-accuracy')).toContain('permission is on');
    expect(describeLocationNotice('hub-rejected')).toContain('permission is still on');
    expect(describeLocationStatus('unzoned')).toContain('sharing is working');
    expect(describeLocationStatus('denied')).toContain('turn sharing off and on');
    expect(describeLocationStatus('error')).toContain('recover automatically');
    expect(describeLocationNotice('located')).toBeNull();
  });
});
