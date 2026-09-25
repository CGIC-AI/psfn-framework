import type { CompanionFleetEntry, CompanionsFleetConfig } from '../config/companions-config.js';
import type { FleetLifecycleStageOutcome } from './contracts.js';

/** Canonical roster owner (companions.json) with digest-revision CAS. */
export interface FleetTopologyPort {
  read(): { readonly config: CompanionsFleetConfig; readonly revision: string };
  /** Compute the revision the given config would have once published. */
  revisionOf(config: CompanionsFleetConfig): string;
  /** Publish only if the current revision still equals `expectedRevision`. */
  publish(next: CompanionsFleetConfig, expectedRevision: string): string;
}

/** Deployment-specific prerequisite checks for an add. Each throws a FleetLifecycleError. */
export interface FleetPrerequisitePort {
  verifyTenant(entry: CompanionFleetEntry, topology: CompanionsFleetConfig): Promise<void>;
  verifySecretRefs(entry: CompanionFleetEntry, topology: CompanionsFleetConfig): Promise<void>;
  verifyOwnerRoots(entry: CompanionFleetEntry): Promise<void>;
  verifyWorkspace(entry: CompanionFleetEntry, next: CompanionsFleetConfig): Promise<void>;
}

/** Workload wiring owned by the deployment (local supervisor or Helm chart). */
export interface FleetWorkloadPort {
  verifyPrerequisites(entry: CompanionFleetEntry): Promise<FleetLifecycleStageOutcome>;
  /** Confirm the companion's workload is no longer admitted/running. */
  drain(companionId: string): Promise<FleetLifecycleStageOutcome>;
}

/** Durable, non-expiring ICP lifecycle admission fence (h248l.9). */
export interface IcpLifecycleFencePort {
  isFenced(companionId: string): Promise<boolean>;
  fence(companionId: string, nowMs: number): Promise<{ transitioned: boolean }>;
  clear(companionId: string, nowMs: number): Promise<{ transitioned: boolean }>;
}

type FleetAuthCompanionState =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'present'; lifecycle: string; restoreState: string }>;

/**
 * Read-only view of fleet-auth companion authority. Re-adding a removed
 * companion requires fleet-auth readd plus the audited ADMIN_TOKEN operator's
 * companion reinstatement to
 * have returned it to lifecycle `active` with a `live` restore state.
 */
export type FleetAuthAdmissionPort =
  | Readonly<{ disabled: true }>
  | Readonly<{
    disabled: false;
    readCompanion(companionId: string): Promise<FleetAuthCompanionState>;
  }>;

export interface FleetLifecyclePorts {
  readonly topology: FleetTopologyPort;
  readonly prerequisites: FleetPrerequisitePort;
  readonly workload: FleetWorkloadPort;
  readonly icpFence: IcpLifecycleFencePort;
  readonly fleetAuth: FleetAuthAdmissionPort;
}
