import type { PurrMemory } from '../../../memory/types.js';
import { escapeHtml } from './shared.js';

interface MemoryContactView {
  id: string;
  displayName: string;
}

interface MemoryListPaginationView {
  limit: number;
  offset: number;
  total: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

const MEMORY_TYPE_OPTIONS = [
  'episodic',
  'semantic',
  'emotional',
  'procedural',
  'boundary',
  'reflection',
  'relational',
] as const;

const MEMORY_SENSITIVITY_OPTIONS = ['public', 'personal', 'intimate', 'confidential'] as const;

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

function renderOptionList(options: readonly string[]): string {
  return options.map(option => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('');
}

function memoryActionScript(): string {
  return `
    <script>
      (() => {
        const root = document.getElementById('memory-admin-actions');
        if (!root) return;

        const feedbackEl = root.querySelector('[data-memory-feedback]');
        const selectedCountEl = root.querySelector('[data-memory-selected-count]');
        const bulkDeleteBtn = root.querySelector('[data-memory-bulk-delete]');
        const bulkUpdateBtn = root.querySelector('[data-memory-bulk-update]');
        const bulkTypeSelect = root.querySelector('[data-memory-bulk-type]');
        const bulkSensitivitySelect = root.querySelector('[data-memory-bulk-sensitivity]');
        const linkForm = root.querySelector('[data-memory-link-form]');
        const linkId1Input = root.querySelector('[data-memory-link-id1]');
        const linkId2Input = root.querySelector('[data-memory-link-id2]');
        const linkTypeInput = root.querySelector('[data-memory-link-type]');
        const useSelectedPairBtn = root.querySelector('[data-memory-use-selected-pair]');
        const linksLoadForm = root.querySelector('[data-memory-links-load-form]');
        const linksIdInput = root.querySelector('[data-memory-links-id]');
        const linksResultsEl = root.querySelector('[data-memory-links-results]');
        const selectAllCheckbox = document.querySelector('[data-memory-select-all]');
        let activeLinksMemoryId = '';

        const memoryCheckboxes = () => Array.from(document.querySelectorAll('[data-memory-select]'));
        const selectedMemoryIds = () =>
          Array.from(document.querySelectorAll('[data-memory-select]:checked'))
            .map((checkbox) => checkbox.value.trim())
            .filter(Boolean);

        const setFeedback = (state, message) => {
          if (!feedbackEl) return;
          feedbackEl.textContent = message;
          feedbackEl.classList.remove('form-success', 'form-error', 'crm-notes');
          if (state === 'success') feedbackEl.classList.add('form-success');
          else if (state === 'error') feedbackEl.classList.add('form-error');
          else feedbackEl.classList.add('crm-notes');
        };

        const syncSelectionState = () => {
          const selectedIds = selectedMemoryIds();
          const selectedCount = selectedIds.length;

          if (selectedCountEl) {
            selectedCountEl.textContent = selectedCount + ' selected';
          }
          if (bulkDeleteBtn) {
            bulkDeleteBtn.disabled = selectedCount === 0;
          }
          if (bulkUpdateBtn) {
            bulkUpdateBtn.disabled = selectedCount === 0;
          }
          if (useSelectedPairBtn) {
            useSelectedPairBtn.disabled = selectedCount !== 2;
          }
          if (selectAllCheckbox) {
            const checkboxes = memoryCheckboxes();
            selectAllCheckbox.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
            selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
          }
        };

        const requestJson = async (url, method, body) => {
          const response = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
          });

          const raw = await response.text();
          let payload = {};
          if (raw) {
            try {
              payload = JSON.parse(raw);
            } catch {
              throw new Error('Received a non-JSON response from the admin API.');
            }
          }

          if (!response.ok) {
            const message = payload && typeof payload.error === 'string'
              ? payload.error
              : 'Request failed with status ' + response.status;
            throw new Error(message);
          }

          return payload;
        };

        const escapeForHtml = (value) => String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');

        const renderLinks = (memoryId, links) => {
          if (!linksResultsEl) return;

          if (!Array.isArray(links) || links.length === 0) {
            linksResultsEl.innerHTML =
              '<div class="crm-notes">No links found for <code>' + escapeForHtml(memoryId) + '</code>.</div>';
            return;
          }

          const rows = links.map((entry) => {
            const id1 = typeof entry.id1 === 'string' ? entry.id1 : '';
            const id2 = typeof entry.id2 === 'string' ? entry.id2 : '';
            const linkType = typeof entry.linkType === 'string' && entry.linkType.trim()
              ? entry.linkType.trim()
              : 'related';
            const peerId = id1 === memoryId ? id2 : id1;
            const createdAt = Number.isFinite(entry.createdAt)
              ? new Date(Number(entry.createdAt)).toLocaleString()
              : 'unknown';

            return '<tr>'
              + '<td><code>' + escapeForHtml(peerId || '(unknown)') + '</code></td>'
              + '<td>' + escapeForHtml(linkType) + '</td>'
              + '<td>' + escapeForHtml(createdAt) + '</td>'
              + '<td><button type="button" class="btn btn-danger" data-memory-unlink data-id1="' + escapeForHtml(id1) + '" data-id2="' + escapeForHtml(id2) + '" style="font-size:0.75rem;padding:0.25rem 0.5rem">unlink</button></td>'
              + '</tr>';
          }).join('');

          linksResultsEl.innerHTML =
            '<table><thead><tr><th>Linked memory</th><th>Link type</th><th>Created</th><th></th></tr></thead><tbody>'
            + rows
            + '</tbody></table>';
        };

        const loadLinks = async (memoryId) => {
          const normalizedId = (memoryId ?? '').trim();
          if (!normalizedId) {
            setFeedback('error', 'Enter a memory ID before loading links.');
            return;
          }
          activeLinksMemoryId = normalizedId;
          if (linksIdInput) linksIdInput.value = normalizedId;

          setFeedback('info', 'Loading links for ' + normalizedId + '...');
          const payload = await requestJson('/api/admin/memory/' + encodeURIComponent(normalizedId) + '/links', 'GET');
          const links = Array.isArray(payload.links) ? payload.links : [];
          renderLinks(normalizedId, links);
          if (links.length > 0) {
            setFeedback('success', 'Loaded ' + links.length + ' link(s) for ' + normalizedId + '.');
          } else {
            setFeedback('info', 'No links found for ' + normalizedId + '.');
          }
        };

        if (selectAllCheckbox) {
          selectAllCheckbox.addEventListener('change', () => {
            const checked = Boolean(selectAllCheckbox.checked);
            for (const checkbox of memoryCheckboxes()) {
              checkbox.checked = checked;
            }
            syncSelectionState();
          });
        }

        document.addEventListener('change', (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (!target.matches('[data-memory-select]')) return;
          syncSelectionState();
        });

        document.body.addEventListener('htmx:afterSwap', () => {
          syncSelectionState();
        });

        if (bulkDeleteBtn instanceof HTMLButtonElement) {
          bulkDeleteBtn.addEventListener('click', async () => {
            const ids = selectedMemoryIds();
            if (!ids.length) {
              setFeedback('error', 'Select at least one memory before running bulk delete.');
              return;
            }
            if (!window.confirm('Delete ' + ids.length + ' selected memory item(s)?')) return;

            bulkDeleteBtn.disabled = true;
            try {
              const payload = await requestJson('/api/admin/memory/bulk-delete', 'POST', { ids });
              const count = typeof payload.count === 'number' ? payload.count : 0;
              setFeedback('success', 'Deleted ' + count + ' memory item(s). Refreshing list...');
              window.setTimeout(() => window.location.reload(), 650);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setFeedback('error', 'Bulk delete failed: ' + message);
            } finally {
              syncSelectionState();
            }
          });
        }

        if (bulkUpdateBtn instanceof HTMLButtonElement) {
          bulkUpdateBtn.addEventListener('click', async () => {
            const ids = selectedMemoryIds();
            if (!ids.length) {
              setFeedback('error', 'Select at least one memory before running bulk update.');
              return;
            }

            const fields = {};
            const memoryType = bulkTypeSelect instanceof HTMLSelectElement ? bulkTypeSelect.value.trim() : '';
            const sensitivity = bulkSensitivitySelect instanceof HTMLSelectElement ? bulkSensitivitySelect.value.trim() : '';
            if (memoryType) fields.memoryType = memoryType;
            if (sensitivity) fields.sensitivity = sensitivity;

            if (Object.keys(fields).length === 0) {
              setFeedback('error', 'Choose a memory type and/or sensitivity value to apply.');
              return;
            }

            bulkUpdateBtn.disabled = true;
            try {
              const payload = await requestJson('/api/admin/memory/bulk-update', 'POST', { ids, fields });
              const count = typeof payload.count === 'number' ? payload.count : 0;
              setFeedback('success', 'Updated ' + count + ' memory item(s). Refreshing list...');
              window.setTimeout(() => window.location.reload(), 650);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setFeedback('error', 'Bulk update failed: ' + message);
            } finally {
              syncSelectionState();
            }
          });
        }

        if (useSelectedPairBtn instanceof HTMLButtonElement) {
          useSelectedPairBtn.addEventListener('click', () => {
            const ids = selectedMemoryIds();
            if (ids.length !== 2) {
              setFeedback('error', 'Select exactly two memories to prefill the link form.');
              return;
            }
            if (linkId1Input instanceof HTMLInputElement) linkId1Input.value = ids[0];
            if (linkId2Input instanceof HTMLInputElement) linkId2Input.value = ids[1];
            setFeedback('info', 'Prefilled link form from selected rows.');
          });
        }

        if (linkForm instanceof HTMLFormElement) {
          linkForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const id1 = linkId1Input instanceof HTMLInputElement ? linkId1Input.value.trim() : '';
            const id2 = linkId2Input instanceof HTMLInputElement ? linkId2Input.value.trim() : '';
            const linkType = linkTypeInput instanceof HTMLInputElement ? linkTypeInput.value.trim() : '';

            if (!id1 || !id2) {
              setFeedback('error', 'Both memory IDs are required to create a link.');
              return;
            }
            if (id1 === id2) {
              setFeedback('error', 'Linking requires two different memory IDs.');
              return;
            }

            try {
              const payload = {
                id1,
                id2,
              };
              if (linkType) payload.linkType = linkType;
              const result = await requestJson('/api/admin/memory/link', 'POST', payload);
              const createdLinkType = result && result.link && typeof result.link.linkType === 'string'
                ? result.link.linkType
                : (linkType || 'related');
              setFeedback('success', 'Linked ' + id1 + ' and ' + id2 + ' (type: ' + createdLinkType + ').');
              if (activeLinksMemoryId && (activeLinksMemoryId === id1 || activeLinksMemoryId === id2)) {
                await loadLinks(activeLinksMemoryId);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              setFeedback('error', 'Link creation failed: ' + message);
            }
          });
        }

        if (linksLoadForm instanceof HTMLFormElement) {
          linksLoadForm.addEventListener('submit', (event) => {
            event.preventDefault();
            const memoryId = linksIdInput instanceof HTMLInputElement ? linksIdInput.value : '';
            loadLinks(memoryId).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              setFeedback('error', 'Unable to load links: ' + message);
            });
          });
        }

        if (linksResultsEl) {
          linksResultsEl.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const button = target.closest('[data-memory-unlink]');
            if (!(button instanceof HTMLButtonElement)) return;

            const id1 = button.getAttribute('data-id1') ?? '';
            const id2 = button.getAttribute('data-id2') ?? '';
            if (!id1 || !id2) {
              setFeedback('error', 'Unlink failed: missing memory IDs in the selected link row.');
              return;
            }
            if (!window.confirm('Unlink ' + id1 + ' and ' + id2 + '?')) return;

            button.disabled = true;
            requestJson('/api/admin/memory/link', 'DELETE', { id1, id2 }).then(
              () => {
                setFeedback('success', 'Unlinked ' + id1 + ' and ' + id2 + '.');
                if (activeLinksMemoryId) {
                  return loadLinks(activeLinksMemoryId);
                }
                return undefined;
              },
              (error) => {
                const message = error instanceof Error ? error.message : String(error);
                setFeedback('error', 'Unlink failed: ' + message);
              },
            ).finally(() => {
              button.disabled = false;
            });
          });
        }

        syncSelectionState();
      })();
    </script>
  `;
}

function memoryActionPanel(): string {
  return `
    <div class="card" id="memory-admin-actions">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.75rem">
        <strong>Memory Actions</strong>
        <span class="crm-notes" data-memory-selected-count>0 selected</span>
      </div>

      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:0.9rem">
        <button type="button" class="btn btn-danger" data-memory-bulk-delete disabled>Delete selected</button>
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.8rem;color:var(--text-muted)">
          Set type
          <select data-memory-bulk-type style="min-width:9rem;padding:0.45rem;border:1px solid var(--border);border-radius:6px;background:#fff">
            <option value="">(no change)</option>
            ${renderOptionList(MEMORY_TYPE_OPTIONS)}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.8rem;color:var(--text-muted)">
          Set sensitivity
          <select data-memory-bulk-sensitivity style="min-width:9rem;padding:0.45rem;border:1px solid var(--border);border-radius:6px;background:#fff">
            <option value="">(no change)</option>
            ${renderOptionList(MEMORY_SENSITIVITY_OPTIONS)}
          </select>
        </label>
        <button type="button" class="btn" data-memory-bulk-update disabled>Apply update</button>
      </div>

      <form data-memory-link-form style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:0.9rem">
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.8rem;color:var(--text-muted)">
          Memory ID 1
          <input data-memory-link-id1 type="text" placeholder="mem-1" style="min-width:13rem;padding:0.45rem 0.6rem;border:1px solid var(--border);border-radius:6px">
        </label>
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.8rem;color:var(--text-muted)">
          Memory ID 2
          <input data-memory-link-id2 type="text" placeholder="mem-2" style="min-width:13rem;padding:0.45rem 0.6rem;border:1px solid var(--border);border-radius:6px">
        </label>
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.8rem;color:var(--text-muted)">
          Link type
          <input data-memory-link-type type="text" placeholder="related" style="min-width:8rem;padding:0.45rem 0.6rem;border:1px solid var(--border);border-radius:6px">
        </label>
        <button type="button" class="btn" data-memory-use-selected-pair disabled>Use selected pair</button>
        <button type="submit" class="btn">Create link</button>
      </form>

      <form data-memory-links-load-form style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:0.75rem">
        <label style="display:flex;flex-direction:column;gap:0.25rem;font-size:0.8rem;color:var(--text-muted)">
          Inspect links for memory
          <input data-memory-links-id type="text" placeholder="memory-id" style="min-width:13rem;padding:0.45rem 0.6rem;border:1px solid var(--border);border-radius:6px">
        </label>
        <button type="submit" class="btn">Load links</button>
      </form>

      <div class="crm-notes" data-memory-feedback role="status" aria-live="polite">
        Select memories to enable bulk actions, or enter IDs to manage links.
      </div>
      <div data-memory-links-results style="margin-top:0.6rem"></div>
    </div>
    ${memoryActionScript()}
  `;
}

export function memoryListPage(
  memories: PurrMemory[],
  contactById: ReadonlyMap<string, MemoryContactView> = new Map(),
  pagination: MemoryListPaginationView = {
    limit: 50,
    offset: 0,
    total: memories.length,
    hasPrevious: false,
    hasNext: false,
  },
): string {
  const searchForm = `
    <form class="search-form" hx-post="/api/memory/search" hx-target="#memory-results" hx-swap="innerHTML">
      <input type="text" name="query" placeholder="Search memories..." required>
      <button type="submit">Search</button>
    </form>`;
  const start = pagination.total > 0 ? pagination.offset + 1 : 0;
  const end = pagination.offset + memories.length;
  const previousOffset = Math.max(0, pagination.offset - pagination.limit);
  const nextOffset = pagination.offset + pagination.limit;
  const paginationControls = `
    <div class="search-form" style="margin-top:0.75rem;align-items:center;gap:0.75rem;flex-wrap:wrap">
      <form method="get" action="/memory" style="display:flex;gap:0.5rem;align-items:center">
        <label for="memory-limit">Limit</label>
        <input id="memory-limit" type="number" name="limit" min="1" max="200" value="${pagination.limit}" style="max-width:6rem">
        <input type="hidden" name="offset" value="0">
        <button type="submit">Apply</button>
      </form>
      <div class="crm-notes">Showing ${start}-${end} of ${pagination.total}</div>
      <div style="display:flex;gap:0.5rem">
        ${pagination.hasPrevious
    ? `<a class="btn" href="/memory?limit=${pagination.limit}&offset=${previousOffset}">&larr; Newer</a>`
    : '<span class="btn" style="pointer-events:none;opacity:0.5">&larr; Newer</span>'}
        ${pagination.hasNext
    ? `<a class="btn" href="/memory?limit=${pagination.limit}&offset=${nextOffset}">Older &rarr;</a>`
    : '<span class="btn" style="pointer-events:none;opacity:0.5">Older &rarr;</span>'}
      </div>
    </div>
  `;

  const tableBody = memories.length > 0
    ? memories.map(m => memoryRow(m, m.contactId ? contactById.get(m.contactId) : undefined)).join('')
    : '<tr><td colspan="8" class="empty">No memories found</td></tr>';

  return `
    ${searchForm}
    ${paginationControls}
    ${memoryActionPanel()}
    <div class="card">
      <table>
        <thead><tr>
          <th>
            <label style="display:flex;gap:0.45rem;align-items:center">
              <input type="checkbox" data-memory-select-all>
              <span>Type</span>
            </label>
          </th>
          <th>Text</th><th>Contact</th><th>Salience</th><th>Importance</th><th>Privacy</th><th>Extracted</th><th></th>
        </tr></thead>
        <tbody id="memory-results">${tableBody}</tbody>
      </table>
    </div>`;
}

export function memoryRow(m: PurrMemory, linkedContact?: MemoryContactView): string {
  const date = new Date(m.extractedAt).toLocaleDateString();
  const truncText = m.text.length > 120 ? escapeHtml(m.text.slice(0, 120)) + '...' : escapeHtml(m.text);
  return `<tr data-memory-type="${m.type}" data-memory-id="${escapeHtml(m.id)}">
    <td>
      <label style="display:flex;gap:0.45rem;align-items:center">
        <input type="checkbox" data-memory-select value="${escapeHtml(m.id)}" aria-label="Select memory ${escapeHtml(m.id)}">
        <span class="badge badge-${m.type}">${m.type}</span>
      </label>
    </td>
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
