import { describe, expect, it } from 'vitest';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import { deriveCompanionAuthToken, verifyCompanionAuthToken } from './companion-auth.js';

const KEYRING: SessionHmacKeyring = {
  activeVersion: 'v2',
  keys: { v1: 'old-secret', v2: 'active-secret' },
};

describe('companion gateway authentication', () => {
  it('binds proofs to companion id and role while accepting retained key versions', () => {
    const agentToken = deriveCompanionAuthToken('comp-a', 'agent', KEYRING);
    const workerToken = deriveCompanionAuthToken('comp-a', 'internal_session_integrity', KEYRING);
    const retainedToken = deriveCompanionAuthToken('comp-a', 'agent', {
      activeVersion: 'v1',
      keys: KEYRING.keys,
    });

    expect(agentToken).not.toBe(workerToken);
    expect(verifyCompanionAuthToken('comp-a', 'agent', agentToken, KEYRING)).toBe(true);
    expect(verifyCompanionAuthToken('comp-a', 'agent', retainedToken, KEYRING)).toBe(true);
    expect(verifyCompanionAuthToken('comp-b', 'agent', agentToken, KEYRING)).toBe(false);
    expect(verifyCompanionAuthToken(
      'comp-a',
      'internal_session_integrity',
      agentToken,
      KEYRING,
    )).toBe(false);
    expect(verifyCompanionAuthToken('comp-a', 'agent', 'malformed', KEYRING)).toBe(false);
    expect(verifyCompanionAuthToken('comp-a', 'agent', undefined, KEYRING)).toBe(false);
  });
});
