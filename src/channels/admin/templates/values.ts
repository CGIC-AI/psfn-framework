import type { ValuesJournalEntry } from '../../../values/store.js';
import { escapeHtml } from './shared.js';

interface ValuesTimelinePageModel {
  entries: ValuesJournalEntry[];
}

export function valuesTimelinePage(model: ValuesTimelinePageModel): string {
  const { entries } = model;
  const items = entries.length > 0
    ? entries.map(entry => valuesTimelineItem(entry)).join('')
    : '<div class="empty">No values reflections have been recorded yet.</div>';

  return `
    <p class="audit-intro">
      Versioned values journal entries captured from periodic "values-reflection" heartbeats.
    </p>
    <div class="values-feed">${items}</div>`;
}

export function valuesTimelineItem(entry: ValuesJournalEntry): string {
  const timestamp = new Date(entry.createdAt);
  const dateLabel = timestamp.toLocaleDateString();
  const timeLabel = timestamp.toLocaleTimeString();

  return `<article class="audit-item values-item" data-version="${entry.version}" data-template-id="${escapeHtml(entry.templateId)}">
    <div class="audit-item-meta">
      <span class="audit-item-time">${escapeHtml(`${dateLabel} ${timeLabel}`)}</span>
      <span class="audit-badge">v${entry.version}</span>
      <span class="audit-badge">${escapeHtml(entry.templateName)}</span>
    </div>
    <div class="audit-item-details values-prompt">${escapeHtml(entry.prompt)}</div>
    <div class="audit-item-narrative values-reflection">${escapeHtml(entry.reflection)}</div>
  </article>`;
}
