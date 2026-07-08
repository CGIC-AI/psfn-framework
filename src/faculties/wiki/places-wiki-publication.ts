// ── places.json → shared-world wiki publication (S10 vinz.4) ──
//
// A DETERMINISTIC projection that generates/refreshes browsable shared-world
// wiki pages from the `places.json` soft-registry: one site-overview page plus
// one page per place, scoped `shared_world:<siteId>`. The registry stays the
// single source of truth; these pages are a derived, read-only projection.
//
// This is an OPERATOR/CARETAKER surface. It writes shared-world scope through
// the operator-owned SharedWorldWikiStore (never the companion personal store),
// so the W5b companion-side shared-write rejection is untouched.
//
// Idempotent: re-running compares each generated page against what is already on
// disk (title + tags + body) and writes ONLY changed/new pages; pages for places
// that were removed from the registry are pruned. Re-running with an unchanged
// registry is a no-op (no version churn, no duplicate pages).

import {
  resolveSiteById,
  resolveAffordancesForPlace,
} from '../../channels/backplane/places-registry.js';
import type {
  AffordanceConfig,
  PlaceConfig,
  PlacesRegistryConfig,
} from '../../shared/contracts/places-registry.js';
import { normalizeWikiDocumentId, type SharedWorldWikiStore } from './store.js';

/** Marker tag on every generated page; the prune step only ever deletes these. */
export const PLACES_PUBLICATION_TAG = 'generated:places';
const SITE_OVERVIEW_PAGE_ID = 'site-overview';

export interface WikiPageDraft {
  id: string;
  title: string;
  tags: string[];
  summary?: string;
  body: string;
}

export interface PlacesWikiPublicationReport {
  siteId: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
}

function placePageId(placeId: string): string {
  const slug = placeId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalizeWikiDocumentId(`place-${slug || 'unnamed'}`.slice(0, 96));
}

function affordanceLine(affordance: AffordanceConfig): string {
  const name = affordance.displayName ?? affordance.affordanceId;
  const parts = [`**${name}** (\`${affordance.affordanceId}\`)`, `${affordance.role} · ${affordance.kind} · via ${affordance.backend}`];
  if (affordance.entityId) parts.push(`entity \`${affordance.entityId}\``);
  if (affordance.control && affordance.control.length > 0) {
    parts.push(`controls: ${affordance.control.join(', ')}`);
  }
  return `- ${parts.join(' — ')}`;
}

function renderAffordanceSection(affordances: readonly AffordanceConfig[]): string {
  if (affordances.length === 0) {
    return 'No affordances are registered here yet.';
  }
  const perceivers = affordances.filter(a => a.role === 'perceiver');
  const effectors = affordances.filter(a => a.role === 'effector');
  const sections: string[] = [];
  if (perceivers.length > 0) {
    sections.push(`### What can be perceived here\n\n${perceivers.map(affordanceLine).join('\n')}`);
  }
  if (effectors.length > 0) {
    sections.push(`### What can be controlled here\n\n${effectors.map(affordanceLine).join('\n')}`);
  }
  return sections.join('\n\n');
}

function renderPlacePage(place: PlaceConfig, affordances: readonly AffordanceConfig[]): WikiPageDraft {
  const lines: string[] = [`# ${place.displayName}`, ''];
  lines.push(`_${place.kind} place in site \`${place.siteId}\` (placeId \`${place.placeId}\`)._`, '');
  if (place.description) lines.push(place.description, '');
  if (place.haAreaId) lines.push(`Home Assistant area: \`${place.haAreaId}\`.`, '');
  lines.push(renderAffordanceSection(affordances));
  return {
    id: placePageId(place.placeId),
    title: place.displayName,
    tags: [PLACES_PUBLICATION_TAG, `site:${place.siteId}`, `place:${place.placeId}`],
    summary: place.description ?? `${place.displayName} (${place.kind} place).`,
    body: `${lines.join('\n').trim()}\n`,
  };
}

