/**
 * Hub device assertion verifier ring: the owner-file authority that lets the
 * gateway admit enrolled Hub devices. The same block shape may live in
 * fleet-auth.json (`hubDeviceAssertions`), satellites.json
 * (`hubDeviceAssertions`) or the standalone file named by
 * `PSFN_HUB_DEVICE_ASSERTIONS_PATH`; fleet auth is never required to carry it
 * (psfn-framework-n66dn.2).
 */
export type HubDeviceAssertionKeyStatus = 'active' | 'retiring' | 'revoked';

export interface HubDeviceAssertionVerifierKey {
  kid: string;
  publicKeyPem: string;
  notBefore: string;
  notAfter: string;
  status: HubDeviceAssertionKeyStatus;
}

export interface HubDeviceAssertionVerifierConfig {
  issuer: string;
  audience: string;
  maxTtlSeconds: number;
  clockSkewSeconds: number;
  keys: HubDeviceAssertionVerifierKey[];
}
