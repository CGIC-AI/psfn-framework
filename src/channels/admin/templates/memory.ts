import type { PurrMemory } from '../../../memory/types.js';
import { escapeHtml } from './shared.js';

interface MemoryContactView {
  id: string;
  displayName: string;
}

function isRelationalMemory(m: PurrMemory): boolean {
  return m.type === 'relational' || m.type === 'emotional';
}

function describeConsentFlags(m: PurrMemory): string[] {
  const cues: string[] = [];
  if (m.consentFlags?.allowRecall === false) cues.push('recall denied');
  if (m.consentFlags?.allowAbstraction === false) cues.push('no abstraction');
  if (m.consentFlags?.deleteOnRequest === true) cues.push('delete on request');
  return cues;
}

function sensitivityBadge(level: string): string {
  return `<span class="memory-sensitivity memory-sensitivity-${escapeHtml(level)}">${escapeHtml(level)}</span>`;
}

function formatContactLink(contactId: string, label: string): string {
  const fragment = encodeURIComponent(`contact-row-${contactId}`);
  const viewHref = `/contacts#${fragment}`;
  const editHref = `/api/contacts/${encodeURIComponent(contactId)}/edit`;
  return `<div><a href="${viewHref}">${escapeHtml(label)}</a></div>
    <div class="crm-notes"><a href="${viewHref}">view</a> · <a href="${editHref}">edit</a></div>`;
}

function memoryContactCell(m: PurrMemory, linkedContact?: MemoryContactView): string {
  if (!isRelationalMemory(m)) return '<span class="crm-notes">—</span>';
  if (!m.contactId) return '<span class="crm-notes">unlinked</span>';
  const contactLabel = linkedContact?.displayName ?? `contact:${m.contactId}`;
  return formatContactLink(m.contactId, contactLabel);
}

function memoryPrivacyCell(m: PurrMemory): string {
  const consentCues = describeConsentFlags(m);
  return `
    ${sensitivityBadge(m.sensitivity)}
    ${consentCues.length > 0 ? `<div class="crm-notes">${escapeHtml(consentCues.join(' · '))}</div>` : ''}
  `;
}

function memoryContactDetail(m: PurrMemory, linkedContact?: MemoryContactView): string {
  if (!isRelationalMemory(m)) return 'none';
  if (!m.contactId) return '<span class="crm-notes">No linked contact</span>';
  const contactLabel = linkedContact?.displayName ?? `contact:${m.contactId}`;
  return formatContactLink(m.contactId, contactLabel);
}

function memoryConsentDetail(m: PurrMemory): string {
  const consentCues = describeConsentFlags(m);
  if (consentCues.length === 0) return 'none';
  return escapeHtml(consentCues.join(', '));
}

function formatProvenanceSegment(segment: string): string {
  if (segment.startsWith('source:')) return `source ${segment.slice('source:'.length)}`;
  if (segment.startsWith('session:')) return `session ${segment.slice('session:'.length)}`;
  if (segment.startsWith('lines:')) return `lines ${segment.slice('lines:'.length)}`;
  if (segment.startsWith('visibility:')) return `visibility ${segment.slice('visibility:'.length)}`;
  if (segment.startsWith('operation:')) return `operation ${segment.slice('operation:'.length)}`;
  if (segment.startsWith('invocation:')) return `invocation ${segment.slice('invocation:'.length)}`;
  if (segment.startsWith('item:')) return `item ${segment.slice('item:'.length)}`;
  return segment;
}

function memoryProvenanceDetail(m: PurrMemory): string {
  const segments = m.sourceRef
    .split('|')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(formatProvenanceSegment);

  if (segments.length === 0) return 'none';
  return segments.map(segment => escapeHtml(segment)).join(' &rarr; ');
}

export function memoryListPage(
  memories: PurrMemory[],
  contactById: ReadonlyMap<string, MemoryContactView> = new Map(),
): string {
  const searchForm = `
    <form class="search-form" hx-post="/api/memory/search" hx-target="#memory-results" hx-swap="innerHTML">
      <input type="text" name="query" placeholder="Search memories..." required>
      <button type="submit">Search</button>
    </form>`;

  const tableBody = memories.length > 0
    ? memories.map(m => memoryRow(m, m.contactId ? contactById.get(m.contactId) : undefined)).join('')
    : '<tr><td colspan="8" class="empty">No memories found</td></tr>';

  return `
    ${searchForm}
    <div class="card">
      <table>
        <thead><tr>
          <th>Type</th><th>Text</th><th>Contact</th><th>Salience</th><th>Importance</th><th>Privacy</th><th>Extracted</th><th></th>
        </tr></thead>
        <tbody id="memory-results">${tableBody}</tbody>
      </table>
    </div>`;
}

export function memoryRow(m: PurrMemory, linkedContact?: MemoryContactView): string {
  const date = new Date(m.extractedAt).toLocaleDateString();
  const truncText = m.text.length > 120 ? escapeHtml(m.text.slice(0, 120)) + '...' : escapeHtml(m.text);
  return `<tr data-memory-type="${m.type}">
    <td><span class="badge badge-${m.type}">${m.type}</span></td>
    <td><a href="/memory/${encodeURIComponent(m.id)}">${truncText}</a></td>
    <td>${memoryContactCell(m, linkedContact)}</td>
    <td>${m.salience.toFixed(2)}</td>
    <td>${m.importance.toFixed(2)}</td>
    <td>${memoryPrivacyCell(m)}</td>
    <td>${date}</td>
    <td><button class="btn btn-danger" hx-post="/api/memory/${encodeURIComponent(m.id)}/supersede" hx-confirm="Supersede this memory?" hx-target="closest tr" hx-swap="outerHTML" style="font-size:0.75rem;padding:0.25rem 0.5rem">x</button></td>
  </tr>`;
}

export function memoryDetailPage(m: PurrMemory, linkedContact?: MemoryContactView): string {
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
        <tr><td>Sensitivity</td><td>${sensitivityBadge(m.sensitivity)}</td></tr>
        <tr><td>Consent Flags</td><td>${memoryConsentDetail(m)}</td></tr>
        ${isRelationalMemory(m) || m.contactId ? `<tr><td>Related Contact</td><td>${memoryContactDetail(m, linkedContact)}</td></tr>` : ''}
        <tr><td>Provenance</td><td>${memoryProvenanceDetail(m)}</td></tr>
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
