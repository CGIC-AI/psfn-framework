import {
  createFleetMaintenanceCoordinator,
  type FleetMaintenanceLease,
} from '../../../core/scheduler/fleet-maintenance-coordinator.js';
import { PostgresFleetMaintenanceStore } from '../fleet-maintenance-store.js';

type Command =
  | { requestId: number; action: 'announce'; nowMs: number; demandExpiresAtMs: number }
  | {
      requestId: number;
      action: 'acquire';
      nowMs: number;
      leaseExpiresAtMs: number;
      phase: string;
    }
  | {
      requestId: number;
      action: 'checkpoint';
      lease: FleetMaintenanceLease;
      nowMs: number;
      leaseExpiresAtMs: number;
      phase: string;
      checkpointRef: string | null;
    }
  | {
      requestId: number;
      action: 'release';
      lease: FleetMaintenanceLease;
      nowMs: number;
      outcome: 'complete' | 'yield';
    }
  | { requestId: number; action: 'readCheckpoint' }
  | { requestId: number; action: 'shutdown' };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`fleet maintenance process requires ${name}`);
  return value;
}

function send(value: unknown): void {
  if (!process.send) throw new Error('fleet maintenance process requires IPC');
  process.send(value);
}

const databaseUrl = requireEnv('FLEET_MAINTENANCE_DATABASE_URL');
const companionId = requireEnv('FLEET_MAINTENANCE_COMPANION_ID');
const fleetCompanionIds = JSON.parse(
  requireEnv('FLEET_MAINTENANCE_COMPANION_IDS'),
) as unknown;
if (!Array.isArray(fleetCompanionIds)
  || fleetCompanionIds.some(value => typeof value !== 'string')) {
  throw new Error('FLEET_MAINTENANCE_COMPANION_IDS must be a JSON string array');
}

const store = await PostgresFleetMaintenanceStore.connect(databaseUrl);
const coordinator = createFleetMaintenanceCoordinator({
  store,
  companionId,
  fleetCompanionIds,
});

let commandTail = Promise.resolve();
process.on('message', (raw) => {
  commandTail = commandTail.then(async () => {
    const command = raw as Command;
    try {
      let result: unknown;
      switch (command.action) {
        case 'announce':
          result = await coordinator.announceDemand(command);
          break;
        case 'acquire':
          result = await coordinator.tryAcquire(command);
          break;
        case 'checkpoint':
          result = await coordinator.commitCheckpoint(command);
          break;
        case 'release':
          result = await coordinator.release(command);
          break;
        case 'readCheckpoint':
          result = await coordinator.readCheckpoint();
          break;
        case 'shutdown':
          await store.close();
          send({ requestId: command.requestId, ok: true });
          process.disconnect();
          return;
      }
      send({ requestId: command.requestId, ok: true, result });
    } catch (error) {
      send({
        requestId: command.requestId,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
});

send({ ready: true });
