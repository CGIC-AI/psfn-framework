import { useEffect, useState } from 'react';
import {
  startDeviceLocationWatch,
  type DeviceLocationSample,
  type DeviceLocationWatch,
} from '../lib/geolocation.js';

/**
 * Foreground-only device-location watcher for the Companion PWA
 * (bead psfn-framework-7ang.8).
 *
 * Browser PWAs get no background GPS — accepted v1 limit: "she knows where you
 * are when the app is open". The watch runs only while:
 *   - the Partner has enabled location sharing, AND
 *   - the active transport can terminate coordinates at a hub (`canSend`), AND
 *   - the document is foregrounded (visible).
 *
 * Raw coordinates never reach PSFN: `send` must be the hub transport's
 * device.location sink, which the gateway transport refuses (fail closed).
 */
export type DeviceLocationStatus =
  | 'off' // Partner has not enabled location
  | 'unsupported' // no geolocation API in this environment
  | 'transport-unavailable' // enabled, but the transport cannot terminate coordinates
  | 'suspended' // enabled + supported, but the app is backgrounded
  | 'watching' // actively feeding significant-change samples
  | 'denied' // the Partner denied the browser permission
  | 'error'; // geolocation reported a non-permission error

export interface UseDeviceLocationOptions {
  enabled: boolean;
  canSend: boolean;
  send: (sample: DeviceLocationSample) => void;
  /** Injectable for tests; defaults to navigator.geolocation. */
  geolocation?: typeof navigator.geolocation | null;
}

function resolveGeolocation(
  override: UseDeviceLocationOptions['geolocation'],
): Geolocation | null {
  if (override !== undefined) {
    return override ?? null;
  }
  if (typeof navigator === 'undefined') {
    return null;
  }
  return navigator.geolocation ?? null;
}

function isForeground(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function useDeviceLocation(options: UseDeviceLocationOptions): DeviceLocationStatus {
  const { enabled, canSend, send } = options;
  const geolocation = resolveGeolocation(options.geolocation);
  const [visible, setVisible] = useState<boolean>(() => isForeground());
  const [denied, setDenied] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Reset transient permission/error state when the Partner turns location off.
  useEffect(() => {
    if (!enabled) {
      setDenied(false);
      setErrored(false);
    }
  }, [enabled]);

  const active = enabled && canSend && visible && geolocation !== null && !denied;

  useEffect(() => {
    if (!active || geolocation === null) return;
    let watch: DeviceLocationWatch | null = startDeviceLocationWatch({
      geolocation,
      send,
      onError: (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setDenied(true);
        } else {
          setErrored(true);
        }
      },
    });
    return () => {
      watch?.stop();
      watch = null;
    };
  }, [active, geolocation, send]);

  if (!enabled) return 'off';
  if (geolocation === null) return 'unsupported';
  if (!canSend) return 'transport-unavailable';
  if (denied) return 'denied';
  if (errored) return 'error';
  if (!visible) return 'suspended';
  return 'watching';
}
