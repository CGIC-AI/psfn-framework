import { digestDiscordEvidenceConfig } from '../../boundary/fleet-auth/discord-evidence-runtime.js';
import {
  DISCORD_EVIDENCE_MUTATION_APPLIED,
  DISCORD_EVIDENCE_MUTATION_RETIRED,
  digestDiscordEvidence,
  isUsablePositiveDiscordEvidence,
} from '../../boundary/fleet-auth/discord-evidence-types.js';
import { FleetEscalationError } from '../../boundary/fleet-auth/escalation.js';
import { HubDeviceAttachmentRejectedError } from '../../boundary/fleet-auth/hub-device-ingress.js';
import { fleetAuthRoleAllowsAction } from '../../boundary/fleet-auth/role-action-policy.js';
import { PrimaryEmbodimentHandoffDeniedError } from '../../boundary/fleet-auth/primary-embodiment.js';
import { ContactLifecycleAuthorityDeniedError } from '../../boundary/gateway/contact-lifecycle-authority.js';
import { FleetAuthBrokerError } from '../../boundary/gateway/fleet-auth-broker.js';
import {
  createImmutableFleetAuthorizationContext,
  evaluateAccountRosterAuthorization,
  evaluateFleetAuthorizationSessionSnapshot,
  evaluateFleetAuthorizationSnapshot,
  FleetAuthorizationDeniedError,
} from '../../boundary/gateway/fleet-authorization-context.js';
import {
  installFleetAuthPersistenceBoundaryValues,
  type FleetAuthPersistenceBoundaryValues,
} from '../../persistence/postgres/fleet-auth/boundary-values-port.js';

const GATEWAY_FLEET_AUTH_PERSISTENCE_BOUNDARY_VALUES = Object.freeze({
  ContactLifecycleAuthorityDeniedError,
  DISCORD_EVIDENCE_MUTATION_APPLIED,
  DISCORD_EVIDENCE_MUTATION_RETIRED,
  FleetAuthBrokerError,
  FleetAuthorizationDeniedError,
  FleetEscalationError,
  HubDeviceAttachmentRejectedError,
  PrimaryEmbodimentHandoffDeniedError,
  createImmutableFleetAuthorizationContext,
  digestDiscordEvidence,
  digestDiscordEvidenceConfig,
  evaluateAccountRosterAuthorization,
  evaluateFleetAuthorizationSessionSnapshot,
  evaluateFleetAuthorizationSnapshot,
  fleetAuthRoleAllowsAction,
  isUsablePositiveDiscordEvidence,
}) satisfies FleetAuthPersistenceBoundaryValues;

/** Install the canonical gateway policy/error values used by PostgreSQL adapters. */
export function installGatewayFleetAuthPersistenceBoundary(): void {
  installFleetAuthPersistenceBoundaryValues(GATEWAY_FLEET_AUTH_PERSISTENCE_BOUNDARY_VALUES);
}
