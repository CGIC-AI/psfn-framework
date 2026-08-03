# `fleet-auth` Authority Model

> **Terminology:** Per charter §8.12 (2026-07-20) the multi-companion system is a **companion cluster**. "Fleet" persists only in code identifiers (the `fleet-auth` subsystem, `fleet-auth.json`, etc.) pending a staged engineering rename.

The `fleet-auth` subsystem is a consistency model, not a single role lookup. For a database-backed
principal to authorize a companion request, seven projections must describe the
same current authority:

1. `human_principals` must be `active` and `live`. Its
   `authority_generation` must equal the current generation, and its
   `authn_version`, `authz_version`, `binding_version`, `grant_version`, and
   `policy_version` are the versions copied into sessions and checked later.
2. `provider_subjects` binds the authenticated provider subject, such as
   Discord subject `<provider-subject-id>`, to the principal. The row must be
   `active`, `live`, at the current authority generation, and not tombstoned.
3. `companion_authority_state` is the per-companion authority root. The row for
   companion `<companion-uuid>` must be `active`, `live`, and at the current
   authority generation.
4. `principal_contact_bindings` connects the principal to a companion contact.
   The companion-scoped row must be `active`, `live`, unfenced, untombstoned,
   at the current authority generation, and at the principal's
   `binding_version`.
5. `principal_role_grants` supplies the companion-scoped role. The row must be
   `active`, `live`, untombstoned, permitted by `disabledActionsByRole`, at the
   current authority generation, and at the principal's `grant_version`.
6. `authority_state` supplies the global `authority_generation` and
   `global_auth_epoch` against which the other projections and the session are
   evaluated.
7. `browser_sessions` is minted at login and copies the principal's five
   versions together with the current global epoch and provider identity. The
   table does not duplicate `authority_generation`; session validity derives
   generation from the joined principal and the non-restored trusted-host
   floor. The copied values and derived generation must all remain current when
   the session is used.

Child assertion authorization requires exactly one matching cluster session,
provider subject, contact binding, and role grant for the requested companion.
It also requires exact parent-decision and authority values. A stale or
duplicate row does not degrade to weaker authorization: it produces
`child_authority_denied`.

## Why authority changes end sessions

The copied session values make version changes revocation boundaries. Changing
an authentication, authorization, binding, grant, or policy version makes
every session holding the prior value stale. Generation is checked through the
joined principal and trusted-host floor rather than copied into the session;
reconciliation advances the global epoch and deletes existing sessions.
Advancing either generation or epoch therefore invalidates prior sessions,
after which the next login creates a session from the new values.

Routine cluster login now enforces the exact-one-session invariant at creation.
In the same transaction that inserts a replacement, the broker atomically
supersedes every active session for the same principal and audience, revokes
its live escalation grants, and leaves exactly the new session active. The authorization check remains strict; multiple active
sessions are prevented instead of accepted.

## Reconciliation quarantine and recovery

When the trusted-host authority floor advances, reconciliation treats restored
durable authority as untrusted by default. Regular principals and their
provider subjects, bindings, and grants enter quarantine.
A companion-authority row also enters quarantine unless a current owner for
that shared companion carries it forward under the exception below. Ephemeral
sessions, OAuth transactions, token custody, challenges, grants, evidence,
ceremonies, and decision receipts are removed. A regular account returns only
through the explicit trusted-host reapproval flow; the runtime cannot
reactivate quarantined rows directly.

An already current owner is the narrow exception. Reconciliation recognizes a
principal only when it is active and live and holds an active, live `owner`
grant whose generation and version match the pre-transition authority. That
owner principal, its active provider subject, and the active
companion/binding/owner-grant chain are carried to the new authority generation
instead of quarantined. Other principals—and non-owner authority held by the
same principal—retain the normal quarantine behavior. All browser sessions are
still invalidated, so the owner signs in again against the new epoch.

This exception deliberately derives ownership from durable active authority.
It does not guess from contact names, provider metadata, or a partial row.

## Why hand-seeding is unsupported

Inserting an `owner` grant is not sufficient. The principal, provider subject,
companion authority, contact binding, role grant, global authority, and newly
minted session must agree on every applicable generation and version. Fixing
one row commonly reveals the next mismatch, while changing a version also
invalidates any session created before the change. Schema guards and restricted
database roles additionally prevent ordinary runtime SQL from bypassing
quarantine.

Hand-seeding therefore creates fragile, unsupported state and is a dead end for
operations. It must not be documented or automated as a bootstrap procedure.

## Sanctioned administrator path

The sanctioned single-operator bootstrap and recovery path is the
`accountRoster` in `fleet-auth.json` (tracked by bead `kf7e`). A roster entry
binds an exact provider subject and companion UUID to an allowed role, for
example:

```json
{
  "providerSubjectId": "<discord-snowflake>",
  "companionId": "<companion-uuid>",
  "contactId": "<canonical-companion-contact-id>",
  "role": "owner"
}
```

An exact roster match is configuration-owned administrator authority. It
bypasses database principal activation and the nested child-authority
generation/version chain. Non-roster subjects remain fail-closed. The roster must be validated
strictly and must never use display names or partial identifiers as fallback
identity.

For the actor's subject scope, a single valid active live principal contact
binding is authoritative when present. Ambiguous or invalid existing binding
state denies rather than falling through to another identity. When no binding
row exists, the roster `contactId` is the configuration-owned canonical
identity. A roster entry with neither source is not authorized; the runtime
never fabricates a contact identifier. Before enabling a contact-backed roster
entry, provision or verify that the configured identifier names the matching
contact in that companion's store.

Because roster authorization bypasses the authority-generation staleness gate,
its revocation trust anchor is the browser-session row itself
(`revoked_at`/`replaced_by`/expiry). Every current generation-advancing path
also deletes or revokes sessions directly; any future revocation path that
advances the generation or floor **without** touching session rows would
silently leave a rostered subject live and must revoke sessions as well.

## Authentication and escalation doctrine (operator rulings D1/D2, 2026-07-30)

Discord SSO is the ONLY authentication. There are no passkeys, no WebAuthn,
and no just-in-time step-up ceremonies; the former `webauthn_uv` assurance
tier, JIT challenge/grant tables, and trusted-host passkey ceremonies were
removed (migration `discord_sso_only_authority`). SSO exists to unify auth
across surfaces — it never gates the operator from their own information.

Deployment access mode is derived from the roster, per companion
(`resolveFleetAccessMode`):

- **Sole admin** (exactly one rostered human): nothing is subject-gated. The
  admin sees all settings, sessions, contacts, and memories, including
  companion-private and multi-contact classes. The only barriers that remain
  are the audited high-intimacy body escalation and the companion-privacy
  break-glass consent boundary.
- **Multi admin** (zero or two-plus rostered humans): every admin sees
  everything EXCEPT sensitive/intimate memories derived from OTHER humans'
  chats with the companion. Group-chat memories stay visible to admins.
  Other-humans' sensitive memories open only through an audited escalation.

Escalation is an audited SSO action, not a ceremony: the authenticated admin
states a reason (`POST /v1/fleet-auth/escalation/grant`), a single-use grant
with a bounded TTL (`ttls.escalationGrantMs`) is recorded in
`fleet_auth.escalation_grants` together with an `escalation.grant.issue` audit
event naming actor, scope, and reason, and the exact gated request consumes it
via the `x-psfn-escalation-grant` header (audited again on consume). Routes
declaring the `escalated` assurance — memory elevation/reveal, cogsec
remediation actions, and the privacy break-glass confirm phase — fail closed
with `403 Audited escalation grant required` when no valid grant accompanies
the request.
