// ── Situated-presence section producer (S10, Workstream B1) ──
// Renders the "where am I / what's here / who else is here" runtime block for a
// turn. This is the FIRST consumer of `message.routing.presence`
// (CompanionPresenceMetadata) and of the places soft-registry (places.json).
//
// Fail-closed: a turn with neither presence NOR a resolvable place renders
// nothing (no placeholder noise, no fabricated location). When a place cannot
// be resolved we fall back only to honest presence-derived hints
// (label / siteId), never an invented location.
//
// Layering note: resolution is done inline against the registry arrays rather
// than importing the `channels/backplane/places-registry` value helpers, so
// this core module keeps its type-only dependency on `channels` (no new
// value-level core→channels coupling). Registry TYPES come from the neutral
// `shared/contracts` module.

import { isRecord } from '../../../../shared/utils/types.js';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import type {
  AffordanceConfig,
  PlaceConfig,
  PlacesRegistryConfig,
  SiteConfig,
} from '../../../../shared/contracts/places-registry.js';
import type { CompanionPresenceMetadata } from '../../presence-metadata.js';
import { wrapPromptSectionXml } from '../../../identity/prompt-sections.js';

/**
 * A co-present companion sharing this place. Multi-companion W5 will populate
 * this from the shared `companion_presence` table (keyed on siteId/placeId);
 * until then single-companion turns always pass `[]` and the "who else is here"
 * line is omitted.
 */
export interface CoPresentCompanion {
  companionId: string;
  displayName: string;
}

export interface SituatedPresenceContextInput {
  message: SubstrateMessage;
  /**
   * Places soft-registry. Optional/undefined is treated as an empty registry so
   * that a runtime with no `places.json` renders byte-identically (no block).
   */
  placesRegistry?: PlacesRegistryConfig;
  /** Co-present companions; defaults to empty (single-companion turns). */
  coPresent?: ReadonlyArray<CoPresentCompanion>;
}

/**
 * Defensive, type-safe read of an optional `placeId` off satellite routing
 * metadata. A sibling workstream (A2) adds `placeId` to
 * `SatelliteRoutingMetadata` on a separate branch; this branch must NOT touch
 * that contract, so we read the field structurally (possibly-undefined) instead
 * of via the declared type.
 */
function readSatellitePlaceId(satellite: unknown): string | undefined {
  if (!isRecord(satellite)) return undefined;
  const placeId = satellite.placeId;
  if (typeof placeId !== 'string') return undefined;
  const trimmed = placeId.trim();
  return trimmed ? trimmed : undefined;
}

function resolvePlace(
  registry: PlacesRegistryConfig | undefined,
  placeId: string | undefined,
): PlaceConfig | undefined {
  if (!registry || !placeId) return undefined;
  return registry.places.find((place) => place.placeId === placeId);
}

function resolveSite(
  registry: PlacesRegistryConfig | undefined,
  siteId: string,
): SiteConfig | undefined {
  if (!registry) return undefined;
  return registry.sites.find((site) => site.siteId === siteId);
}

function formatAffordanceLine(affordance: AffordanceConfig): string {
  // Display name / kind / role only — deliberately no control wiring here.
  const name = affordance.displayName?.trim() || affordance.affordanceId;
  return `- ${name} (${affordance.kind}, ${affordance.role})`;
}

/**
 * The place a turn is situated at, as resolved from its satellite routing
 * metadata against the places registry. This is the SAME resolution the
 * situated block below performs, exported so the multi-companion presence
 * writer (W5a) and the co-presence read key on identical coordinates.
 */
export interface SituatedPlaceRef {
  siteId: string;
  placeId: string;
  kind: PlaceConfig['kind'];
}

export function resolveSituatedPlaceRef(
  message: SubstrateMessage,
  registry: PlacesRegistryConfig | undefined,
): SituatedPlaceRef | undefined {
  const placeId = readSatellitePlaceId(message.routing?.satellite);
  const place = resolvePlace(registry, placeId);
  if (!place) return undefined;
  return { siteId: place.siteId, placeId: place.placeId, kind: place.kind };
}

export function buildSituatedPresenceContextBlock(input: SituatedPresenceContextInput): string {
  const registry = input.placesRegistry;
  const presence: CompanionPresenceMetadata | undefined = input.message.routing?.presence;
  const placeId = readSatellitePlaceId(input.message.routing?.satellite);
  const place = resolvePlace(registry, placeId);
  const coPresent = input.coPresent ?? [];

  // Fail-closed: nothing honest to say about location → render no block.
  if (!presence && !place) return '';

  const lines: string[] = ['[Situated presence]'];

  if (place) {
    lines.push(`Here: ${place.displayName} (${place.kind} place)`);
    const site = resolveSite(registry, place.siteId);
    if (site && site.displayName !== place.displayName) {
      lines.push(`Site: ${site.displayName}`);
    }
    const description = place.description?.trim();
    if (description) {
      lines.push(`Surroundings: ${description}`);
    }
  } else {
    // No place resolved: honest fallback to presence-derived hints only.
    const label = presence?.label?.trim() || presence?.siteId?.trim();
    lines.push(label ? `Here: ${label}` : 'Here: (location not modeled)');
  }

  // Affordances come from the resolved place only. Group by role for clarity;
  // control of effectors is mediated globally by the world tool, not wired here.
  const affordances = place?.affordances ?? [];
  const perceivers = affordances.filter((affordance) => affordance.role === 'perceiver');
  const effectors = affordances.filter((affordance) => affordance.role === 'effector');
  if (perceivers.length > 0) {
    lines.push('Perceivers here (what can sense this place):');
    for (const affordance of perceivers) lines.push(formatAffordanceLine(affordance));
  }
  if (effectors.length > 0) {
    lines.push('Effectors here (control is mediated by the world tool, not wired into this block):');
    for (const affordance of effectors) lines.push(formatAffordanceLine(affordance));
  }

  // "Who else is here" — only when non-empty. Multi-companion W5 populates
  // coPresent from the shared companion_presence table.
  if (coPresent.length > 0) {
    const names = coPresent
      .map((companion) => companion.displayName.trim() || companion.companionId)
      .join(', ');
    lines.push(`Also here: ${names}`);
  }

  return wrapPromptSectionXml({
    id: 'runtime_situated_presence',
    content: lines.join('\n'),
  });
}