function renderSiteOverview(
  registry: PlacesRegistryConfig,
  siteId: string,
  places: readonly PlaceConfig[],
): WikiPageDraft {
  const site = resolveSiteById(registry, siteId);
  const displayName = site?.displayName ?? siteId;
  const lines: string[] = [`# ${displayName} — World Overview`, ''];
  lines.push(`_Shared-world knowledge for site \`${siteId}\`. Derived from the places registry; the registry is the source of truth._`, '');
  if (places.length === 0) {
    lines.push('No places are registered for this site yet.');
  } else {
    lines.push('## Places', '');
    for (const place of places) {
      const affordances = resolveAffordancesForPlace(registry, place.placeId);
      const affordanceSummary = affordances.length > 0
        ? affordances.map(a => a.displayName ?? a.affordanceId).join(', ')
        : 'no registered affordances';
      const descr = place.description ? ` — ${place.description}` : '';
      lines.push(`- **${place.displayName}** (\`${place.placeId}\`, ${place.kind})${descr}`);
      lines.push(`  - Affordances: ${affordanceSummary}`);
    }
  }
  return {
    id: SITE_OVERVIEW_PAGE_ID,
    title: `${displayName} — World Overview`,
    tags: [PLACES_PUBLICATION_TAG, `site:${siteId}`, 'overview'],
    summary: `Browsable world overview for ${displayName}.`,
    body: `${lines.join('\n').trim()}\n`,
  };
}

/**
 * Build the ordered set of shared-world wiki pages for one site. Pure and
 * deterministic. Fails closed when the siteId is unknown to the registry.
 */
export function buildSiteWikiPages(registry: PlacesRegistryConfig, siteId: string): WikiPageDraft[] {
  if (!resolveSiteById(registry, siteId)) {
    throw new Error(`places→wiki publication: unknown siteId "${siteId}" (not present in places.json sites)`);
  }
  const places = registry.places.filter(place => place.siteId === siteId);
  const pages: WikiPageDraft[] = [renderSiteOverview(registry, siteId, places)];
  for (const place of places) {
    pages.push(renderPlacePage(place, resolveAffordancesForPlace(registry, place.placeId)));
  }
  return pages;
}

/**
 * Publish (create/refresh, idempotent) the shared-world wiki pages for one site
 * into an operator-owned SharedWorldWikiStore. Writes only changed/new pages and
 * prunes generated pages whose place was removed from the registry.
 */
export function publishSiteWiki(
  store: SharedWorldWikiStore,
  registry: PlacesRegistryConfig,
  siteId: string,
  options: { updatedBy?: string } = {},
): PlacesWikiPublicationReport {
  if (store.siteId !== siteId) {
    throw new Error(
      `places→wiki publication: store site "${store.siteId}" does not match requested site "${siteId}"`,
    );
  }
  const drafts = buildSiteWikiPages(registry, siteId);
  const desiredIds = new Set(drafts.map(draft => draft.id));
  const updatedBy = options.updatedBy ?? 'places-wiki-publisher';

  const report: PlacesWikiPublicationReport = {
    siteId,
    created: [],
    updated: [],
    unchanged: [],
    deleted: [],
  };

  for (const draft of drafts) {
    const existing = store.get(draft.id);
    const bodyNormalized = draft.body.endsWith('\n') ? draft.body : `${draft.body}\n`;
    const isUnchanged = existing !== null
      && existing.title === draft.title
      && existing.body === bodyNormalized
      && existing.tags.length === draft.tags.length
      && existing.tags.every((tag, index) => tag === draft.tags[index]?.toLowerCase());
    if (isUnchanged) {
      report.unchanged.push(draft.id);
      continue;
    }
    store.upsert({
      id: draft.id,
      title: draft.title,
      body: draft.body,
      tags: draft.tags,
      ...(draft.summary ? { summary: draft.summary } : {}),
      sourceClass: 'system_seed',
      updatedBy,
    });
    if (existing) report.updated.push(draft.id);
    else report.created.push(draft.id);
  }

  // Prune generated pages whose place is gone. Only ever touch pages this
  // projection generated (marked with PLACES_PUBLICATION_TAG) — never an
  // operator-imported doc that happens to share the id prefix.
  for (const entry of store.list()) {
    if (desiredIds.has(entry.id)) continue;
    if (!entry.tags.includes(PLACES_PUBLICATION_TAG)) continue;
    if (store.delete(entry.id)) report.deleted.push(entry.id);
  }

  return report;
}
