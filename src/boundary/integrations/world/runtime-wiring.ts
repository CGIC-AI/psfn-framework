import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { CompanionPresenceTurnPort } from '../../../core/agent/companion-presence-runtime.js';
import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import type { ToolWiringMeta, WirableTool } from '../../../core/agent/tool-wiring-validator.js';
import type { RoomEntryNoteSink } from '../../../core/session/room-entry-note.js';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { WorldOperations } from './ops.js';
import { createWorldTool } from './tools.js';

export interface WorldRuntimeTarget {
  registerTool: ToolRegistrar;
}

const WORLD_TOOL_GATEWAY_METHODS = [
  'home_assistant.get_states',
  'home_assistant.call_service',
] as const;

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterWorldToolsOptions {
  /** Places soft-registry (`places.json`) for agent-side affordance resolution. */
  placesRegistry: PlacesRegistryConfig;
  /** Resolves the companion's current situated placeId for deictic defaults. */
  resolveSituatedPlaceId?: () => string | undefined;
  /**
   * Presence turn port for `move` (contract s10wm; multi-companion only).
   * Null/absent = flag-off: moves are local-only (no shared-table write).
   */
  companionPresence?: CompanionPresenceTurnPort | null;
  /** Local situated-state seam for `move` (emanation-tracker virtual overlay). */
  applyVirtualMove?: (placeId: string) => void;
  /** Context-system-note sink for the room-entry note fired by `move`. */
  roomEntryNoteSink?: RoomEntryNoteSink;
  /** In gateway mode, attach requiredGatewayMethods so the wiring validator can check them. */
  gatewayMode?: boolean;
}

export function registerWorldTools(
  target: WorldRuntimeTarget,
  ops: WorldOperations,
  options: RegisterWorldToolsOptions,
): void {
  const tool: AgentTool<any> = createWorldTool(ops, {
    placesRegistry: options.placesRegistry,
    ...(options.resolveSituatedPlaceId ? { resolveSituatedPlaceId: options.resolveSituatedPlaceId } : {}),
    ...(options.companionPresence !== undefined ? { companionPresence: options.companionPresence } : {}),
    ...(options.applyVirtualMove ? { applyVirtualMove: options.applyVirtualMove } : {}),
    ...(options.roomEntryNoteSink ? { roomEntryNoteSink: options.roomEntryNoteSink } : {}),
  });
  if (options.gatewayMode) {
    attachWiringMeta(tool, { requiredGatewayMethods: [...WORLD_TOOL_GATEWAY_METHODS] });
  }
  // TODO(vinz.10): register `world` in CANONICAL_FIRST_PARTY_TOOL_SURFACES with
  // action-aware capabilityMetadata + capability/trust gating (`move` gates
  // read-tier alongside perceive/list, NOT with control). Extended for now.
  target.registerTool(tool, 'extended');
}
