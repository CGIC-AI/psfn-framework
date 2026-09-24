// Code-owned privacy class of every decision site (epic 4lf3r).
//
// This is deliberately NOT an owner-file setting: whether a site's state may
// leave the process is a property of the data the site handles, not an
// operator preference. A `companion_private` site always answers locally, even
// when settings select `jev` or `shadow`. Cogsec blind review, introspection
// and values audits are not decision sites at all and never reach decide().

import type { DecisionSiteId } from '../../../system/config/decision-backend-config.js';
import type { DecisionSitePrivacy } from './types.js';

const SITE_PRIVACY: Readonly<Record<DecisionSiteId, DecisionSitePrivacy>> = {
  'participation.appraise': 'shareable',
  'room.ambiguity': 'shareable',
  'memory.rerank': 'shareable',
  'memory.query_intent': 'shareable',
  'intake.l2': 'shareable',
  'automata.review': 'shareable',
  'scheduler.free_time': 'companion_private',
  'icp.initiation_consent': 'shareable',
  'memory.extraction_pregate': 'shareable',
  'intention.post_turn_pregate': 'companion_private',
};

export function decisionSitePrivacy(siteId: DecisionSiteId): DecisionSitePrivacy {
  return SITE_PRIVACY[siteId];
}
