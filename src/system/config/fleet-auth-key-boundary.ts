import { createHash, createPublicKey } from 'node:crypto';

interface FleetAuthPublicKeyReference {
  kid: string;
  publicKeyPem: string;
}

interface FleetAuthPublicKeyBoundaryInput {
  brokerKeys: readonly FleetAuthPublicKeyReference[];
  hubKeys: readonly FleetAuthPublicKeyReference[];
  allowUnsafeTemplateKeys: boolean;
}

const PLACEHOLDER_KEY_IDS = new Set(['replace-before-enable']);

// These are canonical SPKI fingerprints of the distributed broker seed and
// canonical Hub assertion fixture. Renaming or reformatting them must not make
// either key acceptable to an enabled runtime.
const KNOWN_UNSAFE_PUBLIC_KEY_FINGERPRINTS = new Set([
  'RnfkKvlzBKpUkoPqF74Bh7mxBVwTBUgNYf7DvH2S2lI',
  'SzlUBOlZ05r8GhfUA4edSuh390Br2PFNbIq5yo36e8E',
]);

function boundaryError(message: string): Error {
  return new Error(`Invalid fleet auth config: ${message}`);
}

export function canonicalEd25519SpkiFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw boundaryError('key-boundary checks require public Ed25519 keys');
  }
  const spki = key.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url');
}

function fingerprintRing(
  label: 'broker' | 'Hub',
  keys: readonly FleetAuthPublicKeyReference[],
): Map<string, FleetAuthPublicKeyReference> {
  const byFingerprint = new Map<string, FleetAuthPublicKeyReference>();
  for (const key of keys) {
    const fingerprint = canonicalEd25519SpkiFingerprint(key.publicKeyPem);
    if (byFingerprint.has(fingerprint)) {
      throw boundaryError(`${label} verifier ring must not contain duplicate Ed25519 keys`);
    }
    byFingerprint.set(fingerprint, key);
  }
  return byFingerprint;
}

export function assertFleetAuthPublicKeyBoundary(input: FleetAuthPublicKeyBoundaryInput): void {
  const brokerKeys = fingerprintRing('broker', input.brokerKeys);
  const hubKeys = fingerprintRing('Hub', input.hubKeys);
  for (const fingerprint of brokerKeys.keys()) {
    if (hubKeys.has(fingerprint)) {
      throw boundaryError('broker and Hub verifier rings must use distinct Ed25519 keys');
    }
  }

  if (input.allowUnsafeTemplateKeys) return;

  for (const key of [...input.brokerKeys, ...input.hubKeys]) {
    if (PLACEHOLDER_KEY_IDS.has(key.kid)) {
      throw boundaryError(`key id ${key.kid} must be replaced before fleet auth can be enabled`);
    }
    const fingerprint = canonicalEd25519SpkiFingerprint(key.publicKeyPem);
    if (KNOWN_UNSAFE_PUBLIC_KEY_FINGERPRINTS.has(fingerprint)) {
      throw boundaryError('distributed seed or test fixture key must be replaced before fleet auth can be enabled');
    }
  }
}

export function assertBrokerSigningKeyNotTrustedByHub(
  brokerPublicKeyPem: string,
  hubKeys: readonly FleetAuthPublicKeyReference[],
): void {
  const brokerFingerprint = canonicalEd25519SpkiFingerprint(brokerPublicKeyPem);
  if (hubKeys.some(key => (
    canonicalEd25519SpkiFingerprint(key.publicKeyPem) === brokerFingerprint
  ))) {
    throw boundaryError('broker private signing key must not match any trusted Hub key');
  }
}
