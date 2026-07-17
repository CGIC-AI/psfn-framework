import { useEffect, useRef, useState } from 'react';
import type { FleetSessionStatus } from '../lib/fleet-session.js';
import {
  FleetRosterClient,
  type FleetApprovalEntry,
  type FleetRosterCompanion,
} from '../lib/fleet-roster.js';

type SignedInStatus = Extract<FleetSessionStatus, { state: 'signed_in' }>;

export function useFleetRouting(input: {
  accessState: string;
  connect: (path: string, expectedAuthorityEpoch?: number) => Promise<boolean>;
  reportError: (message: string) => void;
}) {
  const clientRef = useRef<FleetRosterClient | null>(null);
  clientRef.current ??= new FleetRosterClient();
  const connectRef = useRef(input.connect);
  connectRef.current = input.connect;
  const reportErrorRef = useRef(input.reportError);
  reportErrorRef.current = input.reportError;
  const activeCompanionIdRef = useRef<string | null>(null);
  const [roster, setRoster] = useState<readonly FleetRosterCompanion[]>([]);
  const [activeCompanionId, setActiveCompanionId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly FleetApprovalEntry[]>([]);

  useEffect(() => {
    if (input.accessState !== 'signed_in') return undefined;
    const interval = window.setInterval(() => {
      void refreshApprovals();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [input.accessState]);

  async function load(
    status: SignedInStatus,
    authorityEpoch: number,
    isCurrent: () => boolean,
    connectWhenAllowed: boolean,
  ): Promise<void> {
    const client = clientRef.current;
    if (!client) throw new Error('Fleet roster client is unavailable');
    const [nextRoster, nextApprovals] = await Promise.all([
      client.readRoster(),
      client.readApprovals(),
    ]);
    if (!isCurrent()) return;
    const selected = nextRoster.companions.find(
      companion => companion.companionId === activeCompanionIdRef.current,
    ) ?? nextRoster.companions.find(
      companion => companion.websocketPath === status.websocketPath,
    ) ?? nextRoster.companions[0];
    if (!selected) throw new Error('Fleet session has no authorized companions');
    activeCompanionIdRef.current = selected.companionId;
    setRoster(nextRoster.companions);
    setActiveCompanionId(selected.companionId);
    setApprovals(nextApprovals.approvals);
    if (connectWhenAllowed) await connectRef.current(selected.websocketPath, authorityEpoch);
  }

  async function refreshApprovals(): Promise<void> {
    const client = clientRef.current;
    if (!client || input.accessState !== 'signed_in') return;
    try {
      const next = await client.readApprovals();
      setApprovals(next.approvals);
    } catch (error) {
      reportErrorRef.current(error instanceof Error ? error.message : 'Fleet approvals refresh failed');
    }
  }

  async function select(companionId: string): Promise<boolean> {
    if (input.accessState !== 'signed_in') return false;
    const companion = roster.find(entry => entry.companionId === companionId);
    if (!companion) {
      reportErrorRef.current('Selected companion is no longer authorized');
      return false;
    }
    try {
      if (!await connectRef.current(companion.websocketPath)) return false;
      activeCompanionIdRef.current = companion.companionId;
      setActiveCompanionId(companion.companionId);
      return true;
    } catch (error) {
      reportErrorRef.current(error instanceof Error ? error.message : 'Companion switch failed');
      return false;
    }
  }

  function clear(): void {
    setRoster([]);
    setApprovals([]);
    setActiveCompanionId(null);
    activeCompanionIdRef.current = null;
  }

  return {
    activeCompanionId,
    activeCompanionIdRef,
    approvals,
    clear,
    load,
    removeApproval: (id: string) => setApprovals(current => current.filter(entry => entry.id !== id)),
    roster,
    select,
  };
}
