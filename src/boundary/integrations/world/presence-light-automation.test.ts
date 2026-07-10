import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { registerPresenceLightAutomation } from './presence-light-automation.js';

const placesRegistry = {
  schemaVersion: 1 as const,
  sites: [{ siteId: 'home', displayName: 'Home', kind: 'physical' as const }],
  places: [
    { placeId: 'kitchen', siteId: 'home', displayName: 'Kitchen', kind: 'physical' as const, affordances: [
      { affordanceId: 'kitchen-light', role: 'effector' as const, kind: 'light' as const, backend: 'ha' as const, entityId: 'light.kitchen', control: ['on', 'off'] },
    ] },
    { placeId: 'office', siteId: 'home', displayName: 'Office', kind: 'physical' as const, affordances: [
      { affordanceId: 'office-light', role: 'effector' as const, kind: 'light' as const, backend: 'ha' as const, entityId: 'light.office', control: ['on', 'off'] },
    ] },
  ],
};

describe('registerPresenceLightAutomation', () => {
  it('turns off the exited room and turns on the entered room', async () => {
    const eventBus = new EventBus();
    const callService = vi.fn(async () => ({ domain: 'light', service: 'turn_on', response: null }));
    registerPresenceLightAutomation({
      eventBus,
      placesRegistry,
      operations: { getStates: vi.fn(), callService },
      enabled: true,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await eventBus.emit('presence.emanation.follow', {
      trigger: 'physical_presence', contactId: 'owner', satelliteId: 'office-sat',
      fromPlaceId: 'kitchen', toPlaceId: 'office', siteId: 'home', kind: 'physical', timestamp: Date.now(),
    });
    expect(callService).toHaveBeenNthCalledWith(1, expect.objectContaining({
      affordanceId: 'kitchen-light', service: 'turn_off', intent: 'presence_exit',
    }));
    expect(callService).toHaveBeenNthCalledWith(2, expect.objectContaining({
      affordanceId: 'office-light', service: 'turn_on', intent: 'presence_enter',
    }));
  });

  it('does not subscribe below autonomous tier', async () => {
    const eventBus = new EventBus();
    const callService = vi.fn();
    registerPresenceLightAutomation({ eventBus, placesRegistry, operations: { getStates: vi.fn(), callService }, enabled: false });
    await eventBus.emit('presence.emanation.follow', {
      trigger: 'physical_presence', contactId: 'owner', toPlaceId: 'office', siteId: 'home', kind: 'physical', timestamp: 1,
    });
    expect(callService).not.toHaveBeenCalled();
  });
});
