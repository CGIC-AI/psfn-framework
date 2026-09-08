import { useEffect, useRef, useState } from 'react';
import { FleetSessionClient, type FleetSessionStatus } from '../lib/fleet-session.js';
import { mergeFleetApprovalHistory } from '../lib/fleet-approval-routing.js';
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
  const sessionClientRef = useRef<FleetSessionClient | null>(null);
  sessionClientRef.current ??= new FleetSessionClient();
  const connectRef = useRef(input.connect);
  connectRef.current = input.connect;
  const reportErrorRef = useRef(input.reportError);
  reportErrorRef.current = input.reportError;
  const accessStateRef = useRef(input.accessState);
  accessStateRef.current = input.accessState;
  const routingEpochRef = useRef(0);
  const selectionEpochRef = useRef(0);
  const pollingEpochRef = useRef<number | null>(null);
  const activeCompanionIdRef = useRef<string | null>(null);
  const [roster, setRoster] = useState<readonly FleetRosterCompanion[]>([]);
  const [activeCompanionId, setActiveCompanionId] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<readonly FleetApprovalEntry[]>([]);
  const [approvalHistory, setApprovalHistory] = useState<readonly FleetApprovalEntry[]>([]);

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
    const routingEpoch = routingEpochRef.current;
    const current = () => routingEpoch === routingEpochRef.current && isCurrent();
    const client = clientRef.current;
    const sessionClient = sessionClientRef.current;
    if (!client || !sessionClient) throw new Error('Cluster roster client is unavailable');
    try {
      await sessionClient.renewIfDue();
    } catch (error) {
      // Status already proved that the browser has a signed-in session. A
      // transient renewal failure must not discard that authority or strand
      // the cockpit offline; the active approvals cadence retries renewal.
      if (current()) reportErrorRef.current(error instanceof Error
        ? error.message
        : 'Cluster session renewal failed');
    }
    if (!current()) return;
    const { roster: nextRoster, approvals: nextApprovals } = await client.readRoutingSnapshot();
    if (!current()) return;
    const selected = nextRoster.companions.find(
      companion => companion.companionId === activeCompanionIdRef.current,
    ) ?? nextRoster.companions.find(
      companion => companion.websocketPath === status.websocketPath,
    ) ?? nextRoster.companions[0];
    if (!selected) throw new Error('Cluster session has no authorized companions');
    activeCompanionIdRef.current = selected.companionId;
    setRoster(nextRoster.companions);
    setActiveCompanionId(selected.companionId);
    rememberApprovals(nextApprovals.approvals);
    if (connectWhenAllowed) await connectRef.current(selected.websocketPath, authorityEpoch);
  }

  async function refreshApprovals(): Promise<void> {
    const client = clientRef.current;
    const sessionClient = sessionClientRef.current;
    const epoch = routingEpochRef.current;
    const current = () => epoch === routingEpochRef.current && accessStateRef.current === 'signed_in';
    if (!client || !sessionClient || !current() || pollingEpochRef.current === epoch) return;
    pollingEpochRef.current = epoch;
    try {
      await sessionClient.renewIfDue();
      if (!current()) return;
      const next = await client.readApprovals();
      if (current()) rememberApprovals(next.approvals);
    } catch (error) {
      if (current()) reportErrorRef.current(error instanceof Error ? error.message : 'Cluster approvals refresh failed');
    } finally {
      if (pollingEpochRef.current === epoch) pollingEpochRef.current = null;
    }
  }

  function rememberApprovals(next: readonly FleetApprovalEntry[]): void {
    setApprovals(next);
    setApprovalHistory(current => mergeFleetApprovalHistory(current, next));
  }

  async function select(companionId: string): Promise<boolean> {
    if (accessStateRef.current !== 'signed_in') return false;
    const selectionEpoch = ++selectionEpochRef.current;
    const companion = roster.find(entry => entry.companionId === companionId);
    if (!companion) {
      reportErrorRef.current('Selected companion is no longer authorized');
      return false;
    }
    try {
      if (!await connectRef.current(companion.websocketPath)
        || selectionEpoch !== selectionEpochRef.current || accessStateRef.current !== 'signed_in') return false;
      activeCompanionIdRef.current = companion.companionId;
      setActiveCompanionId(companion.companionId);
      return true;
    } catch (error) {
      if (selectionEpoch === selectionEpochRef.current && accessStateRef.current === 'signed_in') {
        reportErrorRef.current(error instanceof Error ? error.message : 'Companion switch failed');
      }
      return false;
    }
  }

  function clear(): void {
    routingEpochRef.current += 1;
    selectionEpochRef.current += 1;
    pollingEpochRef.current = null;
    setRoster([]);
    setApprovals([]);
    setApprovalHistory([]);
    setActiveCompanionId(null);
    activeCompanionIdRef.current = null;
  }

  return {
    activeCompanionId,
    activeCompanionIdRef,
    approvalHistory,
    approvals,
    clear,
    load,
    roster,
    select,
  };
}
