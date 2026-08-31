// Sprint 10 release-shakedown case catalog.
//
// Domain modules own their setup and exact persisted proofs. Multi-companion
// and capability-matrix cases remain in purpose-built artifacts whose
// top-level coverageCaseIds are consumed by the scorecard.

import { buildCogSecCases } from './sprint10/cogsec.mjs';
import { buildConversationCases } from './sprint10/conversation.mjs';
import { buildHubIdentityCases } from './sprint10/hub-identity.mjs';
import { buildPresenceCases } from './sprint10/presence.mjs';
import { buildWorldCases } from './sprint10/world.mjs';

export const SPRINT10_CASE_IDS = Object.freeze([
  's10_places_placeless',
  's10_mindspace_virtual',
  's10_places_physical',
  's10_mindspace_physical_precedence',
  's10_world_read_telemetry',
  's10_hub_identity_presence_follow',
  's10_cogsec_document_quarantine',
  's10_cogsec_satellite_document_quarantine',
  's10_temporal_stamp_strip',
  's10_sse_first_chunk',
]);

export function buildSprint10Cases(ctx, services, env = process.env) {
  const cases = [
    ...buildPresenceCases(ctx, services, env),
    ...buildWorldCases(ctx, services, env),
    ...buildHubIdentityCases(ctx, services, env),
    ...buildCogSecCases(ctx, services, env),
    ...buildConversationCases(ctx, services, env),
  ];
  const order = new Map(SPRINT10_CASE_IDS.map((id, index) => [id, index]));
  return cases.sort((left, right) => order.get(left.id) - order.get(right.id));
}
