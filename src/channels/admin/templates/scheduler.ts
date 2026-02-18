import type { ScheduledTask } from '../../../scheduler/types.js';
import { escapeHtml } from './shared.js';

export function schedulerPage(tasks: ScheduledTask[]): string {
  if (tasks.length === 0) return '<div class="empty">No scheduled tasks</div>';
  const rows = tasks.map(t => taskRow(t)).join('');
  return `
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Interval</th><th>State</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function taskRow(t: ScheduledTask): string {
  const interval = t.type === 'every'
    ? `${Math.round(t.intervalMs / 1000)}s`
    : t.runAt ? new Date(t.runAt).toLocaleString() : '-';
  return `<tr>
    <td>${escapeHtml(t.name)}</td>
    <td>${t.type}</td>
    <td>${interval}</td>
    <td>${t.state}</td>
  </tr>`;
}
