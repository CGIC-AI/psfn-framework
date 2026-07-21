import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  TESTING_HARNESS_GARDEN_ADMIN_ACTIONS,
  type TestingHarnessGardenAdminConfig,
} from '../../channels/backplane/testing-harness-garden-config.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { timingSafeStringEqual } from '../../shared/utils/secret-compare.js';
import { fleetAuthRoleAllowsAction } from '../fleet-auth/role-action-policy.js';
import {
  compileGatewayGardenRequestTarget,
  type CompiledGardenRequestTarget,
} from '../fleet-auth/request-capability-target.js';
import { stripBrowserRequestCapabilityHeaders } from '../fleet-auth/request-capability-transport.js';
import type { RequestCapabilityAuthorityVersions } from '../fleet-auth/request-capability.js';
import {
  createImmutableFleetAuthorizationContext,
  toRequestCapabilityAuthContext,
  type FleetAuthorizationContext,
  type FleetAuthorizationFacts,
} from './fleet-authorization-context.js';

export interface TestingHarnessGardenAuthorizationAuditResult {
  readonly authorizationEventId: string;
  readonly authorityGeneration: number;
  readonly globalAuthEpoch: number;
  readonly occurredAt: Date;
}

export interface TestingHarnessGardenAuthorizationAuditPort {
  record(input: {
    readonly action: FleetAuthorizationContext['authorization']['action'];
    readonly companionId: CompanionId;
    readonly principalId: 'testing-harness';
    readonly provider: 'testing_harness';
    readonly correlationId: string;
  }): Promise<TestingHarnessGardenAuthorizationAuditResult>;
}

export interface TestingHarnessGardenDoorOptions {
  readonly apiKey: string;
  readonly policy: TestingHarnessGardenAdminConfig;
  readonly audit: TestingHarnessGardenAuthorizationAuditPort;
}

export interface TestingHarnessGardenCapabilityAuthorization {
  readonly target: CompiledGardenRequestTarget;
  readonly requestId: string;
  readonly decisionId: string;
  readonly authContext: ReturnType<typeof toRequestCapabilityAuthContext>;
  readonly versions: RequestCapabilityAuthorityVersions;
  readonly context: FleetAuthorizationContext;
}

export class TestingHarnessGardenDoorDeniedError extends Error {
  constructor() {
    super('Testing-harness Garden request denied');
    this.name = 'TestingHarnessGardenDoorDeniedError';
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function authorityVersions(context: FleetAuthorizationContext): RequestCapabilityAuthorityVersions {
  return Object.freeze({
    authorityGeneration: context.authority.authorityGeneration,
    globalAuthEpoch: context.authority.globalAuthEpoch,
    sessionAuthnVersion: context.session.authnVersion,
    sessionAuthzVersion: context.session.authzVersion,
    bindingVersion: context.session.bindingVersion,
    grantVersion: context.session.grantVersion,
    policyVersion: context.session.policyVersion,
  });
}

/**
 * Authenticates and authorizes the dedicated shakedown bearer at the Fleet SSO
 * boundary. It returns the exact capability input used by the normal router;
 * signing, verification, replay consumption, and proxying remain shared.
 */
export class TestingHarnessGardenDoor {
  constructor(private readonly options: TestingHarnessGardenDoorOptions) {
    const { apiKey, policy } = options;
    const supportedActions = new Set<string>(TESTING_HARNESS_GARDEN_ADMIN_ACTIONS);
    if (apiKey.trim().length < 16) {
      throw new Error('Fleet SSO testing-harness Garden key must be at least 16 characters');
    }
    if (policy.principalId !== 'testing-harness'
      || policy.allowedActions.length === 0
      || policy.allowedActions.some(action => (
        action === 'privacy.break_glass'
        || !supportedActions.has(action)
        || !fleetAuthRoleAllowsAction(policy.role, action)
      ))) {
      throw new Error('Fleet SSO testing-harness Garden policy is invalid');
    }
  }

  matchesBearer(request: IncomingMessage): boolean {
    const authorization = singleHeader(request.headers.authorization);
    if (!authorization?.startsWith('Bearer ')) return false;
    const candidate = authorization.slice('Bearer '.length);
    return candidate.length > 0 && timingSafeStringEqual(candidate, this.options.apiKey);
  }

  async authorize(input: {
    readonly companionId: CompanionId;
    readonly upstreamTarget: string;
    readonly method: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
  }): Promise<TestingHarnessGardenCapabilityAuthorization> {
    const targetHeaders = { ...input.headers };
    stripBrowserRequestCapabilityHeaders(targetHeaders);
    delete targetHeaders.authorization;
    delete targetHeaders.cookie;
    const target = compileGatewayGardenRequestTarget({
      rawTarget: input.upstreamTarget,
      method: input.method,
      companionId: input.companionId,
      headers: targetHeaders,
      body: input.body,
    });
    if (!this.options.policy.allowedActions.includes(target.action)
      || !fleetAuthRoleAllowsAction(this.options.policy.role, target.action)
      || target.action === 'privacy.break_glass'
      || target.authorization.requirements.assurance === 'privacy_break_glass') {
      throw new TestingHarnessGardenDoorDeniedError();
    }

    const requestId = randomUUID();
    const audit = await this.options.audit.record({
      action: target.action,
      companionId: input.companionId,
      principalId: 'testing-harness',
      provider: 'testing_harness',
      correlationId: requestId,
    });
    const syntheticVersion = 1;
    const sessionAssurance = target.authorization.requirements.assurance === 'webauthn_uv'
      ? 'webauthn_uv' as const
      : 'oauth' as const;
    const facts: FleetAuthorizationFacts = {
      principalId: 'testing-harness',
      providerSubjectId: 'testing-harness',
      companionId: input.companionId,
      contact: {
        bindingId: `testing-harness-binding-${input.companionId}`,
        contactId: `testing-harness-contact-${input.companionId}`,
        bindingVersion: syntheticVersion,
      },
      operator: {
        grantId: this.options.policy.operatorGrantId,
        role: this.options.policy.role,
        grantVersion: syntheticVersion,
      },
      session: {
        recordId: `testing-harness-session-${input.companionId}`,
        audience: 'fleet',
        assurance: sessionAssurance,
        authnVersion: syntheticVersion,
        authzVersion: syntheticVersion,
        bindingVersion: syntheticVersion,
        grantVersion: syntheticVersion,
        policyVersion: syntheticVersion,
        provider: 'testing_harness',
        providerSubjectId: 'testing-harness',
      },
      authority: {
        authorityGeneration: audit.authorityGeneration,
        globalAuthEpoch: audit.globalAuthEpoch,
      },
    };
    const context = createImmutableFleetAuthorizationContext({
      request: {
        sessionToken: 'testing-harness',
        audience: 'fleet',
        companionId: input.companionId,
        action: target.action,
        correlationId: requestId,
      },
      facts,
      authorizationEventId: audit.authorizationEventId,
      resolvedAt: audit.occurredAt,
      provenanceSource: 'gateway_testing_harness',
    });
    return Object.freeze({
      target,
      requestId,
      decisionId: audit.authorizationEventId,
      authContext: toRequestCapabilityAuthContext(context),
      versions: authorityVersions(context),
      context,
    });
  }
}
