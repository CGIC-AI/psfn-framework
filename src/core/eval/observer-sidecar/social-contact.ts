/**
 * Verified social contact -> emo_sim `external_actor` attribution.
 *
 * emo_sim satiates an agent's belonging drive (`social_need`) only from a
 * directed event that has a social source. Target-only stimuli never do, which
 * is why every companion session sat with social need pegged at 1.0. The
 * pinned server accepts a verified external contact without simulating that
 * person (`external_actor`, capability `external_social_actor: 1`); the
 * target's own warmth/hostility response then lowers or raises social need.
 *
 * Only a live inbound message authored by a resolved canonical contact — a
 * human or a peer machine intelligence — is contact evidence. Reflection,
 * scheduler, journal, and the companion's own outbound composition turns are
 * not; for those no key is derived and the stimulus stays target-only.
 *
 * Two opaque digests keep identities out of the observer path:
 * 1. The turn capture derives a content-free contact key from the canonical
 *    contact id (never the id itself).
 * 2. The runner re-derives a session-scoped emo_sim key from that and the
 *    session label, as the emo_sim contract requires.
 */
import { createHash } from 'node:crypto';

const OBSERVER_SOCIAL_CONTACT_DOMAIN = 'psfn.observer.social-contact.v1';
const EMOSIM_EXTERNAL_ACTOR_DOMAIN = 'psfn.emosim.external-actor.v1';
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

export interface EmoSimExternalActor {
  schema_version: 1;
  kind: 'canonical_contact';
  key: string;
}

interface ObserverSocialContactEvidence {
  speakerRole: 'user' | 'system';
  actorKind: 'human' | 'machine_intelligence' | 'system' | 'unknown';
  canonicalContactKey?: string;
}

/** Content-free contact key for an inbound verified-contact turn, else undefined. */
export function deriveObserverSocialContactKey(
  evidence: ObserverSocialContactEvidence,
): string | undefined {
  if (evidence.speakerRole !== 'user') return undefined;
  if (evidence.actorKind !== 'human' && evidence.actorKind !== 'machine_intelligence') {
    return undefined;
  }
  const contactKey = evidence.canonicalContactKey?.trim();
  if (!contactKey) return undefined;
  return sha256Hex(`${OBSERVER_SOCIAL_CONTACT_DOMAIN}\u0000${contactKey}`);
}

export function isObserverSocialContactKey(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

/** Session-scoped emo_sim external actor for one verified contact key. */
export function buildEmoSimExternalActor(
  sessionLabel: string,
  socialContactKey: string,
): EmoSimExternalActor {
  if (!isObserverSocialContactKey(socialContactKey)) {
    throw new Error('EmoSim external actor requires a 64-hex observer social contact key');
  }
  const label = sessionLabel.trim();
  if (!label) {
    throw new Error('EmoSim external actor requires a session label');
  }
  return {
    schema_version: 1,
    kind: 'canonical_contact',
    key: sha256Hex(`${EMOSIM_EXTERNAL_ACTOR_DOMAIN}\u0000${label}\u0000${socialContactKey}`),
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
