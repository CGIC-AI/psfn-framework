// Code-owned privacy class of every decision site (epic 4lf3r).
//
// This is deliberately NOT an owner-file setting: whether a site's state may
// leave the process is a property of the data the site handles, not an
// operator preference. A `companion_private` site always answers locally, even
// when settings select `jev` or `shadow`. Cogsec blind review, introspection
// and values audits are not decision sites at all and never reach decide().
// Deliberately NOT decision sites (epic 4lf3r .8): the free-time chooser (the
// companion's private personal projects), ICP initiation consent (carries the
// companion's private reason) and the automata reviewer (its envelope writes a
// reason and replacement text).

import type { DecisionSiteId } from '../../../system/config/decision-backend-config.js';
import type { DecisionSitePrivacy } from './types.js';

const SITE_PRIVACY: Readonly<Record<DecisionSiteId, DecisionSitePrivacy>> = {
  // Group-room appraisal: quoted room lines only, no private history.
  'participation.appraise': 'shareable',
  // Private companion-dm (ICP) appraisal carries the conversation's own recent
  // turns (psfn-framework-p6s1f); private DM content never leaves the process.
  'participation.appraise_dm': 'companion_private',
  'room.ambiguity': 'shareable',
  'memory.rerank': 'shareable',
  'memory.query_intent': 'shareable',
  'intake.l2': 'shareable',
  'memory.extraction_pregate': 'shareable',
  // The post-turn appraisal payload is the companion's own inner state.
  'intention.post_turn_pregate': 'companion_private',
};

export function decisionSitePrivacy(siteId: DecisionSiteId): DecisionSitePrivacy {
  return SITE_PRIVACY[siteId];
}
