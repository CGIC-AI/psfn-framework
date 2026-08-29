import { createHash, randomUUID } from 'node:crypto';

import { isBoundedString, isRfc4122Uuid } from '../../shared/utils/types.js';
import type { FleetOrdinalStagger } from './types.js';

const FLEET_MAINTENANCE_SCOPE = 'heavy_nighttime_maintenance';

export interface FleetScheduleWindowInput {
  companionId: string;
  fleetCompanionIds: readonly string[];
  windowStartMs: number;
  windowEndMs: number;
}

export interface FleetSchedulePosition {
  manifestOrdinal: number;
  scheduledAtMs: number;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function requireFleetOrder(fleetCompanionIds: readonly string[]): readonly string[] {
  if (fleetCompanionIds.length === 0) {
    throw new Error('fleet maintenance requires at least one manifest companion');
  }
  for (const companionId of fleetCompanionIds) {
    if (!isRfc4122Uuid(companionId)) {
      throw new Error('fleet maintenance manifest entries must be RFC 4122 UUIDs');
    }
  }
  if (new Set(fleetCompanionIds).size !== fleetCompanionIds.length) {
    throw new Error('fleet maintenance manifest companion ids must be unique');
  }
  return fleetCompanionIds;
}

function requireFutureTimestamp(value: number, nowMs: number, field: string): number {
  const timestamp = requireTimestamp(value, field);
  if (timestamp <= nowMs) {
    throw new Error(`${field} must be strictly greater than nowMs`);
  }
  return timestamp;
}

function requirePhase(value: string): string {
  if (!isBoundedString(value, 128)) {
    throw new Error('fleetMaintenance.phase must be a non-empty string of at most 128 characters');
  }
  return value;
}

export interface FleetMaintenanceLease {
  companionId: string;
  fencingToken: number;
  acquiredAtMs: number;
  expiresAtMs: number;
  phase: string;
  checkpointRef: string | null;
  preemptRequested: boolean;
}

export interface FleetMaintenanceCheckpoint {
  companionId: string;
  phase: string;
  checkpointRef: string | null;
  fencingToken: number;
  updatedAtMs: number;
}

export interface FleetMaintenanceCheckpointResult {
  lease: FleetMaintenanceLease;
  disposition: 'continue' | 'yield_requested';
}

export class FleetMaintenanceFenceLostError extends Error {
  constructor(message = 'fleet maintenance fencing authority was lost') {
    super(message);
    this.name = 'FleetMaintenanceFenceLostError';
  }
}

export type FleetMaintenanceAcquireResult =
  | { outcome: 'acquired'; lease: FleetMaintenanceLease }
  | {
      outcome: 'waiting';
      reason: 'held' | 'manifest_order' | 'no_demand';
      holderCompanionId: string | null;
      nextCompanionId: string | null;
      retryAtMs: number | null;
    };

export interface FleetMaintenanceStoreBinding {
  scope: typeof FLEET_MAINTENANCE_SCOPE;
  companionId: string;
  holderInstanceId: string;
  manifestOrdinal: number;
  fleetSize: number;
  manifestFingerprint: string;
}

export interface FleetMaintenanceStorePort {
  announceDemand(input: FleetMaintenanceStoreBinding & {
    nowMs: number;
    demandExpiresAtMs: number;
  }): Promise<void>;
  tryAcquire(input: FleetMaintenanceStoreBinding & {
    nowMs: number;
    leaseExpiresAtMs: number;
    phase: string;
  }): Promise<FleetMaintenanceAcquireResult>;
  renew(input: FleetMaintenanceStoreBinding & {
    fencingToken: number;
    nowMs: number;
    leaseExpiresAtMs: number;
  }): Promise<FleetMaintenanceLease>;
  commitCheckpoint(input: FleetMaintenanceStoreBinding & {
    fencingToken: number;
    nowMs: number;
    leaseExpiresAtMs: number;
    phase: string;
    checkpointRef: string | null;
  }): Promise<FleetMaintenanceCheckpointResult>;
  release(input: FleetMaintenanceStoreBinding & {
    fencingToken: number;
    nowMs: number;
    outcome: 'complete' | 'yield';
  }): Promise<void>;
  requestPreemption(input: FleetMaintenanceStoreBinding & { nowMs: number }): Promise<boolean>;
  withdrawDemand(input: FleetMaintenanceStoreBinding): Promise<void>;
  readCheckpoint(input: FleetMaintenanceStoreBinding): Promise<FleetMaintenanceCheckpoint | null>;
  close(): Promise<void>;
}

export interface FleetMaintenanceCoordinator {
  readonly companionId: string;
  readonly manifestOrdinal: number;
  readonly fleetSize: number;
  announceDemand(input: { nowMs: number; demandExpiresAtMs: number }): Promise<void>;
  tryAcquire(input: {
    nowMs: number;
    leaseExpiresAtMs: number;
    phase: string;
  }): Promise<FleetMaintenanceAcquireResult>;
  renew(input: {
    lease: FleetMaintenanceLease;
    nowMs: number;
    leaseExpiresAtMs: number;
  }): Promise<FleetMaintenanceLease>;
  commitCheckpoint(input: {
    lease: FleetMaintenanceLease;
    nowMs: number;
    leaseExpiresAtMs: number;
    phase: string;
    checkpointRef: string | null;
  }): Promise<FleetMaintenanceCheckpointResult>;
  release(input: {
    lease: FleetMaintenanceLease;
    nowMs: number;
    outcome: 'complete' | 'yield';
  }): Promise<void>;
  requestForegroundPreemption(input: { nowMs: number }): Promise<boolean>;
  withdrawDemand(): Promise<void>;
  readCheckpoint(): Promise<FleetMaintenanceCheckpoint | null>;
  close(): Promise<void>;
}

function requireFencingToken(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('fleetMaintenance.fencingToken must be a positive safe integer');
  }
  return value;
}

