import { Users } from 'lucide-react';
import type {
  FleetApprovalEntry,
  FleetRosterCompanion,
} from '../lib/fleet-roster.js';
import { DrawerHeader } from './overlay-drawer.js';

/**
 * Companion selector page (psfn-framework-hbxz). A visual grid of the signed-in
 * human's companions with their avatar faces; the active companion is the one
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
}: {
  activeCompanionId: string | null;
  approvals: readonly FleetApprovalEntry[];
  companions: readonly FleetRosterCompanion[];
  connecting: boolean;
  onApprovalDecision: (id: string, decision: 'approve' | 'deny') => void;
  onClose: () => void;
  onSelect: (companionId: string) => void;
}) {
  const approvalsByCompanion = groupApprovalsByCompanion(approvals);
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
                  <CompanionApprovalCard
                    key={approval.id}
                    approval={approval}
                    onDecision={onApprovalDecision}
                  />
                ))}
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

function CompanionAvatar({ companion }: { companion: FleetRosterCompanion }) {
  if (companion.avatarRef) {
    return (
      <img
        className="companion-avatar"
        src={companion.avatarRef}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span className="companion-avatar companion-avatar-initial" aria-hidden>
      {initialOf(companion.displayName)}
    </span>
  );
}

function CompanionApprovalCard({
  approval,
  onDecision,
}: {
  approval: FleetApprovalEntry;
  onDecision: (id: string, decision: 'approve' | 'deny') => void;
}) {
  return (
    <article className="companion-approval-card">
      <strong>{approval.companionDisplayName}</strong>
      <p className="companion-approval-title">{approval.title}</p>
      <p className="companion-approval-context">{approval.redactedContext}</p>
      <div className="toast-actions">
        <button type="button" onClick={() => onDecision(approval.id, 'deny')}>
          Deny
        </button>
        <button type="button" onClick={() => onDecision(approval.id, 'approve')}>
          Approve
        </button>
      </div>
    </article>
  );
}

function groupApprovalsByCompanion(
  approvals: readonly FleetApprovalEntry[],
): Map<string, FleetApprovalEntry[]> {
  const grouped = new Map<string, FleetApprovalEntry[]>();
  for (const approval of approvals) {
    const bucket = grouped.get(approval.companionId);
    if (bucket) bucket.push(approval);
    else grouped.set(approval.companionId, [approval]);
  }
  return grouped;
}

function initialOf(displayName: string): string {
  const trimmed = displayName.trim();
  const first = trimmed.charAt(0);
  return first.length > 0 ? first.toUpperCase() : '?';
}
