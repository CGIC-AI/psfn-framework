import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalPanelState } from '../lib/approvals.js';
import type { ArtifactShelfState } from '../lib/artifacts.js';
import { ToastLayer } from './context-layers.js';

const NO_ARTIFACTS: ArtifactShelfState = {
  capability: 'unsupported',
  items: [],
  blockedReason: 'unsupported',
};

function renderApprovals(approvals: ApprovalPanelState) {
  const onApprovalDecision = vi.fn();
  const { container } = render(
    <ToastLayer
      approvals={approvals}
      artifacts={NO_ARTIFACTS}
      error={null}
      onApprovalDecision={onApprovalDecision}
      onArtifactPreview={vi.fn()}
      stacked={false}
      updateReady={false}
      voiceNotice={null}
    />,
  );
  return { container, onApprovalDecision };
}

describe('approval cards', () => {
  it('renders complete shard attribution and submits only the offered decision', () => {
    const requestedAt = '2026-07-17T00:00:00.000Z';
    const expiresAt = '2026-07-17T00:05:00.000Z';
    const { container, onApprovalDecision } = renderApprovals({
      capability: 'available',
      blockedReason: null,
      requests: [{
        id: 'approval-1',
        title: 'Fetch documentation',
        status: 'pending',
        requestedAt,
        expiresAt,
        redactedContext: 'Shard requests an outbound fetch',
        expiresInSeconds: 240,
        sourceSystem: 'shard',
        attribution: {
          parentLabel: 'Companion',
          parentId: 'parent-opaque-1',
          shardLabel: 'research-shard',
          shardId: 'shard-opaque-1',
        },
        action: 'http.get',
        scope: 'https://example.test/docs',
        reason: 'Read public documentation',
        grantMode: { kind: 'once' },
      }],
    });

    expect(screen.getByText('Companion · research-shard')).toBeTruthy();
    expect(screen.getByText('parent-opaque-1')).toBeTruthy();
    expect(screen.getByText('shard-opaque-1')).toBeTruthy();
    expect(screen.getByText('http.get')).toBeTruthy();
    expect(screen.getByText('https://example.test/docs')).toBeTruthy();
    expect(screen.getByText('Read public documentation')).toBeTruthy();
    expect(screen.getByText('shard')).toBeTruthy();
    expect(screen.getByText('Grants one-time access')).toBeTruthy();
    expect(container.querySelector(`time[datetime="${requestedAt}"]`)).not.toBeNull();
    expect(container.querySelector(`time[datetime="${expiresAt}"]`)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprovalDecision).toHaveBeenCalledWith('approval-1', 'approve');
  });

  it('preserves the ordinary no-shard approval card fallback', () => {
    renderApprovals({
      capability: 'available',
      blockedReason: null,
      requests: [{
        id: 'approval-v1',
        title: 'Send outbound email',
        status: 'pending',
        requestedAt: '2026-07-17T00:00:00.000Z',
        redactedContext: 'Recipient and body redacted',
        expiresInSeconds: null,
      }],
    });

    expect(screen.getByText('Approval Request')).toBeTruthy();
    expect(screen.getByText('Send outbound email')).toBeTruthy();
    expect(screen.getByText('Recipient and body redacted')).toBeTruthy();
    expect(screen.queryByText('Parent ID')).toBeNull();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('renders the exact TTL offer and terminal server status without decision controls', () => {
    renderApprovals({
      capability: 'available',
      blockedReason: null,
      requests: [{
        id: 'approval-ttl',
        title: 'Use bounded network access',
        status: 'approved',
        requestedAt: '2026-07-17T00:00:00.000Z',
        expiresAt: '2026-07-17T00:05:00.000Z',
        redactedContext: 'Research access',
        resolvedAt: '2026-07-17T00:00:10.000Z',
        expiresInSeconds: null,
        attribution: {
          parentLabel: 'Companion',
          parentId: 'parent-opaque-1',
        },
        grantMode: { kind: 'ttl', ttlSeconds: 300 },
      }],
    });

    expect(screen.getByText('Grants access for 300s')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
