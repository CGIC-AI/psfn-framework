import type { digestDiscordEvidenceConfig } from '../../../boundary/fleet-auth/discord-evidence-runtime.js';
import type {
  DISCORD_EVIDENCE_MUTATION_APPLIED,
  DISCORD_EVIDENCE_MUTATION_RETIRED,
  digestDiscordEvidence,
  isUsablePositiveDiscordEvidence,
} from '../../../boundary/fleet-auth/discord-evidence-types.js';
import type { FleetEscalationError } from '../../../boundary/fleet-auth/escalation.js';
import type { HubDeviceAttachmentRejectedError } from '../../../boundary/fleet-auth/hub-device-ingress.js';
import type { fleetAuthRoleAllowsAction } from '../../../boundary/fleet-auth/role-action-policy.js';
import type { PrimaryEmbodimentHandoffDeniedError } from '../../../boundary/fleet-auth/primary-embodiment.js';
import type { ContactLifecycleAuthorityDeniedError } from '../../../boundary/gateway/contact-lifecycle-authority.js';
import type { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import type {
  createImmutableFleetAuthorizationContext,
  evaluateAccountRosterAuthorization,
  evaluateFleetAuthorizationSessionSnapshot,
  evaluateFleetAuthorizationSnapshot,
  FleetAuthorizationDeniedError,
} from '../../../boundary/gateway/fleet-authorization-context.js';

/**
 * Runtime values owned by the gateway boundary but consumed by PostgreSQL
 * adapters. The app composition root installs the canonical implementations
 * before constructing a fleet-auth store; persistence never imports them as
 * runtime values and fails closed when composition is absent.
 */
export interface FleetAuthPersistenceBoundaryValues {
  ContactLifecycleAuthorityDeniedError: typeof ContactLifecycleAuthorityDeniedError;
  DISCORD_EVIDENCE_MUTATION_APPLIED: typeof DISCORD_EVIDENCE_MUTATION_APPLIED;
  DISCORD_EVIDENCE_MUTATION_RETIRED: typeof DISCORD_EVIDENCE_MUTATION_RETIRED;
  FleetAuthBrokerError: typeof FleetAuthBrokerError;
  FleetAuthorizationDeniedError: typeof FleetAuthorizationDeniedError;
  FleetEscalationError: typeof FleetEscalationError;
  HubDeviceAttachmentRejectedError: typeof HubDeviceAttachmentRejectedError;
  PrimaryEmbodimentHandoffDeniedError: typeof PrimaryEmbodimentHandoffDeniedError;
  createImmutableFleetAuthorizationContext: typeof createImmutableFleetAuthorizationContext;
  digestDiscordEvidence: typeof digestDiscordEvidence;
  digestDiscordEvidenceConfig: typeof digestDiscordEvidenceConfig;
  evaluateAccountRosterAuthorization: typeof evaluateAccountRosterAuthorization;
  evaluateFleetAuthorizationSessionSnapshot: typeof evaluateFleetAuthorizationSessionSnapshot;
  evaluateFleetAuthorizationSnapshot: typeof evaluateFleetAuthorizationSnapshot;
  fleetAuthRoleAllowsAction: typeof fleetAuthRoleAllowsAction;
  isUsablePositiveDiscordEvidence: typeof isUsablePositiveDiscordEvidence;
}

let configuredValues: FleetAuthPersistenceBoundaryValues | undefined;

export function installFleetAuthPersistenceBoundaryValues(
  values: FleetAuthPersistenceBoundaryValues,
): void {
  if (configuredValues && configuredValues !== values) {
    throw new Error('Fleet-auth persistence boundary values are already installed');
  }
  configuredValues = values;
}

export function requireFleetAuthPersistenceBoundaryValues(): FleetAuthPersistenceBoundaryValues {
  if (!configuredValues) {
    throw new Error(
      'Fleet-auth persistence requires gateway boundary values to be installed by composition',
    );
  }
  return configuredValues;
}

/** Late-bound view so importing an adapter does not itself require composition. */
export const fleetAuthPersistenceBoundaryValues: FleetAuthPersistenceBoundaryValues = new Proxy(
  {} as FleetAuthPersistenceBoundaryValues,
  {
    get: (_target, property: keyof FleetAuthPersistenceBoundaryValues) => (
      requireFleetAuthPersistenceBoundaryValues()[property]
    ),
  },
);
