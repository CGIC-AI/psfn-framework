import type { GatewayRpcConnection } from '../transport.js';
import {
  GATEWAY_RPC_MAX_CONNECTIONS,
  GATEWAY_RPC_PENDING_CONNECTIONS,
} from '../transport-admission.js';
import type { GatewayConnectionRole } from './connection-status.js';

/** Persistent slots cannot be consumed by another role or companion. */
export class GatewayConnectionBudget {
  readonly total: number;
  private readonly slots = new Map<string, GatewayRpcConnection>();

  constructor(private readonly multiCompanion: boolean, companionCount: number) {
    const persistentSlots = companionCount * 2;
    this.total = persistentSlots + GATEWAY_RPC_PENDING_CONNECTIONS;
    if (companionCount < 1 || this.total > GATEWAY_RPC_MAX_CONNECTIONS) {
      throw new Error('Gateway fleet topology exceeds the fixed RPC connection budget');
    }
  }

  reserve(conn: GatewayRpcConnection, role: GatewayConnectionRole, companionId?: string): boolean {
    if (role === 'unidentified' || (this.multiCompanion && !companionId)) return false;
    const key = `${this.multiCompanion ? companionId : 'single'}:${role}`;
    const existing = this.slots.get(key);
    if (existing && existing !== conn) return false;
    this.slots.set(key, conn);
    conn.completeAdmission?.();
    return true;
  }

  release(conn: GatewayRpcConnection): void {
    for (const [key, current] of this.slots) {
      if (current === conn) this.slots.delete(key);
    }
  }
}
