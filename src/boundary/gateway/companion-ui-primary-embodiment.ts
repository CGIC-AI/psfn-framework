import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import type { CompiledCompanionUiAction } from '../fleet-auth/companion-ui-action.js';
import type {
  PrimaryEmbodimentAuthorityPort,
  PrimaryEmbodimentHandoffReason,
  PrimaryEmbodimentSnapshot,
} from '../fleet-auth/primary-embodiment.js';

function browserProjection(
  state: PrimaryEmbodimentSnapshot,
  attachment: HubDeviceAttachmentSnapshot,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    generation: state.generation,
    version: state.version,
    primaryPresent: state.current !== null,
    currentDeviceIsPrimary: state.current?.attachmentId === attachment.attachmentId,
    lastDecision: state.lastDecision ? Object.freeze({
      decision: state.lastDecision.decision,
      reason: state.lastDecision.reason,
      decidedAt: state.lastDecision.decidedAt,
    }) : null,
  });
}

export async function dispatchCompanionUiPrimaryEmbodiment(input: {
  compiled: CompiledCompanionUiAction;
  attachment: HubDeviceAttachmentSnapshot;
  authority?: PrimaryEmbodimentAuthorityPort;
}): Promise<Readonly<{ handled: false }> | Readonly<{ handled: true; result: unknown }>> {
  const resource = input.compiled.frame.resource;
  if (resource !== 'embodiment.status' && resource !== 'embodiment.handoff') {
    return Object.freeze({ handled: false });
  }
  if (!input.authority) throw new Error('Primary embodiment authority unavailable');
  const companionId = input.compiled.target.companionId;
  if (resource === 'embodiment.status') {
    const state = await input.authority.read(companionId);
    return Object.freeze({
      handled: true,
      result: browserProjection(state, input.attachment),
    });
  }
  const body = input.compiled.frame.body as Record<string, unknown>;
  const state = await input.authority.handoff({
    companionId,
    attachment: input.attachment,
    expectedGeneration: Number(body.expectedGeneration),
    decisionId: String(body.decisionId),
    reason: body.reason as PrimaryEmbodimentHandoffReason,
  });
  return Object.freeze({
    handled: true,
    result: browserProjection(state, input.attachment),
  });
}
