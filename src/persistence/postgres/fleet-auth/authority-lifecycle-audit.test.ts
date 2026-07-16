import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FLEET_AUTH_LIFECYCLE_AUDIT_DIGEST_DOMAIN,
  createFleetAuthLifecycleAuditDigest,
} from './authority-lifecycle-audit.js';

// psfn-framework-5wrp: the lifecycle audit persists digests over enumerable
// identifiers (above all Discord snowflakes). Those must be keyed HMAC so a
// privileged reader of authorization_audit_events cannot confirm a candidate
// identifier by hashing it.
describe('fleet-auth lifecycle audit keyed digester', () => {
  const PEPPER = 'lifecycle-audit-session-pepper-32bytes';
  const SNOWFLAKE = '123456789012345678';

  it('produces a keyed HMAC that plain SHA-256 of the identifier cannot reproduce', () => {
    const digest = createFleetAuthLifecycleAuditDigest(PEPPER);
    const produced = digest(SNOWFLAKE);
    expect(produced).toMatch(/^[0-9a-f]{64}$/u);
    // The deanonymization oracle: an attacker hashing the known snowflake.
    expect(produced).not.toBe(createHash('sha256').update(SNOWFLAKE).digest('hex'));
  });

  it('is deterministic for a stable pepper and diverges under a different pepper', () => {
    const first = createFleetAuthLifecycleAuditDigest(PEPPER)(SNOWFLAKE);
    const again = createFleetAuthLifecycleAuditDigest(PEPPER)(SNOWFLAKE);
    const other = createFleetAuthLifecycleAuditDigest(
      'a-completely-different-session-pepper32',
    )(SNOWFLAKE);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it('separates the domain so cross-surface digests of the same value differ', () => {
    const digest = createFleetAuthLifecycleAuditDigest(PEPPER);
    const withoutDomain = createHash('sha256').update(SNOWFLAKE).digest('hex');
    expect(digest(SNOWFLAKE)).not.toBe(withoutDomain);
    expect(FLEET_AUTH_LIFECYCLE_AUDIT_DIGEST_DOMAIN).toContain('v1');
  });

  it('fails closed when the session pepper is missing or too short', () => {
    expect(() => createFleetAuthLifecycleAuditDigest('')).toThrow(/session pepper/);
    expect(() => createFleetAuthLifecycleAuditDigest('too-short')).toThrow(/session pepper/);
  });
});
