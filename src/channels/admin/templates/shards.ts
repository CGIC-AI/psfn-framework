import type { ActiveShard } from '../../../shards/manager.js';
import { escapeHtml } from './shared.js';

export function shardsPage(shards: ActiveShard[]): string {
  if (shards.length === 0) return '<div class="empty">No active shards</div>';
  const sorted = [...shards].sort((a, b) => b.startedAt - a.startedAt);
  return sorted.map(s => shardCard(s)).join('');
}

export function shardCard(s: ActiveShard): string {
  const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
  const heartbeatAgo = Math.max(0, Math.round((Date.now() - s.lastHeartbeatAt) / 1000));
  const capabilities = s.capabilities.length > 0
    ? s.capabilities.join(', ')
    : 'none';
  const required = s.requiredCapabilities.length > 0
    ? s.requiredCapabilities.join(', ')
    : 'none';
  const failureReasonText = s.failureReason?.trim()
    || (s.health !== 'healthy'
      ? `No explicit failure detail recorded (${s.stateReason}).`
      : '');
  const failureReason = failureReasonText
    ? `<p style="font-size:0.8rem;color:#b45309;margin-top:0.3rem">Failure: ${escapeHtml(failureReasonText)}</p>`
    : '';
  return `<div class="card shard-card" data-shard-id="${escapeHtml(s.id)}">
    <strong>${escapeHtml(s.name)}</strong>
    <p style="margin-top:0.3rem;color:var(--text-muted)">${escapeHtml(s.task.slice(0, 200))}</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">State: ${escapeHtml(s.state)} (${escapeHtml(s.health)})</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">Reason: ${escapeHtml(s.stateReason)}</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">Running for ${elapsed}s - heartbeat ${heartbeatAgo}s ago</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">Heartbeat thresholds: stale ${escapeHtml(String(s.heartbeatStaleAfterMs))}ms / evict ${escapeHtml(String(s.heartbeatDisconnectAfterMs))}ms</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">Capabilities: ${escapeHtml(capabilities)}</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">Required: ${escapeHtml(required)}</p>
    ${failureReason}
  </div>`;
}
