import type { PurrMemory } from '../../../memory/types.js';
import { escapeHtml } from './shared.js';

export function memoryListPage(memories: PurrMemory[]): string {
  const searchForm = `
    <form class="search-form" hx-post="/api/memory/search" hx-target="#memory-results" hx-swap="innerHTML">
      <input type="text" name="query" placeholder="Search memories..." required>
      <button type="submit">Search</button>
    </form>`;

  const tableBody = memories.length > 0
    ? memories.map(m => memoryRow(m)).join('')
    : '<tr><td colspan="6" class="empty">No memories found</td></tr>';

  return `
    ${searchForm}
    <div class="card">
      <table>
        <thead><tr>
          <th>Type</th><th>Text</th><th>Salience</th><th>Importance</th><th>Extracted</th><th></th>
        </tr></thead>
        <tbody id="memory-results">${tableBody}</tbody>
      </table>
    </div>`;
}

export function memoryRow(m: PurrMemory): string {
  const date = new Date(m.extractedAt).toLocaleDateString();
  const truncText = m.text.length > 120 ? escapeHtml(m.text.slice(0, 120)) + '...' : escapeHtml(m.text);
  return `<tr data-memory-type="${m.type}">
    <td><span class="badge badge-${m.type}">${m.type}</span></td>
    <td><a href="/memory/${encodeURIComponent(m.id)}">${truncText}</a></td>
    <td>${m.salience.toFixed(2)}</td>
    <td>${m.importance.toFixed(2)}</td>
    <td>${date}</td>
    <td><button class="btn btn-danger" hx-post="/api/memory/${encodeURIComponent(m.id)}/supersede" hx-confirm="Supersede this memory?" hx-target="closest tr" hx-swap="outerHTML" style="font-size:0.75rem;padding:0.25rem 0.5rem">x</button></td>
  </tr>`;
}

export function memoryDetailPage(m: PurrMemory): string {
  const date = new Date(m.extractedAt).toLocaleString();
  const accessed = new Date(m.lastAccessed).toLocaleString();
  return `
    <div class="card">
      <p><span class="badge badge-${m.type}">${m.type}</span></p>
      <p style="margin:1rem 0;white-space:pre-wrap">${escapeHtml(m.text)}</p>
      <table class="config-table">
        <tr><td>ID</td><td>${escapeHtml(m.id)}</td></tr>
        <tr><td>Salience</td><td>${m.salience.toFixed(3)}</td></tr>
        <tr><td>Importance</td><td>${m.importance.toFixed(3)}</td></tr>
        <tr><td>Confidence</td><td>${m.confidence.toFixed(3)}</td></tr>
        <tr><td>Emotional Valence</td><td>${m.emotionalValence.toFixed(3)}</td></tr>
        <tr><td>Source</td><td>${escapeHtml(m.sourceRef)}</td></tr>
        <tr><td>Extracted</td><td>${date}</td></tr>
        <tr><td>Last Accessed</td><td>${accessed}</td></tr>
        <tr><td>Access Count</td><td>${m.accessCount}</td></tr>
        <tr><td>Tags</td><td>${m.tags.map(t => escapeHtml(t)).join(', ') || 'none'}</td></tr>
        ${m.supersededBy ? `<tr><td>Superseded By</td><td>${escapeHtml(m.supersededBy)}</td></tr>` : ''}
      </table>
    </div>
    <a href="/memory">&larr; Back to Memory Blossoms</a>`;
}
