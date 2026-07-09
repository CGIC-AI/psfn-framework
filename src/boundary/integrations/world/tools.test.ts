import { describe, expect, it, vi } from 'vitest';
import type { CompanionPresenceTurnPort } from '../../../core/agent/companion-presence-runtime.js';
import type { SituatedPlaceRef } from '../../../core/agent/substrate-agent/runtime-context-sections/situated-presence.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
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
  sites: [
    { siteId: 'site.home', displayName: 'Home', kind: 'physical' },
    { siteId: 'site.mud', displayName: 'The MUD', kind: 'virtual' },
  ],
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
    {
      placeId: 'place.mud-tavern',
      siteId: 'site.mud',
      displayName: 'The Rusty Tankard',
      kind: 'virtual',
      description: 'A low-beamed virtual tavern; a fire crackles in the hearth.',
      affordances: [
        {
          affordanceId: 'tv_dartboard',
          role: 'effector',
          kind: 'virtual_object',
          backend: 'vr',
          displayName: 'Dartboard',
        },
      ],
    },
    {
      placeId: 'place.mud-cellar',
      siteId: 'site.mud',
      displayName: 'The Cellar',
      kind: 'virtual',
      affordances: [],
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
      .toEqual(['place.living-room', 'place.kitchen', 'place.mud-tavern', 'place.mud-cellar']);
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

// ── `move` — deliberate virtual navigation (vinz.26, contract s10wm) ──

/** Recording fake of the presence turn port; the ONLY presence seam move may use. */
function makeFakePresencePort(coPresent: Array<{ companionId: string; displayName: string }> = []): {
  port: CompanionPresenceTurnPort;
  moves: SituatedPlaceRef[];
} {
  const moves: SituatedPlaceRef[] = [];
  const port: CompanionPresenceTurnPort = {
    observeTurnPlace: vi.fn(async () => undefined),
    refreshOwnPresence: vi.fn(async () => undefined),
    recordDeliberateMove: vi.fn(async (place: SituatedPlaceRef) => {
      moves.push(place);
    }),
    getCoPresent: vi.fn(() => coPresent),
  };
  return { port, moves };
}

function makeNoteSink(): {
  sink: { appendContextSystemNote: ReturnType<typeof vi.fn> };
  notes: Array<{ channelId: string; note: string; source: string }>;
} {
  const notes: Array<{ channelId: string; note: string; source: string }> = [];
  const appendContextSystemNote = vi.fn((channelId: string, note: string, source: string) => {
    notes.push({ channelId, note, source });
  });
  return { sink: { appendContextSystemNote }, notes };
}

const TAVERN_REF: SituatedPlaceRef = {
  siteId: 'site.mud',
  placeId: 'place.mud-tavern',
  kind: 'virtual',
};

describe('world tool — move', () => {
  it('fails closed on an unknown destination (no port write, no local state)', async () => {
    const { port } = makeFakePresencePort();
    const applyVirtualMove = vi.fn();
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      companionPresence: port,
      applyVirtualMove,
    });

    const result = await tool.execute('call-move', { action: 'move', placeId: 'place.nowhere' });

    expect(resultText(result)).toContain('placeId "place.nowhere" is not in places.json');
    expect(result.details?.isError).toBe(true);
    expect(port.recordDeliberateMove).not.toHaveBeenCalled();
    expect(applyVirtualMove).not.toHaveBeenCalled();
  });

  it('fails closed on a physical destination with an explain-why error', async () => {
    const { port } = makeFakePresencePort();
    const applyVirtualMove = vi.fn();
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      companionPresence: port,
      applyVirtualMove,
    });

    const result = await tool.execute('call-move', { action: 'move', placeId: 'place.kitchen' });

    const text = resultText(result);
    expect(result.details?.isError).toBe(true);
    expect(text).toContain('it is a physical place');
    expect(text).toContain('emanation-driven');
    expect(text).toContain('move applies to virtual places only');
    expect(port.recordDeliberateMove).not.toHaveBeenCalled();
    expect(applyVirtualMove).not.toHaveBeenCalled();
  });

  it('requires a placeId', async () => {
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      applyVirtualMove: vi.fn(),
    });
    const result = await tool.execute('call-move', { action: 'move' });
    expect(resultText(result)).toContain('action=move requires placeId');
    expect(result.details?.isError).toBe(true);
  });

  it('moves to a virtual place through the presence port ONLY and applies the local overlay', async () => {
    const { port, moves } = makeFakePresencePort([
      { companionId: 'companion-b', displayName: 'companion-b' },
    ]);
    const applyVirtualMove = vi.fn();
    const { sink, notes } = makeNoteSink();
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      companionPresence: port,
      applyVirtualMove,
      roomEntryNoteSink: sink,
    });

    const result = await runWithRequestContext(
      { channelId: 'discord:room-1' },
      async () => tool.execute('call-move', { action: 'move', placeId: 'place.mud-tavern' }),
    );
    const payload = JSON.parse(resultText(result));

    // Presence written through the turn port, virtual kind — the single seam.
    expect(port.recordDeliberateMove).toHaveBeenCalledTimes(1);
    expect(moves).toEqual([TAVERN_REF]);
    // Local situated overlay applied AFTER the shared write succeeded.
    expect(applyVirtualMove).toHaveBeenCalledWith('place.mud-tavern');

    // MUD-style result: destination description + who's here + exits.
    expect(payload.action).toBe('move');
    expect(payload.placeId).toBe('place.mud-tavern');
    expect(payload.kind).toBe('virtual');
    expect(payload.description).toContain('low-beamed virtual tavern');
    expect(payload.alsoHere).toEqual(['companion-b']);
    expect(payload.exits).toEqual([
      {
        placeId: 'place.mud-cellar',
        displayName: 'The Cellar',
        kind: 'virtual',
        movable: true,
      },
    ]);
    expect(payload.presenceWrite).toBe('shared');
    expect(payload.summary).toContain('You are now in The Rusty Tankard.');
    expect(payload.summary).toContain('Also here: companion-b.');
    expect(payload.summary).toContain('The Cellar (place.mud-cellar)');

    // Room-entry note fired into the invoking session with correct occupants.
    expect(payload.roomEntryNote).toBe('delivered');
    expect(notes).toHaveLength(1);
    expect(notes[0].channelId).toBe('discord:room-1');
    expect(notes[0].source).toBe('room_entry');
    expect(notes[0].note).toContain('[Room entry]');
    expect(notes[0].note).toContain('You have entered room place.mud-tavern — The Rusty Tankard (virtual).');
    expect(notes[0].note).toContain('Also present: companion-b (companion).');
    expect(notes[0].note).toContain('You can act on Dartboard here.');
  });

  it('exits list spans the destination SITE (v1 adjacency = same-site siblings)', async () => {
    // Move within the physical/virtual mixed registry: a virtual place whose
    // site has no siblings reports no exits rather than inventing adjacency.
    const soloRegistry: PlacesRegistryConfig = {
      schemaVersion: 1,
      sites: [{ siteId: 'site.solo', displayName: 'Solo', kind: 'virtual' }],
      places: [{
        placeId: 'place.solo-room',
        siteId: 'site.solo',
        displayName: 'Solo Room',
        kind: 'virtual',
        affordances: [],
      }],
    };
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: soloRegistry,
      applyVirtualMove: vi.fn(),
    });

    const result = await tool.execute('call-move', { action: 'move', placeId: 'place.solo-room' });
    const payload = JSON.parse(resultText(result));

    expect(payload.exits).toEqual([]);
    expect(payload.summary).toContain('There are no other places at this site.');
  });

  it('flag-off (no port): move is local-only — overlay updates, no shared write, honest note', async () => {
    const applyVirtualMove = vi.fn();
    const { sink, notes } = makeNoteSink();
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      companionPresence: null,
      applyVirtualMove,
      roomEntryNoteSink: sink,
    });

    const result = await runWithRequestContext(
      { channelId: 'discord:room-1' },
      async () => tool.execute('call-move', { action: 'move', placeId: 'place.mud-tavern' }),
    );
    const payload = JSON.parse(resultText(result));

    expect(result.details?.isError).toBeUndefined();
    expect(applyVirtualMove).toHaveBeenCalledWith('place.mud-tavern');
    expect(payload.presenceWrite).toBe('local_only');
    expect(payload.alsoHere).toEqual([]);
    expect(notes[0].note).toContain('No one else is here.');
  });

  it('aborts the move BEFORE local state when the shared presence write fails', async () => {
    const applyVirtualMove = vi.fn();
    const { sink, notes } = makeNoteSink();
    const port: CompanionPresenceTurnPort = {
      observeTurnPlace: vi.fn(async () => undefined),
      refreshOwnPresence: vi.fn(async () => undefined),
      recordDeliberateMove: vi.fn(async () => {
        throw new Error('shared schema unavailable');
      }),
      getCoPresent: vi.fn(() => []),
    };
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      companionPresence: port,
      applyVirtualMove,
      roomEntryNoteSink: sink,
    });

    const result = await tool.execute('call-move', { action: 'move', placeId: 'place.mud-tavern' });

    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('shared schema unavailable');
    expect(applyVirtualMove).not.toHaveBeenCalled();
    expect(notes).toHaveLength(0);
  });

  it('fails closed when the local situated seam is unwired (no silent partial move)', async () => {
    const tool = createWorldTool(createMockOps(), { placesRegistry: REGISTRY });
    const result = await tool.execute('call-move', { action: 'move', placeId: 'place.mud-tavern' });
    expect(result.details?.isError).toBe(true);
    expect(resultText(result)).toContain('move is not wired');
  });

  it('reports the note as skipped when no invoking channel resolves (no silent pretend)', async () => {
    const { sink, notes } = makeNoteSink();
    const tool = createWorldTool(createMockOps(), {
      placesRegistry: REGISTRY,
      applyVirtualMove: vi.fn(),
      roomEntryNoteSink: sink,
    });

    // No ambient request context: the note cannot target a session.
    const result = await tool.execute('call-move', { action: 'move', placeId: 'place.mud-tavern' });
    const payload = JSON.parse(resultText(result));

    expect(payload.roomEntryNote).toBe('skipped_no_channel');
    expect(notes).toHaveLength(0);
  });
});