function requireCheckpointRef(value: string | null): string | null {
  if (value !== null && !isBoundedString(value, 512)) {
    throw new Error(
      'fleetMaintenance.checkpointRef must be null or a non-empty string of at most 512 characters',
    );
  }
  return value;
}

export function createFleetMaintenanceCoordinator(input: {
  store: FleetMaintenanceStorePort;
  companionId: string;
  fleetCompanionIds: readonly string[];
}): FleetMaintenanceCoordinator {
  const fleet = requireFleetOrder(input.fleetCompanionIds);
  const manifestOrdinal = fleet.indexOf(input.companionId);
  if (manifestOrdinal < 0) {
    throw new Error('fleetMaintenance.companionId is not present in the fleet manifest');
  }
  const binding: FleetMaintenanceStoreBinding = {
    scope: FLEET_MAINTENANCE_SCOPE,
    companionId: input.companionId,
    holderInstanceId: randomUUID(),
    manifestOrdinal,
    fleetSize: fleet.length,
    manifestFingerprint: createHash('sha256').update(fleet.join('\n')).digest('hex'),
  };

  const requireLocalLease = (lease: FleetMaintenanceLease): number => {
    if (lease.companionId !== input.companionId) {
      throw new FleetMaintenanceFenceLostError(
        'fleet maintenance lease belongs to another companion',
      );
    }
    return requireFencingToken(lease.fencingToken);
  };

  return {
    companionId: input.companionId,
    manifestOrdinal,
    fleetSize: fleet.length,
    async announceDemand({ nowMs, demandExpiresAtMs }) {
      const now = requireTimestamp(nowMs, 'fleetMaintenance.nowMs');
      await input.store.announceDemand({
        ...binding,
        nowMs: now,
        demandExpiresAtMs: requireFutureTimestamp(
          demandExpiresAtMs,
          now,
          'fleetMaintenance.demandExpiresAtMs',
        ),
      });
    },
    async tryAcquire({ nowMs, leaseExpiresAtMs, phase }) {
      const now = requireTimestamp(nowMs, 'fleetMaintenance.nowMs');
      return await input.store.tryAcquire({
        ...binding,
        nowMs: now,
        leaseExpiresAtMs: requireFutureTimestamp(
          leaseExpiresAtMs,
          now,
          'fleetMaintenance.leaseExpiresAtMs',
        ),
        phase: requirePhase(phase),
      });
    },
    async renew({ lease, nowMs, leaseExpiresAtMs }) {
      const now = requireTimestamp(nowMs, 'fleetMaintenance.nowMs');
      return await input.store.renew({
        ...binding,
        fencingToken: requireLocalLease(lease),
        nowMs: now,
        leaseExpiresAtMs: requireFutureTimestamp(
          leaseExpiresAtMs,
          now,
          'fleetMaintenance.leaseExpiresAtMs',
        ),
      });
    },
    async commitCheckpoint({ lease, nowMs, leaseExpiresAtMs, phase, checkpointRef }) {
      const now = requireTimestamp(nowMs, 'fleetMaintenance.nowMs');
      return await input.store.commitCheckpoint({
        ...binding,
        fencingToken: requireLocalLease(lease),
        nowMs: now,
        leaseExpiresAtMs: requireFutureTimestamp(
          leaseExpiresAtMs,
          now,
          'fleetMaintenance.leaseExpiresAtMs',
        ),
        phase: requirePhase(phase),
        checkpointRef: requireCheckpointRef(checkpointRef),
      });
    },
    async release({ lease, nowMs, outcome }) {
      await input.store.release({
        ...binding,
        fencingToken: requireLocalLease(lease),
        nowMs: requireTimestamp(nowMs, 'fleetMaintenance.nowMs'),
        outcome,
      });
    },
    async requestForegroundPreemption({ nowMs }) {
      return await input.store.requestPreemption({
        ...binding,
        nowMs: requireTimestamp(nowMs, 'fleetMaintenance.nowMs'),
      });
    },
    async withdrawDemand() {
      await input.store.withdrawDemand(binding);
    },
    async readCheckpoint() {
      return await input.store.readCheckpoint(binding);
    },
    async close() {
      await input.store.close();
    },
  };
}

