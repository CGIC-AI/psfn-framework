// Shared fixture for the journal break-glass scenarios (psfn-framework-57gt).
//
// Reconstructs the minimal runtime shape of a resolved fleet Garden request
// context that AdminPrivacyBreakGlassService reads — mirrors the fixture in
// src/operator/garden/services/privacy-break-glass-service.test.ts. Kept loose
// on purpose: the harness runs under tsx (no typecheck) and drives the service
// by its real runtime behaviour, not its full compile-time type surface.

export const BG_NOW = Date.parse('2026-07-21T12:00:00.000Z');

export const BG_REASON = {
  reasonCategory: 'safety_investigation' as const,
  reason: 'Standing adversarial harness synthetic journal disclosure probe for review.',
};

type BreakGlassKind = 'memory' | 'profile' | 'journal';
type BreakGlassPhase = 'confirm' | 'decide';

const AREA_BY_KIND: Record<BreakGlassKind, string> = {
  memory: 'memory',
  profile: 'contacts',
  journal: 'values',
};

/**
 * Build a resolved fleet-principal Garden request context. `assurance` is the
 * lever the scenarios move: the confirm phase only clears break-glass when the
 * session already carried `break_glass` (webauthn UV) assurance; a plain
 * `oauth` admin session must be denied (default-deny, 57gt).
 */
export function buildBreakGlassContext(input: {
  kind: BreakGlassKind;
  phase: BreakGlassPhase;
  resourceId: string;
  assurance?: string;
  principalId?: string;
  contactId?: string;
}): unknown {
  const assurance = input.assurance ?? (input.phase === 'confirm' ? 'break_glass' : 'oauth');
  const area = AREA_BY_KIND[input.kind];
  const principalId = input.principalId ?? 'principal-a';
  const contactId = input.contactId ?? 'contact-a';
  return {
    kind: 'fleet_principal',
    requestId: input.phase === 'confirm'
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    decisionId: input.phase === 'confirm'
      ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    authorizationEventId: `event-${input.phase}`,
    resolvedAt: new Date(BG_NOW).toISOString(),
    versions: {
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    },
    issuedAt: Math.floor(BG_NOW / 1_000),
    expiresAt: Math.floor(BG_NOW / 1_000) + 60,
    actor: {
      kind: 'fleet_principal',
      principalId,
      provider: 'discord',
      providerSubjectId: `provider-${principalId}`,
      contactId,
      contactBindingId: `binding-${contactId}`,
      role: 'admin',
      operatorGrantId: `grant-${principalId}`,
      sessionRecordId: `session-${principalId}`,
      sessionAssurance: assurance,
    },
    action: 'privacy.break_glass',
    resource: {
      routeId: `POST /api/admin/privacy-break-glass/${input.kind}/:id/${input.phase}`,
      scope: 'personal_workspace',
      area,
      companionId: 'companion-adversarial-harness',
      pathParams: { id: input.resourceId },
      query: {},
    },
    subjectRelation: 'none',
    authorization: {
      action: 'privacy.break_glass',
      baseRole: 'admin',
      resource: { scope: 'personal_workspace', area },
      subjectRelation: 'none',
      requirements: {
        assurance: input.phase === 'confirm' ? 'privacy_break_glass' : 'oauth',
        confirmation: 'explicit',
        approvals: [],
      },
      publicAccess: 'never',
      recoveryAccess: 'forbidden',
    },
  };
}

/** A private companion reflection-journal window used as the disclosure target. */
export function buildJournalEntries(): unknown[] {
  return [{
    id: 'reflection-1',
    templateId: 'musing',
    templateName: 'Musing',
    prompt: 'Free-form reflection prompt.',
    reflection: 'A private companion reflection the admin surface must not read by default.',
    channelId: 'discord:heartbeat',
    mode: 'agent',
    createdAt: '2026-03-08T08:00:00.000Z',
  }];
}
