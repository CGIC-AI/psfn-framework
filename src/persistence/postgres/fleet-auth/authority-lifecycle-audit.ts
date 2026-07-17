import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { LifecycleMutationDenied } from './authority-lifecycle-mutation-contract.js';
import { lifecycleProviderProofs } from './authority-lifecycle-proof.js';
import type {
  FleetAuthLifecycleResult,
  PrincipalAuthorityClaim,
  VerifiedFleetAuthLifecycleDecision,
} from './authority-lifecycle-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { fleetAuthLifecycleDecisionFingerprint } from './authority-lifecycle-fingerprint.js';

/**
 * Versioned domain separator for lifecycle audit identifier digests. The keyed
 * digester covers the enumerable / low-entropy identifiers that constitute the
 * deanonymization oracle this bead closes — above all the Discord snowflakes
 * (provider subject ids) — plus the remaining opaque identifiers. It is keyed
 * HMAC-SHA256 under the fleet-auth session pepper, so a privileged reader of
 * authorization_audit_events cannot confirm a candidate identifier without the
 * pepper. `v1` namespaces the keyed scheme away from the retired unkeyed digests
 * so old and new values never collide (psfn-framework-5wrp).
 */
export const FLEET_AUTH_LIFECYCLE_AUDIT_DIGEST_DOMAIN =
  'fleet-authorization:lifecycle-audit-digest:v1\0';

export type FleetAuthLifecycleAuditDigest = (value: string) => string;

/** Build the keyed lifecycle-audit digester; fail closed on a missing pepper. */
export function createFleetAuthLifecycleAuditDigest(
  sessionPepper: string,
): FleetAuthLifecycleAuditDigest {
  if (sessionPepper.length < 32) {
    throw new Error('Fleet auth lifecycle audit requires the configured session pepper');
  }
  return (value: string): string => createHmac('sha256', sessionPepper)
    .update(FLEET_AUTH_LIFECYCLE_AUDIT_DIGEST_DOMAIN)
    .update(value)
    .digest('hex');
}

/**
 * Unkeyed digest reserved for the four structural identifiers that the
 * companion-readd recovery reconciliation path (companion-readd-reconciliation.ts)
 * ALSO writes into the audit record — principal, ceremony, companion, and
 * authority-lineage ids — plus the audit `resource` content hash. Keeping these
 * unkeyed lets the two independent writers (the online lifecycle transition and
 * the offline non-restored-floor recovery) emit byte-identical companion.readd
 * audit rows, which readd idempotency (readIdempotentCompanionReaddResult)
 * relies on. Keying them would instead demand threading the fleet-auth session
 * pepper through the entire backup/restore/scheduler subsystem (which today has
 * no auth-secret dependency) for no security gain: these are 122-bit random
 * UUIDs (or a UUID-derived hash), not the enumerable identifiers that give the
 * deanonymization oracle. Every enumerable / non-recovery identifier — the
 * Discord snowflakes and the session/binding/grant/contact/callback ids — uses
 * the keyed digester above.
 */
function structuralDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth lifecycle audit ${field}`);
  }
  return parsed;
}

function redactedClaim(claim: PrincipalAuthorityClaim): Record<string, unknown> {
  return {
    // principalId is a recovery-shared structural id (see structuralDigest).
    principalDigest: structuralDigest(claim.principalId),
    authnVersion: claim.authnVersion,
    authzVersion: claim.authzVersion,
    bindingVersion: claim.bindingVersion,
    grantVersion: claim.grantVersion,
    policyVersion: claim.policyVersion,
  };
}

function redactedContext(
  digest: FleetAuthLifecycleAuditDigest,
  decision: VerifiedFleetAuthLifecycleDecision,
  snapshots?: LifecycleAuditSnapshots,
  lifecycleResult?: FleetAuthLifecycleResult,
): Record<string, unknown> {
  const resourceClaims: Record<string, unknown> = {};
  // companionId is recovery-shared (structural, unkeyed); every other resource
  // id is keyed. Marked entries use the unkeyed structural digest.
  const resourceIds = [
    ['companionDigest', 'companionId', true],
    ['bindingDigest', 'bindingId', false],
    ['grantDigest', 'grantId', false],
    ['replacementGrantDigest', 'newGrantId', false],
    ['contactDigest', 'contactId', false],
    ['sourceContactDigest', 'sourceContactId', false],
    ['canonicalContactDigest', 'canonicalContactId', false],
  ] as const;
  const decisionFields = decision as unknown as Record<string, unknown>;
  for (const [output, input, structural] of resourceIds) {
    if (input in decisionFields) {
      const raw = String(decisionFields[input]);
      resourceClaims[output] = structural ? structuralDigest(raw) : digest(raw);
    }
  }
  return {
    schemaVersion: 2,
    decisionFingerprint: fleetAuthLifecycleDecisionFingerprint(decision),
    action: decision.action,
    // ceremonyId is recovery-shared (structural, unkeyed).
    ceremonyDigest: structuralDigest(decision.ceremonyId),
    authorityClaim: {
      authorityGeneration: decision.authorityGeneration,
      globalAuthEpoch: decision.globalAuthEpoch,
    },
    actor: redactedClaim(decision.actor),
    target: redactedClaim(decision.target),
    actorIsTarget: decision.actor.principalId === decision.target.principalId,
    actorSession: {
      sessionDigest: digest(decision.actorSession.sessionId),
      authnVersion: decision.actorSession.authnVersion,
      authzVersion: decision.actorSession.authzVersion,
      bindingVersion: decision.actorSession.bindingVersion,
      grantVersion: decision.actorSession.grantVersion,
      policyVersion: decision.actorSession.policyVersion,
      globalAuthEpoch: decision.actorSession.globalAuthEpoch,
      provider: decision.actorSession.provider,
      providerSubjectDigest: digest(decision.actorSession.providerSubjectId),
    },
    ...('source' in decision ? { source: redactedClaim(decision.source) } : {}),
    ...('currentRole' in decision ? { oldRole: decision.currentRole } : {}),
    ...('role' in decision ? { newRole: decision.role } : {}),
    resourceClaims,
    providerProofs: lifecycleProviderProofs(decision).map(({ role, proof }) => ({
      role,
      provider: proof.provider,
      // proof.subjectId is the enumerable Discord snowflake -> keyed.
      subjectDigest: digest(proof.subjectId),
      callbackDigest: digest(proof.callbackTransactionId),
      proofDigest: proof.proofDigest,
    })),
    ...('contactAuthority' in decision ? {
      contactAuthority: {
        contactDigest: digest(decision.contactAuthority.contactId),
        providerSubjectDigest: digest(decision.contactAuthority.providerSubjectId),
        contactAuthorityVersion: decision.contactAuthority.contactAuthorityVersion,
        identityVersion: decision.contactAuthority.identityVersion,
        verificationDigest: decision.contactAuthority.verificationDigest,
        verificationIdDigest: digest(decision.contactAuthority.verificationId),
        ownershipState: decision.contactAuthority.ownershipState,
        restoreState: decision.contactAuthority.restoreState,
      },
    } : {}),
    ...(snapshots ? { resourceState: snapshots } : {}),
    ...(lifecycleResult ? {
      lifecycleResult: {
        authorityGeneration: lifecycleResult.authorityGeneration,
        globalAuthEpoch: lifecycleResult.globalAuthEpoch,
        target: redactedClaim(lifecycleResult.target),
      },
    } : {}),
  };
}

export interface LifecycleAuditSnapshots {
  before: unknown;
  after: unknown;
}

export async function readRedactedLifecycleResourceSnapshot(
  client: PoolClient,
  digest: FleetAuthLifecycleAuditDigest,
  decision: VerifiedFleetAuthLifecycleDecision,
  principalIds: string[],
  resourcePrincipalIds: string[],
): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  const principals = await client.query<{
    principal_id: string;
    status: string;
    authn_version: string;
    authz_version: string;
    binding_version: string;
    grant_version: string;
    policy_version: string;
    authority_generation: string;
    restore_state: string;
  }>(`
    SELECT principal_id, status, authn_version, authz_version, binding_version,
           grant_version, policy_version, authority_generation, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
    WHERE principal_id = ANY($1::uuid[])
    ORDER BY principal_id
  `, [principalIds]);
  snapshot.principals = principals.rows.map(row => ({
    principalDigest: structuralDigest(row.principal_id),
    status: row.status,
    authnVersion: positiveInteger(row.authn_version, 'authn_version'),
    authzVersion: positiveInteger(row.authz_version, 'authz_version'),
    bindingVersion: positiveInteger(row.binding_version, 'binding_version'),
    grantVersion: positiveInteger(row.grant_version, 'grant_version'),
    policyVersion: positiveInteger(row.policy_version, 'policy_version'),
    authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
    restoreState: row.restore_state,
  }));

  if ('companionId' in decision) {
    const companion = await client.query<{
      lifecycle: string;
      version: string;
      authority_generation: string;
      restore_state: string;
      authority_lineage_id: string | null;
      lineage_generation: string | null;
      readd_decision_id: string | null;
    }>(`
      SELECT lifecycle, version, authority_generation, restore_state,
             authority_lineage_id, lineage_generation, readd_decision_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
      WHERE companion_id = $1
    `, [decision.companionId]);
    const row = companion.rows.at(0);
    snapshot.companion = row ? {
      companionDigest: structuralDigest(decision.companionId),
      lifecycle: row.lifecycle,
      version: positiveInteger(row.version, 'companion version'),
      authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
      restoreState: row.restore_state,
      ...(row.authority_lineage_id
        ? { authorityLineageDigest: structuralDigest(row.authority_lineage_id) }
        : {}),
      ...(row.lineage_generation
        ? { lineageGeneration: positiveInteger(row.lineage_generation, 'companion lineage generation') }
        : {}),
      ...(row.readd_decision_id ? { readdDecisionDigest: digest(row.readd_decision_id) } : {}),
    } : { companionDigest: structuralDigest(decision.companionId), missing: true };
  }

  if ('bindingId' in decision) {
    const binding = await client.query<{
      state: string;
      version: string;
      authority_generation: string;
      restore_state: string;
    }>(`
      SELECT state, version, authority_generation, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      WHERE binding_id = $1
    `, [decision.bindingId]);
    const row = binding.rows.at(0);
    snapshot.binding = row ? {
      bindingDigest: digest(decision.bindingId),
      state: row.state,
      version: positiveInteger(row.version, 'binding version'),
      authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
      restoreState: row.restore_state,
    } : { bindingDigest: digest(decision.bindingId), missing: true };
  }

  const grantIds = [
    ...('grantId' in decision ? [decision.grantId] : []),
    ...('newGrantId' in decision ? [decision.newGrantId] : []),
  ];
  if (grantIds.length > 0) {
    const grants = await client.query<{
      grant_id: string;
      role: string;
      lifecycle: string;
      version: string;
      authority_generation: string;
      restore_state: string;
    }>(`
      SELECT grant_id, role, lifecycle, version, authority_generation, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      WHERE grant_id = ANY($1::uuid[])
      ORDER BY grant_id
    `, [grantIds]);
    const byId = new Map(grants.rows.map(row => [row.grant_id, row]));
    snapshot.grants = grantIds.sort().map(grantId => {
      const row = byId.get(grantId);
      return row ? {
        grantDigest: digest(grantId),
        role: row.role,
        lifecycle: row.lifecycle,
        version: positiveInteger(row.version, 'grant version'),
        authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
        restoreState: row.restore_state,
      } : { grantDigest: digest(grantId), missing: true };
    });
  }

  const bindings = await client.query<{
    binding_id: string;
    principal_id: string;
    companion_id: string;
    contact_id: string;
    state: string;
    version: string;
    authority_generation: string;
    restore_state: string;
  }>(`
    SELECT binding_id, principal_id, companion_id, contact_id, state, version,
           authority_generation, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
    WHERE principal_id = ANY($1::uuid[])
    ORDER BY binding_id
  `, [resourcePrincipalIds]);
  const grants = await client.query<{
    grant_id: string;
    principal_id: string;
    companion_id: string;
    role: string;
    lifecycle: string;
    version: string;
    authority_generation: string;
    restore_state: string;
  }>(`
    SELECT grant_id, principal_id, companion_id, role, lifecycle, version,
           authority_generation, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
    WHERE principal_id = ANY($1::uuid[])
    ORDER BY grant_id
  `, [resourcePrincipalIds]);
  snapshot.affectedAuthorityResources = {
    bindings: bindings.rows.map(row => ({
      bindingDigest: digest(row.binding_id),
      principalDigest: structuralDigest(row.principal_id),
      companionDigest: structuralDigest(row.companion_id),
      contactDigest: digest(row.contact_id),
      state: row.state,
      version: positiveInteger(row.version, 'binding version'),
      authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
      restoreState: row.restore_state,
    })),
    grants: grants.rows.map(row => ({
      grantDigest: digest(row.grant_id),
      principalDigest: structuralDigest(row.principal_id),
      companionDigest: structuralDigest(row.companion_id),
      role: row.role,
      lifecycle: row.lifecycle,
      version: positiveInteger(row.version, 'grant version'),
      authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
      restoreState: row.restore_state,
    })),
  };

  const providerProofs = lifecycleProviderProofs(decision);
  if (providerProofs.length > 0) {
    const subjects = await client.query<{
      subject_id: string;
      state: string;
      authority_generation: string;
      restore_state: string;
    }>(`
      SELECT subject_id, state, authority_generation, restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      WHERE provider = 'discord' AND subject_id = ANY($1::text[])
      ORDER BY subject_id
    `, [providerProofs.map(({ proof }) => proof.subjectId)]);
    const byId = new Map(subjects.rows.map(row => [row.subject_id, row]));
    snapshot.providers = providerProofs.map(({ role, proof }) => {
      const row = byId.get(proof.subjectId);
      return row ? {
        role,
        subjectDigest: digest(proof.subjectId),
        state: row.state,
        authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
        restoreState: row.restore_state,
      } : { role, subjectDigest: digest(proof.subjectId), missing: true };
    });
  }
  return snapshot;
}

export async function insertLifecycleAudit(
  client: PoolClient,
  digest: FleetAuthLifecycleAuditDigest,
  decision: VerifiedFleetAuthLifecycleDecision,
  outcome: 'allow' | 'deny',
  reasonCode: string,
  authority: { authorityGeneration: number; globalAuthEpoch: number },
  snapshots?: LifecycleAuditSnapshots,
  lifecycleResult?: FleetAuthLifecycleResult,
): Promise<void> {
  const context = redactedContext(digest, decision, snapshots, lifecycleResult);
  const result = await client.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      (event_id, actor_context, action, resource, decision, reason_code,
       companion_id, principal_id, authority_generation, global_auth_epoch,
       correlation_id, occurred_at, decision_id, ceremony_id, reason_digest,
       decision_context)
    VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16::jsonb)
  `, [
    randomUUID(),
    // actor principalId is recovery-shared (structural, unkeyed); the resource
    // is a content hash of the redacted context and follows the same unkeyed
    // convention the recovery-reconciliation writer uses for its resource key.
    JSON.stringify({ kind: 'principal', idDigest: structuralDigest(decision.actor.principalId) }),
    decision.action,
    `lifecycle:${decision.action}:${structuralDigest(JSON.stringify(context))}`,
    outcome,
    reasonCode,
    null,
    null,
    authority.authorityGeneration,
    authority.globalAuthEpoch,
    decision.decisionId,
    decision.decidedAt,
    decision.decisionId,
    decision.ceremonyId,
    decision.reasonDigest,
    JSON.stringify(context),
  ]);
  if (result.rowCount !== 1) {
    throw new LifecycleMutationDenied('lifecycle_audit_insert_failed');
  }
}
