import type { ActiveShard } from '../../../shards/manager.js';
import { escapeHtml } from './shared.js';

export function shardsPage(shards: ActiveShard[]): string {
  if (shards.length === 0) return '<div class="empty">No active branches</div>';
  return shards.map(s => shardCard(s)).join('');
}

export function shardCard(s: ActiveShard): string {
  const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
  return `<div class="card shard-card" data-shard-id="${escapeHtml(s.id)}">
    <strong>${escapeHtml(s.name)}</strong>
    <p style="margin-top:0.3rem;color:var(--text-muted)">${escapeHtml(s.task.slice(0, 200))}</p>
    <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.3rem">Running for ${elapsed}s</p>
  </div>`;
}
