import type { DashboardStats } from '../types.js';
import { formatTokens } from '../../../llm/tokens.js';
import { escapeHtml } from './shared.js';

export function dashboardPage(stats: DashboardStats): string {
  const typeCards = Object.entries(stats.memoryByType)
    .map(([type, count]) =>
      `<div class="stat-card"><div class="value">${count}</div><div class="label"><span class="badge badge-${type}">${type}</span></div></div>`
    ).join('');
  const usage = stats.sessionUsage;
  const cost = usage.estimatedCostUsd > 0 ? `$${usage.estimatedCostUsd.toFixed(4)}` : 'n/a';
  const traces = stats.recentThinkTraces;
  const traceHtml = traces.length === 0
    ? '<div class="empty">No think traces captured yet</div>'
    : `<div class="think-trace">${
      traces.map(trace => {
        const when = new Date(trace.timestamp).toLocaleString();
        const stopNote = trace.budgetStop ? `, stop=${escapeHtml(trace.budgetStop)}` : '';
        const steps = trace.steps.map(step => {
          const vars = step.variablesChanged.length > 0
            ? `vars: ${escapeHtml(step.variablesChanged.join(', '))}`
            : 'vars: -';
          return `<div class="trace-step">
            <div class="meta">#${step.iteration} · ${formatTokens(step.inputTokens)} in / ${formatTokens(step.outputTokens)} out · cum ${formatTokens(step.cumulativeTokens)} · ${step.durationMs}ms · ${vars}</div>
            ${step.code ? `<pre>${escapeHtml(step.code.slice(0, 2000))}</pre>` : ''}
            ${step.output ? `<pre>${escapeHtml(step.output.slice(0, 1200))}</pre>` : ''}
            ${step.error ? `<pre>${escapeHtml(`Error: ${step.error}`)}</pre>` : ''}
          </div>`;
        }).join('');
        return `<div class="trace-item">
          <div class="trace-meta">
            <span>${when}</span>
            <span>${trace.iterations} iter</span>
            <span>${formatTokens(trace.totalTokens)} tokens</span>
            <span>${trace.durationMs}ms</span>
            ${trace.truncated ? '<span>truncated</span>' : ''}
            ${stopNote ? `<span>${stopNote.slice(2)}</span>` : ''}
          </div>
          <div class="trace-task">${escapeHtml(trace.task)}</div>
          ${steps}
        </div>`;
      }).join('')
    }</div>`;

  return `
    <div class="stats-grid">
      <div class="stat-card"><div class="value">${stats.memoryTotal}</div><div class="label">Total Memories</div></div>
      <div class="stat-card"><div class="value">${stats.avgSalience.toFixed(2)}</div><div class="label">Avg Salience</div></div>
      <div class="stat-card"><div class="value">${stats.sessionCount}</div><div class="label">Sessions</div></div>
      <div class="stat-card"><div class="value">${stats.schedulerTasks}</div><div class="label">Scheduled Tasks</div></div>
      <div class="stat-card"><div class="value">${stats.activeShards}</div><div class="label">Active Shards</div></div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Memory Types</h3>
      <div class="stats-grid">${typeCards || '<div class="empty">No memories yet</div>'}</div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Session Usage</h3>
      <div class="stats-grid">
        <div class="stat-card"><div class="value">${usage.turns}</div><div class="label">Tracked Turns</div></div>
        <div class="stat-card"><div class="value">${formatTokens(usage.inputTokens)}</div><div class="label">Input Tokens</div></div>
        <div class="stat-card"><div class="value">${formatTokens(usage.outputTokens)}</div><div class="label">Output Tokens</div></div>
        <div class="stat-card"><div class="value">${formatTokens(usage.cacheReadTokens)}</div><div class="label">Cache Read</div></div>
        <div class="stat-card"><div class="value">${usage.llmCalls}</div><div class="label">LLM Calls</div></div>
        <div class="stat-card"><div class="value">${usage.toolCalls}</div><div class="label">Tool Calls</div></div>
        <div class="stat-card"><div class="value">${usage.avgContextUtilization.toFixed(1)}%</div><div class="label">Avg Context Use</div></div>
        <div class="stat-card"><div class="value">${cost}</div><div class="label">Estimated Cost</div></div>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Reasoning Traces</h3>
      ${traceHtml}
    </div>`;
}
