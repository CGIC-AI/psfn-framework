import { useState } from 'react';
import { Users } from 'lucide-react';
import type { ApprovalPanelState, ApprovalRequestView } from '../lib/approvals.js';
import {
  companionAvatarUrl,
  type FleetRosterCompanion,
} from '../lib/fleet-roster.js';
import { ApprovalCard } from './context-layers.js';
import { DrawerHeader } from './overlay-drawer.js';
import type { ShardDirectoryEntry } from '../../../src/shared/contracts/shard-directory.js';

/**
 * Companion selector page (psfn-framework-hbxz). A visual grid of the signed-in
 * Partner's companions with their avatar faces; the active companion is the one
 * the app is talking to. Approval badges surface fleet-wide requests (e.g.
 * "companion X needs web access") regardless of which companion is active, and
 * deciding one routes through the existing fleet approval path.
 *
 * Purely presentational: roster, active id, selection, and approval decisions
 * are owned by the fleet routing hook in App. avatarRef is rendered as an image
 * when the server provides one; until real sprites exist (7ang), a styled
 * initial stands in.
 */
export function CompanionSelectorPage({
  activeCompanionId,
  approvals,
  companions,
  connecting,
  onApprovalDecision,
  onClose,
  onSelect,
  onSelectShard,
  shards,
  activeShardId,
}: {
  activeCompanionId: string | null;
  approvals: ApprovalPanelState;
  companions: readonly FleetRosterCompanion[];
  connecting: boolean;
  onApprovalDecision: (id: string, decision: 'approve' | 'deny') => void;
  onClose: () => void;
  onSelect: (companionId: string) => void;
  onSelectShard?: (shardId: string | null) => void;
  shards?: readonly ShardDirectoryEntry[];
  activeShardId?: string | null;
}) {
  const approvalsByCompanion = groupApprovalsByCompanion(
    approvals.capability === 'available'
      ? approvals.requests.filter(request => request.status === 'pending')
      : [],
  );
  return (
    <aside className="overlay-drawer companion-selector" aria-label="Choose a companion">
      <DrawerHeader icon={<Users aria-hidden />} onClose={onClose} title="Companions" />
      <div className="drawer-content">
        <p className="companion-selector-hint">
          Pick who you are talking to. Requests from any companion reach you here.
        </p>
        <ul className="companion-grid">
          {companions.map((companion) => {
            const active = companion.companionId === activeCompanionId;
            const pending = approvalsByCompanion.get(companion.companionId) ?? [];
            return (
              <li key={companion.companionId}>
                <button
                  type="button"
                  className={`companion-tile ${active ? 'active' : ''}`}
                  onClick={() => onSelect(companion.companionId)}
                  disabled={connecting && !active}
                  aria-pressed={active}
                  aria-label={`Talk to ${companion.displayName}${active ? ' (active)' : ''}`}
                >
                  <span className="companion-avatar-wrap">
                    <CompanionAvatar companion={companion} />
                    {pending.length > 0 && (
                      <span className="companion-approval-badge" aria-label={`${pending.length} pending approval${pending.length === 1 ? '' : 's'}`}>
                        {pending.length}
                      </span>
                    )}
                  </span>
                  <span className="companion-name">{companion.displayName}</span>
                  {active && <span className="companion-active-tag">Active</span>}
                </button>
                {pending.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    request={approval}
                    onDecision={onApprovalDecision}
                  />
                ))}
                {active && (
                  <ShardDirectory
                    activeShardId={activeShardId ?? null}
                    onSelect={onSelectShard ?? (() => {})}
                    shards={shards ?? []}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

function ShardDirectory({
  activeShardId,
  onSelect,
  shards,
}: {
  activeShardId: string | null;
  onSelect: (shardId: string | null) => void;
  shards: readonly ShardDirectoryEntry[];
}) {
  return (
    <div className="shard-directory" aria-label="Deployed shards">
      <button
        type="button"
        className={`shard-row ${activeShardId === null ? 'active' : ''}`}
        onClick={() => onSelect(null)}
        aria-pressed={activeShardId === null}
      >
        Parent conversation
      </button>
      {shards.map(shard => (
        <button
          type="button"
          className={`shard-row ${activeShardId === shard.shardId ? 'active' : ''}`}
          key={shard.shardId}
          onClick={() => onSelect(shard.shardId)}
          disabled={shard.availability !== 'available'}
          aria-pressed={activeShardId === shard.shardId}
          aria-label={`Talk directly to shard ${shard.label}`}
        >
          <span className="shard-row-label">{shard.label}</span>
          <span className={`shard-availability ${shard.availability}`}>
            {shard.availability}
          </span>
          <span className="shard-purpose">{shard.purpose}</span>
        </button>
      ))}
      {shards.length === 0 && (
        <p className="shard-empty">No deployed shards are currently available.</p>
      )}
    </div>
  );
}

function CompanionAvatar({ companion }: { companion: FleetRosterCompanion }) {
  const [failedRef, setFailedRef] = useState<string | null>(null);
  const avatarUrl = companion.avatarRef ? companionAvatarUrl(companion.avatarRef) : null;
  if (avatarUrl && companion.avatarRef !== failedRef) {
    return (
      <img
        className="companion-avatar"
        src={avatarUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedRef(companion.avatarRef ?? null)}
      />
    );
  }
  return (
    <span className="companion-avatar companion-avatar-initial" aria-hidden>
      {initialOf(companion.displayName)}
    </span>
  );
}

function groupApprovalsByCompanion(
  approvals: readonly ApprovalRequestView[],
): Map<string, ApprovalRequestView[]> {
  const grouped = new Map<string, ApprovalRequestView[]>();
  for (const approval of approvals) {
    const companionId = approval.attribution?.parentId;
    if (!companionId) continue;
    const bucket = grouped.get(companionId);
    if (bucket) bucket.push(approval);
    else grouped.set(companionId, [approval]);
  }
  return grouped;
}

function initialOf(displayName: string): string {
  const trimmed = displayName.trim();
  const first = trimmed.charAt(0);
  return first.length > 0 ? first.toUpperCase() : '?';
}