export function staggerFleetOrdinalWithinWindow(
  input: FleetOrdinalStagger & { windowStartMs: number; windowEndMs: number },
): number {
  const windowStartMs = requireTimestamp(input.windowStartMs, 'fleetSchedule.windowStartMs');
  const windowEndMs = requireTimestamp(input.windowEndMs, 'fleetSchedule.windowEndMs');
  if (windowEndMs <= windowStartMs) {
    throw new Error('fleetSchedule.windowEndMs must be greater than windowStartMs');
  }
  if (!Number.isSafeInteger(input.fleetSize) || input.fleetSize < 1) {
    throw new Error('fleetSchedule.fleetSize must be a positive safe integer');
  }
  if (
    !Number.isSafeInteger(input.manifestOrdinal)
    || input.manifestOrdinal < 0
    || input.manifestOrdinal >= input.fleetSize
  ) {
    throw new Error('fleetSchedule.manifestOrdinal must identify a fleet member');
  }
  return windowStartMs + Math.floor(
    ((windowEndMs - windowStartMs) * input.manifestOrdinal) / input.fleetSize,
  );
}

/**
 * Place one lightweight scheduled action deterministically inside its existing
 * semantic window. Manifest order is the sole ordering authority; no companion
 * identity is privileged and the returned instant never leaves the window.
 */
export function staggerFleetScheduleWithinWindow(
  input: FleetScheduleWindowInput,
): FleetSchedulePosition {
  const fleet = requireFleetOrder(input.fleetCompanionIds);
  const manifestOrdinal = fleet.indexOf(input.companionId);
  if (manifestOrdinal < 0) {
    throw new Error('fleetSchedule.companionId is not present in the fleet manifest');
  }
  return {
    manifestOrdinal,
    scheduledAtMs: staggerFleetOrdinalWithinWindow({
      manifestOrdinal,
      fleetSize: fleet.length,
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
    }),
  };
}
