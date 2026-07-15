import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME,
  FleetAuthAuthorityFloorStore,
  type PasskeyAuthorityCandidate,
} from './authority-floor.js';

const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';

function passkey(
  credentialIdHash: string,
  publicKeyVerifier: string,
): PasskeyAuthorityCandidate {
  return {
    credentialIdHash,
    publicKeyVerifier,
    rpId: 'fleet.example.test',
    principalId: PRINCIPAL_ID,
    expectedProvider: 'discord',
    expectedProviderSubjectId: '123456789012345678',
    signCount: 0,
    backupEligible: false,
    backupState: false,
  };
}

describe('non-restored fleet auth authority floors', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function store(): FleetAuthAuthorityFloorStore {
    const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-floor-'));
    chmodSync(root, 0o700);
    roots.push(root);
    return new FleetAuthAuthorityFloorStore(root);
  }

  it('creates one restrictive, strict floor only for a genuinely empty authority domain', () => {
    const floor = store();
    const initial = floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    expect(initial.trustedHost).toMatchObject({
      authorityGeneration: 1,
      activationGeneration: 1,
      restoreCheckpoint: 0,
      revocationCheckpoint: 0,
      tombstones: [],
    });
    expect(initial.passkeys).toMatchObject({ generation: 0, credentials: [], tombstones: [] });
    expect(initial.trustedHost.lineageId).toMatch(/^[0-9a-f]{64}$/);
    expect(initial.trustedHost.provisioningSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(initial.trustedHost.lineageId).not.toBe(initial.trustedHost.provisioningSecret);

    const path = join(floor.root, FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME);
    expect(readFileSync(path).byteLength).toBeGreaterThan(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    unlinkSync(path);
    expect(() => floor.open({ activationGeneration: 1, databaseHasDurableAuthority: true }))
      .toThrow(/missing.*durable fleet auth authority exists/i);
  });

  it('consumes each disable/re-enable transition once even when activation generation is unchanged', () => {
    const floor = store();
    const initial = floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const transitionId = '1'.repeat(64);

    const reenabled = floor.open({
      activationGeneration: 1,
      databaseHasDurableAuthority: true,
      lifecycleTransitionId: transitionId,
    });
    expect(reenabled.trustedHost).toMatchObject({
      activationGeneration: 1,
      authorityGeneration: 2,
      restoreCheckpoint: 1,
      lastLifecycleTransitionId: transitionId,
    });

    const retried = floor.open({
      activationGeneration: 1,
      databaseHasDurableAuthority: true,
      lifecycleTransitionId: transitionId,
    });
    expect(retried).toEqual(reenabled);

    const restarted = floor.open({
      activationGeneration: 1,
      databaseHasDurableAuthority: true,
    });
    expect(restarted).toEqual(reenabled);
    expect(initial.trustedHost.lineageId).toBe(restarted.trustedHost.lineageId);
  });

  it('advances and merges account revocation/restore checkpoints monotonically', () => {
    const floor = store();
    floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const revoked = floor.revokeAccountAuthority({
      kind: 'provider_subject',
      resourceId: 'discord:123456789012345678',
      reason: 'operator unlink',
      at: '2026-07-15T12:00:00.000Z',
    });
    expect(revoked.trustedHost.authorityGeneration).toBe(2);
    expect(revoked.trustedHost.revocationCheckpoint).toBe(1);

    const restored = floor.prepareRestore({
      activationGeneration: 2,
      restoredTombstones: [
        { kind: 'provider_subject', resourceId: 'discord:123456789012345678' },
        { kind: 'role_grant', resourceId: 'old-role-grant' },
      ],
      at: '2026-07-15T13:00:00.000Z',
    });
    expect(restored.trustedHost.activationGeneration).toBe(2);
    expect(restored.trustedHost.authorityGeneration).toBe(3);
    expect(restored.trustedHost.restoreCheckpoint).toBe(1);
    expect(restored.trustedHost.revocationCheckpoint).toBe(1);
    expect(restored.trustedHost.tombstones).toHaveLength(2);
    expect(() => floor.prepareRestore({
      activationGeneration: 1,
      restoredTombstones: [],
      at: '2026-07-15T14:00:00.000Z',
    })).toThrow(/activation generation.*cannot move backward/i);
  });

  it('keeps current replacement B authoritative while restored A remains denied', () => {
    const floor = store();
    floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const keyA = passkey('a'.repeat(64), 'verifier-a');
    const keyB = passkey('b'.repeat(64), 'verifier-b');
    floor.enrollPasskey(keyA, '2026-07-15T10:00:00.000Z');
    expect(floor.verifyCurrentPasskey(keyA)).toMatchObject({ allowed: true, generation: 1 });

    floor.replacePasskey({
      priorCredentialIdHash: keyA.credentialIdHash,
      replacement: keyB,
      at: '2026-07-15T11:00:00.000Z',
    });
    expect(floor.verifyCurrentPasskey(keyA)).toEqual({ allowed: false, reason: 'not_current' });
    expect(floor.verifyCurrentPasskey(keyB)).toMatchObject({ allowed: true, generation: 3 });

    const beforeRestore = floor.read().passkeys;
    floor.prepareRestore({
      activationGeneration: 2,
      restoredTombstones: [],
      at: '2026-07-15T12:00:00.000Z',
    });
    const afterRestore = floor.read().passkeys;
    expect(afterRestore).toEqual(beforeRestore);
    expect(floor.verifyCurrentPasskey(keyA)).toEqual({ allowed: false, reason: 'not_current' });
    expect(floor.verifyCurrentPasskey(keyB)).toMatchObject({ allowed: true, generation: 3 });
  });

  it('denies mismatched verifier/binding metadata and fails closed when the floor is unavailable', () => {
    const floor = store();
    floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const current = passkey('c'.repeat(64), 'verifier-current');
    floor.enrollPasskey(current, '2026-07-15T10:00:00.000Z');
    expect(floor.verifyCurrentPasskey({ ...current, publicKeyVerifier: 'restored-verifier' }))
      .toEqual({ allowed: false, reason: 'metadata_mismatch' });
    expect(floor.verifyCurrentPasskey({ ...current, rpId: 'evil.example.test' }))
      .toEqual({ allowed: false, reason: 'metadata_mismatch' });

    unlinkSync(join(floor.root, FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME));
    expect(() => floor.verifyCurrentPasskey(current)).toThrow(/authority floor.*unavailable/i);
  });

  it('over-fences the prior credential if replacement publication fails', () => {
    const floor = store();
    floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const keyA = passkey('d'.repeat(64), 'verifier-a');
    const keyB = passkey('e'.repeat(64), 'verifier-b');
    floor.enrollPasskey(keyA, '2026-07-15T10:00:00.000Z');
    expect(() => floor.replacePasskey({
      priorCredentialIdHash: keyA.credentialIdHash,
      replacement: keyB,
      at: '2026-07-15T11:00:00.000Z',
      faultInjection: () => {
        throw new Error('simulated publication failure');
      },
    })).toThrow(/simulated publication failure/);
    expect(floor.verifyCurrentPasskey(keyA)).toEqual({ allowed: false, reason: 'not_current' });
    expect(floor.verifyCurrentPasskey(keyB)).toEqual({ allowed: false, reason: 'not_found' });
  });

  it('monotonically updates authenticator signals and tombstones revoked credentials', () => {
    const floor = store();
    floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const key = {
      ...passkey('f'.repeat(64), 'verifier-current'),
      backupEligible: true,
    };
    floor.enrollPasskey(key, '2026-07-15T10:00:00.000Z');
    const advanced = floor.updateCurrentPasskeySignals({
      credentialIdHash: key.credentialIdHash,
      expectedGeneration: 1,
      signCount: 2,
      backupEligible: true,
      backupState: true,
      at: '2026-07-15T10:30:00.000Z',
    });
    expect(advanced.passkeys.generation).toBe(2);
    expect(floor.verifyCurrentPasskey({ ...key, signCount: 2, backupState: true }))
      .toMatchObject({ allowed: true, generation: 2 });
    expect(() => floor.updateCurrentPasskeySignals({
      credentialIdHash: key.credentialIdHash,
      expectedGeneration: 2,
      signCount: 1,
      backupEligible: true,
      backupState: true,
      at: '2026-07-15T10:45:00.000Z',
    })).toThrow(/counter cannot move backward/);

    const revoked = floor.revokePasskey({
      credentialIdHash: key.credentialIdHash,
      status: 'compromised',
      at: '2026-07-15T11:00:00.000Z',
    });
    expect(revoked.passkeys.tombstones).toContainEqual(expect.objectContaining({
      credentialIdHash: key.credentialIdHash,
      status: 'compromised',
      generation: 3,
    }));
    expect(floor.verifyCurrentPasskey({ ...key, signCount: 2, backupState: true }))
      .toEqual({ allowed: false, reason: 'not_current' });
  });

  it('rejects malformed floor state instead of coercing it', () => {
    const floor = store();
    floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const path = join(floor.root, FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSyncForTest(path, { ...payload, rollbackAllowed: true });
    expect(() => floor.read()).toThrow(/unknown keys: rollbackAllowed/);
  });

  it('rejects a forged public lineage without its random provisioning secret', () => {
    const floor = store();
    floor.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
    const path = join(floor.root, FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME);
    const payload = JSON.parse(readFileSync(path, 'utf8')) as {
      trustedHost: { lineageId: string };
    };
    payload.trustedHost.lineageId = 'f'.repeat(64);
    writeFileSyncForTest(path, payload);
    expect(() => floor.read()).toThrow(/lineage proof is invalid/i);
  });
});

function writeFileSyncForTest(path: string, value: unknown): void {
  // Tests deliberately corrupt an authority file to exercise strict reads.
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}
