import { randomUUID } from 'node:crypto';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import type { SatelliteClientCertIdentity } from '../../shared/contracts/satellite-registry.js';
import {
  toRequestCapabilityAuthContext,
  type FleetAuthorizationContext,
} from './fleet-authorization-context.js';
import {
  compileCompanionUiAction,
  companionUiShardSelector,
  type CompanionUiPhysicalCapabilityCeiling,
  type CompiledCompanionUiAction,
} from '../fleet-auth/companion-ui-action.js';
import type {
  GatewayRequestCapabilitySigner,
  RequestCapabilityAuthorityVersions,
} from '../fleet-auth/request-capability.js';
import type {
  GatewayChildAssertionExchangeResult,
  GatewayFleetAuthChildAssertionBroker,
} from './fleet-auth-child-assertions.js';

export interface CompanionUiAgentDispatchInput {
  readonly compiled: CompiledCompanionUiAction;
  readonly attachment: HubDeviceAttachmentSnapshot;
  readonly signal?: AbortSignal;
  /** Agent-only assertion. The operator token is deliberately absent. */
  readonly childAssertion: GatewayChildAssertionExchangeResult;
  readonly deviceTransport: Readonly<{
    principal: Readonly<{ id: string; mode: 'api_key'; scope: 'satellite' }>;
    headers: Readonly<Record<string, string | undefined>>;
    clientCert?: SatelliteClientCertIdentity;
  }>;
}

export interface CompanionUiAgentDispatchPort {
  dispatch(input: CompanionUiAgentDispatchInput): Promise<unknown>;
}

export interface CompanionUiActionBrokerInput {
  readonly rawBody: Uint8Array;
  readonly companionId: CompanionId;
  readonly sessionToken: string;
  readonly attachment: HubDeviceAttachmentSnapshot;
  readonly physicalCeiling: CompanionUiPhysicalCapabilityCeiling;
  readonly deviceTransport: CompanionUiAgentDispatchInput['deviceTransport'];
  /** Server-owned cancellation only; never parsed from the browser frame. */
  readonly signal?: AbortSignal;
}

export class CompanionUiActionDeniedError extends Error {
  constructor() {
    super('Companion UI action was denied');
    this.name = 'CompanionUiActionDeniedError';
  }
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

function exactHumanAttachmentIsCurrent(
  attachment: HubDeviceAttachmentSnapshot,
  context: FleetAuthorizationContext,
): boolean {
  const actor = attachment.actor;
  return actor.kind === 'human'
    && attachment.channel.companionId === context.companionId
    && attachment.deviceActor.principal.companionId === context.companionId
    && actor.companionId === context.companionId
    && actor.principalId === context.principalId
    && actor.providerSubject.subjectId === context.providerSubject.subjectId
    && actor.contact.bindingId === context.contact.bindingId
    && actor.contact.contactId === context.contact.contactId
    && actor.contact.bindingVersion === context.contact.bindingVersion
    && actor.operator.grantId === context.operator.grantId
    && actor.operator.role === context.operator.role
    && actor.operator.grantVersion === context.operator.grantVersion
    && actor.session.recordId === context.session.recordId
    && actor.session.authorityGeneration === context.authority.authorityGeneration
    && actor.session.globalAuthEpoch === context.authority.globalAuthEpoch;
}

/**
 * Gateway-owned browser action broker. It resolves current human authority for
 * every frame, intersects it with the server-resolved Hub ceiling, signs an
 * operator parent, exchanges that parent for a linked agent-only child, and
 * dispatches only the child plus separate human/device provenance.
 */
export class GatewayCompanionUiActionBroker {
  constructor(private readonly options: {
    resolveAuthorizationContext(input: unknown): Promise<FleetAuthorizationContext>;
    signer: GatewayRequestCapabilitySigner;
    childAssertions: GatewayFleetAuthChildAssertionBroker;
    dispatch: CompanionUiAgentDispatchPort;
    approvalOwner: Readonly<{ ownerOf(id: string): string | undefined }>;
    shardDeployment?: Readonly<{
      ownerOfLiveShard(shardId: string, parentCompanionId: CompanionId): Promise<string | undefined>;
    }>;
  }) {}

  async execute(input: CompanionUiActionBrokerInput): Promise<unknown> {
    const compiled = compileCompanionUiAction(
      input.rawBody,
      input.companionId,
      input.physicalCeiling,
    );
    const context = await this.options.resolveAuthorizationContext({
      sessionToken: input.sessionToken,
      audience: 'fleet',
      companionId: input.companionId,
      action: compiled.frame.action,
      correlationId: compiled.frame.requestId,
    });
    if (!exactHumanAttachmentIsCurrent(input.attachment, context)) {
      throw new CompanionUiActionDeniedError();
    }
    if (compiled.frame.resource === 'confirmations.resolve' && context.operator.role === 'guest') {
      throw new CompanionUiActionDeniedError();
    }
    if (compiled.frame.resource === 'confirmations.resolve') {
      const body = compiled.frame.body as Readonly<{ id: string }>;
      if (this.options.approvalOwner.ownerOf(body.id) !== context.companionId) {
        throw new CompanionUiActionDeniedError();
      }
    }
    const shardId = companionUiShardSelector(compiled.frame);
    if (shardId) {
      const storedOwner = await this.options.shardDeployment?.ownerOfLiveShard(
        shardId,
        input.companionId,
      );
      if (storedOwner !== context.companionId) {
        throw new CompanionUiActionDeniedError();
      }
    }
    const versions = authorityVersions(context);
    const parentRequestId = randomUUID();
    const parent = Object.freeze({
      target: compiled.target,
      requestId: parentRequestId,
      decisionId: context.provenance.authorizationEventId,
      // Companion-UI actions are not a human admin surface; sign the
      // restrictive multi-admin access mode unconditionally (fail closed).
      authContext: Object.freeze({
        ...toRequestCapabilityAuthContext(context),
        fleetAccessMode: 'multi_admin' as const,
      }),
      versions,
    });
    const parentToken = this.options.signer.signOperator(parent);
    const childAssertion = await this.options.childAssertions.exchange({
      operator: Object.freeze({
        kind: 'operator_process',
        operatorId: `operator:${input.companionId}`,
        companionId: input.companionId,
      }),
      parent: Object.freeze({ token: parentToken, ...parent }),
      child: Object.freeze({ target: compiled.target, requestId: randomUUID() }),
    });
    if (childAssertion.target.targetDigest !== compiled.target.targetDigest
      || childAssertion.parent.targetDigest !== compiled.target.targetDigest) {
      throw new CompanionUiActionDeniedError();
    }
    return await this.options.dispatch.dispatch({
      compiled,
      attachment: input.attachment,
      childAssertion,
      deviceTransport: input.deviceTransport,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
}
