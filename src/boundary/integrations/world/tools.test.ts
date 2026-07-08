import { describe, expect, it, vi } from 'vitest';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type {
  HomeAssistantCallServiceResult,
  HomeAssistantGetStatesResult,
  HomeAssistantState,
} from '../../gateway/protocol.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { WorldOperations } from './ops.js';
import { createWorldTool } from './tools.js';

const REGISTRY: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'site.home', displayName: 'Home', kind: 'physical' }],
  places: [
    {
      placeId: 'place.living-room',
      siteId: 'site.home',
      displayName: 'Living Room',
      kind: 'physical',
      affordances: [
        {
          affordanceId: 'lr_lights',
          role: 'effector',
          kind: 'light',
          backend: 'ha',
          displayName: 'Living Room Lights',
          entityId: 'light.living_room',
          control: ['on', 'off'],
        },
        {
          affordanceId: 'lr_presence',
          role: 'perceiver',
          kind: 'presence',
          backend: 'ha',
          displayName: 'Living Room Presence',
          entityId: 'binary_sensor.living_room_presence',
        },
        {
          affordanceId: 'lr_avatar',
          role: 'effector',
          kind: 'virtual_object',
          backend: 'vr',
          displayName: 'Virtual Avatar',
        },
      ],
    },
    {
      placeId: 'place.kitchen',
      siteId: 'site.home',
      displayName: 'Kitchen',
      kind: 'physical',
      affordances: [
        {
          affordanceId: 'kt_lights',
          role: 'effector',
          kind: 'light',
          backend: 'ha',
          entityId: 'light.kitchen',
        },
      ],
    },
  ],
};

const EMPTY_REGISTRY: PlacesRegistryConfig = { schemaVersion: 1, sites: [], places: [] };

function stateFor(entityId: string, state: string): HomeAssistantState {
  return { entity_id: entityId, state, attributes: {} };
}

function createMockOps(overrides: Partial<WorldOperations> = {}): WorldOperations {
  return {
    getStates: vi.fn(async (params?: { entityId?: string }): Promise<HomeAssistantGetStatesResult> => {
      const entityId = params?.entityId ?? '';
      const value = entityId.startsWith('light.') ? 'off' : 'on';
      return { states: [stateFor(entityId, value)], count: 1, entityId };
    }),
    callService: vi.fn(async (): Promise<HomeAssistantCallServiceResult> => ({
      domain: 'light',
      service: 'turn_off',
      response: {},
    })),
    ...overrides,
  };
}

function resultText(result: { content: Array<{ text: string }> }): string {
  return result.content.map((entry) => entry.text).join('');
}

// Effector control ships staged off and trust-gated; this helper opens both
// gates so the deeper actuation/validation paths can be exercised directly.
function createControlTool(ops: WorldOperations, trust: TrustLevel = 'primary') {
  return createWorldTool(ops, {
    placesRegistry: REGISTRY,
    controlEnabled: true,
    resolveRequesterTrust: () => trust,
  });
}

