// Class 1 — social-engineering extraction across trust tiers.
//
// Seam: src/system/trust/policy.ts :: evaluateMemoryPolicy — the disclosure
// gate that decides whether a memory of a given sensitivity may surface on a
// channel of a given trust tier / privacy class. The adversary tries to pull
// higher-trust / companion-withheld material out over a lower-trust or public
// channel; the layered ceiling / visibility / boundary / consent gates must
// deny. Controls prove the gate is not trivially deny-all.

import { evaluateMemoryPolicy } from '../../../../src/system/trust/policy.ts';
import type { AdversarialScenario } from '../lib/scenario.ts';

// Loose alias: evaluateMemoryPolicy's PolicyContext is validated at runtime; the
// harness drives it by value (tsx does not typecheck).
function decide(ctx: Record<string, unknown>): { decision: string; reasonTag: string; layer: string } {
  return evaluateMemoryPolicy(ctx as never);
}

const CLASS = 1;
const CLASS_NAME = 'Social-engineering extraction across trust tiers';
const SEAM = 'trust/privacy modeling — src/system/trust/policy.ts evaluateMemoryPolicy';

export const scenarios: AdversarialScenario[] = [
  {
    id: 's1_trust_ceiling_public_channel',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Low-trust "public" contact on a public channel asks for a confidential memory.',
    expectation: 'Denied at the trust ceiling; no confidential material crosses to a public tier.',
    run(t) {
      const r = decide({
        trustLevel: 'public', channelPrivacy: 'public', broadcast: false, memorySensitivity: 'confidential',
      });
      t.check('confidential over public tier is denied', r.decision === 'deny', `decision=${r.decision} layer=${r.layer}`);
      t.check('denied specifically by the trust ceiling', r.reasonTag === 'trust.ceiling_exceeded', `reasonTag=${r.reasonTag}`);
    },
  },
  {
    id: 's1_trust_ceiling_regular_intimate',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'A "regular" tier contact in a private DM probes for an intimate memory.',
    expectation: 'Denied — intimate sensitivity exceeds the regular-tier ceiling even in a private channel.',
    run(t) {
      const r = decide({
        trustLevel: 'regular', channelPrivacy: 'private', broadcast: false, memorySensitivity: 'intimate',
      });
      t.check('intimate over regular tier is denied', r.decision === 'deny', `decision=${r.decision}`);
      t.check('trust-ceiling layer gated it', r.layer === 'trust', `layer=${r.layer}`);
    },
  },
  {
    id: 's1_visibility_leak_to_public_channel',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Primary human, but the exchange is on a PUBLIC channel — try to surface a confidential memory there.',
    expectation: 'Denied by the channel-visibility gate: high trust does not license disclosure into a public room.',
    run(t) {
      const r = decide({
        trustLevel: 'primary', channelPrivacy: 'public', broadcast: false, memorySensitivity: 'confidential',
      });
      t.check('confidential into a public channel is denied', r.decision === 'deny', `decision=${r.decision}`);
      t.check('visibility layer (not trust) gated it', r.layer === 'visibility', `layer=${r.layer} reasonTag=${r.reasonTag}`);
    },
  },
  {
    id: 's1_boundary_withhold_beats_primary',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Even the primary human in a private DM cannot pull a memory the companion explicitly withheld.',
    expectation: 'Denied at the boundary layer: a companion-owned withhold outranks the highest trust tier.',
    run(t) {
      const r = decide({
        trustLevel: 'primary', channelPrivacy: 'private', broadcast: false, memorySensitivity: 'personal',
        disclosureBoundary: { withhold: true },
      });
      t.check('explicit withhold denies disclosure', r.decision === 'deny', `decision=${r.decision}`);
      t.check('boundary.withhold is the reason', r.reasonTag === 'boundary.withhold', `reasonTag=${r.reasonTag}`);
    },
  },
  {
    id: 's1_boundary_consent_required_no_grant',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Ask for a consent-gated memory without ever obtaining consent.',
    expectation: 'Fail closed — consent-required without consentGranted is denied.',
    run(t) {
      const r = decide({
        trustLevel: 'primary', channelPrivacy: 'private', broadcast: false, memorySensitivity: 'personal',
        disclosureBoundary: { consentRequired: true },
      });
      t.check('consent-required without grant is denied', r.decision === 'deny', `decision=${r.decision}`);
      t.check('boundary.consent_required is the reason', r.reasonTag === 'boundary.consent_required', `reasonTag=${r.reasonTag}`);
    },
  },
  {
    id: 's1_broadcast_confidential_denied',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'Force a confidential memory out onto a broadcast surface (public, many-audience).',
    expectation: 'Denied — a broadcast surface never carries confidential material without an operator approval token.',
    run(t) {
      const r = decide({
        trustLevel: 'public', channelPrivacy: 'public', broadcast: true, memorySensitivity: 'confidential',
      });
      t.check('confidential broadcast denied', r.decision === 'deny', `decision=${r.decision} reasonTag=${r.reasonTag}`);
    },
  },
  // ── Controls — prove the gate is not trivially deny-all ──
  {
    id: 's1_control_within_bounds_allows',
    scenarioClass: CLASS,
    className: CLASS_NAME,
    seam: SEAM,
    attack: 'CONTROL: legitimate access — personal memory, trusted tier, private DM.',
    expectation: 'Allowed within bounds; confirms the gate discriminates and is not a blanket deny.',
    run(t) {
      const withinTrusted = decide({
        trustLevel: 'trusted', channelPrivacy: 'private', broadcast: false, memorySensitivity: 'personal',
      });
      const publicSensAnywhere = decide({
        trustLevel: 'primary', channelPrivacy: 'private', broadcast: false, memorySensitivity: 'public',
      });
      t.check('personal memory to a trusted DM is allowed', withinTrusted.decision === 'allow', `decision=${withinTrusted.decision}`);
      t.check('public-sensitivity memory is allowed', publicSensAnywhere.decision === 'allow', `decision=${publicSensAnywhere.decision}`);
    },
  },
];
