import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalPanelState } from '../lib/approvals.js';
import type { FleetRosterCompanion } from '../lib/fleet-roster.js';
import { CompanionSelectorPage } from './companion-selector.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

const COMPANIONS: readonly FleetRosterCompanion[] = [
  {
    companionId: COMPANION_A,
    displayName: 'Purrsephone',
    websocketPath: `/companion-ui/companions/${COMPANION_A}/ws`,
  },
  {
    companionId: COMPANION_B,
    displayName: 'Aria',
    websocketPath: `/companion-ui/companions/${COMPANION_B}/ws`,
    avatarRef: 'avatars/aria.png',
  },
];

function renderSelector(approvals: ApprovalPanelState) {
  const onApprovalDecision = vi.fn();
  const onSelect = vi.fn();
  render(
    <CompanionSelectorPage
      activeCompanionId={COMPANION_A}
      approvals={approvals}
      companions={COMPANIONS}
      connecting={false}
      onApprovalDecision={onApprovalDecision}
      onClose={vi.fn()}
      onSelect={onSelect}
    />,
  );
  return { onApprovalDecision, onSelect };
}

describe('CompanionSelectorPage', () => {
  it('renders no approval badge or controls before approvals.v2 is acknowledged', () => {
    renderSelector({
      capability: 'unsupported',
      blockedReason: 'approvals.v2 not acknowledged',
      requests: [{
        id: 'must-not-render',
        title: 'Hidden request',
        status: 'pending',
        requestedAt: '2026-07-17T00:00:00.000Z',
        redactedContext: 'Hidden context',
        expiresInSeconds: null,
        attribution: {
          parentId: COMPANION_B,
          parentLabel: 'Aria',
        },
        grantMode: { kind: 'once' },
      }],
    });

    expect(screen.queryByText('Hidden request')).toBeNull();
    expect(screen.queryByLabelText('1 pending approval')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('switches through the server-provided roster', () => {
    const { onSelect } = renderSelector({
      capability: 'available',
      blockedReason: null,
      requests: [],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Talk to Aria' }));
    expect(onSelect).toHaveBeenCalledWith(COMPANION_B);
    const avatar = document.querySelector('img.companion-avatar');
    expect(avatar?.getAttribute('src')).toBe('/companion-ui/avatars/aria.png');
    if (!avatar) throw new Error('missing companion avatar');
    fireEvent.error(avatar);
    expect(document.querySelector('img.companion-avatar')).toBeNull();
    expect(document.querySelectorAll('.companion-avatar-initial')).toHaveLength(2);
  });

  it('renders a fully attributed cross-companion approval through the canonical card', () => {
    const { onApprovalDecision } = renderSelector({
      capability: 'available',
      blockedReason: null,
      requests: [{
        id: 'approval-b',
        title: 'Fetch documentation',
        status: 'pending',
        requestedAt: '2026-07-17T00:00:00.000Z',
        redactedContext: 'Research request',
        expiresInSeconds: null,
        sourceSystem: 'shard',
        attribution: {
          parentId: COMPANION_B,
          parentLabel: 'Aria',
          shardId: 'shard-opaque-1',
          shardLabel: 'research-shard',
        },
        action: 'http.get',
        scope: 'https://example.test/docs',
        reason: 'Read public documentation',
        grantMode: { kind: 'once' },
      }],
    });

    expect(screen.getByLabelText('1 pending approval')).toBeTruthy();
    expect(screen.getByText('Aria · research-shard')).toBeTruthy();
    expect(screen.getByText('shard-opaque-1')).toBeTruthy();
    expect(screen.getByText('http.get')).toBeTruthy();
    expect(screen.getByText('Grants one-time access')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(onApprovalDecision).toHaveBeenCalledWith('approval-b', 'deny');
  });
});