describe('world tool', () => {
  it('perceives the situated place and reads each affordance state via the gateway', async () => {
    const ops = createMockOps();
    const tool = createWorldTool(ops, {
      placesRegistry: REGISTRY,
      resolveSituatedPlaceId: () => 'place.living-room',
    });

    const result = await tool.execute('call-perceive', { action: 'perceive' });
    const payload = JSON.parse(resultText(result));

    expect(payload.action).toBe('perceive');
    expect(payload.placeId).toBe('place.living-room');
    expect(payload.place).toBe('Living Room');
    // Only the two HA-backed affordances are read (the vr affordance is skipped).
    expect(ops.getStates).toHaveBeenCalledTimes(2);
    expect(ops.getStates).toHaveBeenCalledWith({ entityId: 'light.living_room' });
    expect(ops.getStates).toHaveBeenCalledWith({ entityId: 'binary_sensor.living_room_presence' });
    expect(payload.readings.map((r: { affordanceId: string }) => r.affordanceId))
      .toEqual(['lr_lights', 'lr_presence']);
    expect(payload.summary).toContain('Living Room');
  });

  it('honors an explicit placeId over the situated default for perceive', async () => {
    const ops = createMockOps();
    const tool = createWorldTool(ops, {
      placesRegistry: REGISTRY,
      resolveSituatedPlaceId: () => 'place.living-room',
    });

    const result = await tool.execute('call-perceive', { action: 'perceive', placeId: 'place.kitchen' });
    const payload = JSON.parse(resultText(result));

    expect(payload.placeId).toBe('place.kitchen');
    expect(ops.getStates).toHaveBeenCalledWith({ entityId: 'light.kitchen' });
  });

  it('fails closed on perceive with no place and no situated default', async () => {
    const ops = createMockOps();
    const tool = createWorldTool(ops, { placesRegistry: REGISTRY });

    const result = await tool.execute('call-perceive', { action: 'perceive' });

    expect(ops.getStates).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('action=perceive requires a place');
    expect(result.details?.isError).toBe(true);
  });

  it('fails closed (clear error, no fake success) when Home Assistant is unconfigured', async () => {
    const ops = createMockOps({
      getStates: vi.fn(async () => {
        throw new Error('Home Assistant gateway methods are disabled in settings.json (homeAssistantEnabled=false)');
      }),
    });
    const tool = createWorldTool(ops, { placesRegistry: REGISTRY });

    const result = await tool.execute('call-perceive', { action: 'perceive', placeId: 'place.living-room' });

    expect(resultText(result)).toContain('world failed for action=perceive');
    expect(resultText(result)).toContain('disabled in settings.json');
    expect(result.details?.isError).toBe(true);
  });

  it('lists affordances for a single place by default', async () => {
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      resolveSituatedPlaceId: () => 'place.living-room',
    });

    const result = await tool.execute('call-list', { action: 'list' });
    const payload = JSON.parse(resultText(result));

    expect(payload.scope).toBe('place');
    expect(payload.places).toHaveLength(1);
    expect(payload.places[0].placeId).toBe('place.living-room');
    const lights = payload.places[0].affordances.find(
      (a: { affordanceId: string }) => a.affordanceId === 'lr_lights',
    );
    expect(lights.controllable).toBe(true);
    const avatar = payload.places[0].affordances.find(
      (a: { affordanceId: string }) => a.affordanceId === 'lr_avatar',
    );
    expect(avatar.controllable).toBe(false);
  });

  it('lists the whole site when scope=site', async () => {
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      resolveSituatedPlaceId: () => 'place.living-room',
    });

    const result = await tool.execute('call-list', { action: 'list', scope: 'site' });
    const payload = JSON.parse(resultText(result));

    expect(payload.scope).toBe('site');
    expect(payload.places.map((p: { placeId: string }) => p.placeId))
      .toEqual(['place.living-room', 'place.kitchen']);
  });

  it('controls an effector by calling the derived HA domain/service through the gateway', async () => {
    const ops = createMockOps();
    const tool = createControlTool(ops);

    const result = await tool.execute('call-control', {
      action: 'control',
      affordanceId: 'lr_lights',
      command: 'off',
    });
    const payload = JSON.parse(resultText(result));

    expect(ops.callService).toHaveBeenCalledWith({
      domain: 'light',
      service: 'turn_off',
      entityId: 'light.living_room',
    });
    expect(payload.action).toBe('control');
    expect(payload.affordanceId).toBe('lr_lights');
    expect(payload.placeId).toBe('place.living-room');
    expect(payload.service).toBe('turn_off');
  });

  it('rejects an affordanceId not in the registry BEFORE any RPC', async () => {
    const ops = createMockOps();
    const tool = createControlTool(ops);

    const result = await tool.execute('call-control', {
      action: 'control',
      affordanceId: 'ghost_switch',
      command: 'off',
    });

    expect(ops.callService).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('affordanceId "ghost_switch" is not in places.json');
    expect(result.details?.isError).toBe(true);
  });

  it('rejects controlling a perceiver and a non-HA backend before any RPC', async () => {
    const ops = createMockOps();
    const tool = createControlTool(ops);

    const perceiver = await tool.execute('call-control', {
      action: 'control',
      affordanceId: 'lr_presence',
      command: 'off',
    });
    expect(resultText(perceiver)).toContain('is a perceiver');

    const virtual = await tool.execute('call-control', {
      action: 'control',
      affordanceId: 'lr_avatar',
      command: 'off',
    });
    expect(resultText(virtual)).toContain('backend "vr"');

    expect(ops.callService).not.toHaveBeenCalled();
  });

  it('rejects control without a command', async () => {
    const ops = createMockOps();
    const tool = createControlTool(ops);

    const result = await tool.execute('call-control', { action: 'control', affordanceId: 'lr_lights' });

    expect(ops.callService).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('requires command as one of: on, off, toggle');
  });

  it('stages control off by default: refuses control fail-closed while perceive/list stay live', async () => {
    const ops = createMockOps();
    // Default deps: no controlEnabled, no resolveRequesterTrust ⇒ control OFF.
    const tool = createWorldTool(ops, {
      placesRegistry: REGISTRY,
      resolveSituatedPlaceId: () => 'place.living-room',
    });

    const control = await tool.execute('call-control', {
      action: 'control',
      affordanceId: 'lr_lights',
      command: 'on',
    });
    expect(ops.callService).not.toHaveBeenCalled();
    expect(control.details?.isError).toBe(true);
    expect(resultText(control)).toContain('staged off');

    // Read paths are unaffected by the staged-off control gate.
    const perceive = await tool.execute('call-perceive', { action: 'perceive' });
    expect(perceive.details?.isError).toBeFalsy();
    const list = await tool.execute('call-list', { action: 'list', scope: 'site' });
    expect(JSON.parse(resultText(list)).action).toBe('list');
  });

  it('with control enabled, rejects a low-trust requester and refuses before any RPC', async () => {
    const ops = createMockOps();
    for (const trust of ['regular', 'public'] as const) {
      const tool = createControlTool(ops, trust);
      const result = await tool.execute('call-control', {
        action: 'control',
        affordanceId: 'lr_lights',
        command: 'on',
      });
      expect(result.details?.isError).toBe(true);
      expect(resultText(result)).toContain('requires a primary or trusted requester');
    }
    expect(ops.callService).not.toHaveBeenCalled();
  });

  it('with control enabled and no trust resolver wired, refuses control fail-closed', async () => {
    const ops = createMockOps();
    const tool = createWorldTool(ops, { placesRegistry: REGISTRY, controlEnabled: true });
    const result = await tool.execute('call-control', {
      action: 'control',
      affordanceId: 'lr_lights',
      command: 'on',
    });
    expect(ops.callService).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('requires a primary or trusted requester');
  });

  it('with control enabled, allows primary and trusted requesters to drive effectors', async () => {
    for (const trust of ['primary', 'trusted'] as const) {
      const ops = createMockOps();
      const tool = createControlTool(ops, trust);
      const result = await tool.execute('call-control', {
        action: 'control',
        affordanceId: 'lr_lights',
        command: 'on',
      });
      expect(result.details?.isError).toBeFalsy();
      expect(ops.callService).toHaveBeenCalledTimes(1);
      expect(JSON.parse(resultText(result)).action).toBe('control');
    }
  });

  it('enforces the per-affordance command allowlist before any RPC', async () => {
    const ops = createMockOps();
    // lr_lights declares control: ['on','off']; "toggle" is not permitted.
    const tool = createControlTool(ops);
    const result = await tool.execute('call-control', {
      action: 'control',
      affordanceId: 'lr_lights',
      command: 'toggle',
    });
    expect(ops.callService).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('is not permitted for affordance "lr_lights"');
  });

  it('returns an empty site list against an empty registry without inventing places', async () => {
    const tool = createWorldTool(createMockOps(), { placesRegistry: EMPTY_REGISTRY });

    const result = await tool.execute('call-list', { action: 'list', scope: 'site' });
    const payload = JSON.parse(resultText(result));

    expect(payload.places).toEqual([]);
  });

  it('rejects an unknown action', async () => {
    const tool = createWorldTool(createMockOps(), { placesRegistry: REGISTRY });

    const result = await tool.execute('call-bad', { action: 'teleport' } as never);

    expect(resultText(result)).toContain('action must be one of');
  });
});
