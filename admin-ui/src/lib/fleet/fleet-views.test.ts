import { describe, expect, it } from 'vitest';
import {
  FLEET_VIEW_DESTINATIONS,
  fleetViewHref,
  isFleetView,
  resolveFleetView,
} from './fleet-views';

describe('fleet view destinations', () => {
  it('exposes the real /fleet surfaces as cluster-scoped destinations', () => {
    expect(FLEET_VIEW_DESTINATIONS.map(destination => destination.id)).toEqual([
      'info',
      'usage',
      'costs',
      'firewall',
    ]);
    for (const destination of FLEET_VIEW_DESTINATIONS) {
      expect(destination.label.length).toBeGreaterThan(0);
      expect(destination.description.length).toBeGreaterThan(0);
    }
  });

  it('accepts only known view identifiers', () => {
    expect(isFleetView('info')).toBe(true);
    expect(isFleetView('firewall')).toBe(true);
    expect(isFleetView('companions')).toBe(false);
    expect(isFleetView(null)).toBe(false);
  });
});

describe('fleetViewHref', () => {
  it('keeps the cluster overview on the canonical /fleet path', () => {
    expect(fleetViewHref('info')).toBe('/fleet');
  });

  it('encodes secondary views as query state', () => {
    expect(fleetViewHref('usage')).toBe('/fleet?view=usage');
    expect(fleetViewHref('costs')).toBe('/fleet?view=costs');
    expect(fleetViewHref('firewall')).toBe('/fleet?view=firewall');
  });
});

describe('resolveFleetView', () => {
  it('defaults to the cluster health overview', () => {
    expect(resolveFleetView('')).toBe('info');
    expect(resolveFleetView('?range=today')).toBe('info');
  });

  it('honors an explicit view parameter', () => {
    expect(resolveFleetView('?view=usage')).toBe('usage');
    expect(resolveFleetView('?view=costs')).toBe('costs');
    expect(resolveFleetView('?view=firewall')).toBe('firewall');
  });

  it('rejects unknown view parameters instead of guessing', () => {
    expect(resolveFleetView('?view=companions')).toBe('info');
    expect(resolveFleetView('?view=../../etc')).toBe('info');
  });

  it('maps legacy fleet fragments onto their views', () => {
    expect(resolveFleetView('', '#fleet-costs')).toBe('costs');
    expect(resolveFleetView('', '#fleet-usage')).toBe('usage');
    expect(resolveFleetView('', '#unrelated')).toBe('info');
  });

  it('prefers the explicit view parameter over a fragment', () => {
    expect(resolveFleetView('?view=firewall', '#fleet-costs')).toBe('firewall');
  });
});
