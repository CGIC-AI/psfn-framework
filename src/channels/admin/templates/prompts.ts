import type { PromptLayer, PromptHistoryEntry } from '../../../identity/prompt-types.js';
import { LAYER_TYPE_ORDER } from '../../../identity/prompt-types.js';
import type { PromptRegistryEntry, PromptRegistryHistoryEntry } from '../../../identity/prompt-registry.js';
import { escapeHtml } from './shared.js';

// ── Prompt Stack Templates ──

const LAYER_TYPE_COLORS: Record<string, string> = {
  base: '#C4A035',
  operator: '#8B4513',
  runtime: '#4A7C59',
  channel: '#4A5C8B',
  task: '#8B6914',
};

export function promptsPage(layers: PromptLayer[], prompts: PromptRegistryEntry[]): string {
  return `
    <p class="description" style="color:var(--text-muted);margin-bottom:1rem">The layered foundation that shapes Purrsephone's voice. Base &rarr; Operator &rarr; Runtime &rarr; Channel &rarr; Task.</p>

    ${promptRegistryFragment(prompts)}

    <h3 style="margin:1rem 0 0.75rem">Prompt Layers</h3>
    <div id="prompt-layers">
      ${promptLayersFragment(layers)}
    </div>`;
}

export function promptRegistryFragment(prompts: PromptRegistryEntry[]): string {
  if (prompts.length === 0) return '<div class="card"><p class="empty">No static prompt keys configured.</p></div>';

  const rows = [...prompts]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(prompt => `
      <tr>
        <td><a href="/prompts/static/${encodeURIComponent(prompt.key)}"><code>${escapeHtml(prompt.key)}</code></a></td>
        <td>${escapeHtml(prompt.description || 'No description')}</td>
        <td>${escapeHtml(prompt.consumers.join(', ') || 'n/a')}</td>
        <td>v${prompt.version}</td>
        <td>${escapeHtml(prompt.updatedBy)}</td>
        <td>${new Date(prompt.updatedAt).toLocaleDateString()}</td>
      </tr>
    `)
    .join('');

  return `
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Static Prompt Registry</h3>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Description</th>
            <th>Consumers</th>
            <th>Version</th>
            <th>Updated By</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

export function promptLayersFragment(layers: PromptLayer[]): string {
  if (layers.length === 0) return '<p class="empty">No prompt layers configured.</p>';

  // Sort by type order then priority
  const sorted = [...layers].sort((a, b) => {
    const typeOrder = (LAYER_TYPE_ORDER[a.type] ?? 99) - (LAYER_TYPE_ORDER[b.type] ?? 99);
    if (typeOrder !== 0) return typeOrder;
    return a.priority - b.priority;
  });

  const rows = sorted.map(layer => {
    const color = LAYER_TYPE_COLORS[layer.type] ?? '#666';
    const statusClass = layer.enabled ? 'form-success' : 'form-error';
    const status = layer.enabled ? 'ON' : 'OFF';
    return `
      <tr>
        <td><span class="badge" style="background:${color};color:white">${escapeHtml(layer.type)}</span></td>
        <td><a href="/prompts/${encodeURIComponent(layer.id)}">${escapeHtml(layer.name)}</a></td>
        <td><span class="${statusClass}">${status}</span></td>
        <td>${layer.priority}</td>
        <td>v${layer.version}</td>
        <td>${escapeHtml(layer.updatedBy)}</td>
        <td>${new Date(layer.updatedAt).toLocaleDateString()}</td>
        <td>
          <form hx-post="/api/prompts/toggle" hx-target="#prompt-layers" hx-swap="innerHTML" style="display:inline">
            <input type="hidden" name="layerId" value="${layer.id}">
            <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">${layer.enabled ? 'Disable' : 'Enable'}</button>
          </form>
        </td>
      </tr>`;
  }).join('');

  return `
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Name</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Version</th>
            <th>Updated By</th>
            <th>Date</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function computeNaiveLineDiff(oldContent: string, newContent: string): Array<{ kind: 'same' | 'remove' | 'add'; line: string }> {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const max = Math.max(oldLines.length, newLines.length);
  const rows: Array<{ kind: 'same' | 'remove' | 'add'; line: string }> = [];

  for (let i = 0; i < max; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) {
      rows.push({ kind: 'same', line: oldLine ?? '' });
      continue;
    }
    if (oldLine !== undefined) rows.push({ kind: 'remove', line: oldLine });
    if (newLine !== undefined) rows.push({ kind: 'add', line: newLine });
  }

  return rows;
}

export function promptDiffFragment(oldContent: string, newContent: string): string {
  if (oldContent === newContent) {
    return '<div class="form-success">No changes detected.</div>';
  }

  const rows = computeNaiveLineDiff(oldContent, newContent)
    .map(({ kind, line }) => {
      if (kind === 'add') {
        return `<div style="background:#E9F7EF;color:#1E5631;padding:0.1rem 0.35rem">+ ${escapeHtml(line)}</div>`;
      }
      if (kind === 'remove') {
        return `<div style="background:#FDEDEC;color:#7B241C;padding:0.1rem 0.35rem">- ${escapeHtml(line)}</div>`;
      }
      return `<div style="padding:0.1rem 0.35rem;color:var(--text-muted)">  ${escapeHtml(line)}</div>`;
    })
    .join('');

  return `
    <div class="card" style="margin-top:1rem">
      <h3 style="margin-bottom:0.5rem">Diff Preview</h3>
      <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem">
        Red lines will be removed. Green lines will be added.
      </div>
      <div style="font-family:monospace;font-size:0.85rem;border:1px solid var(--border);border-radius:6px;overflow:auto;max-height:320px">
        ${rows}
      </div>
    </div>`;
}

export function promptDetailPage(layer: PromptLayer, history: PromptHistoryEntry[]): string {
  const color = LAYER_TYPE_COLORS[layer.type] ?? '#666';

  const historyRows = [...history].reverse().slice(0, 20).map(h => `
    <tr>
      <td>v${h.version}</td>
      <td>${escapeHtml(h.updatedBy)}</td>
      <td>${new Date(h.timestamp).toLocaleString()}</td>
      <td>${escapeHtml(h.previousChecksum)}</td>
      <td>
        <form hx-post="/api/prompts/rollback" hx-target="#prompt-result" hx-swap="innerHTML" style="display:inline">
          <input type="hidden" name="layerId" value="${layer.id}">
          <input type="hidden" name="version" value="${h.version}">
          <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">Restore</button>
        </form>
      </td>
    </tr>
  `).join('');

  return `
    <p style="margin-bottom:1rem">
      <span class="badge" style="background:${color};color:white">${escapeHtml(layer.type)}</span>
      <span style="margin-left:0.5rem;font-size:0.85rem;color:var(--text-muted)">
        Version ${layer.version} &middot;
        Priority ${layer.priority} &middot;
        ${layer.enabled ? 'Enabled' : 'Disabled'} &middot;
        Checksum ${layer.checksum}
      </span>
    </p>
    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem">
      Updated ${new Date(layer.updatedAt).toLocaleString()} by ${escapeHtml(layer.updatedBy)}
      ${layer.channelType ? ` &middot; Channel: ${escapeHtml(layer.channelType)}` : ''}
      ${layer.taskKind ? ` &middot; Task: ${escapeHtml(layer.taskKind)}` : ''}
    </p>

    <div id="prompt-result"></div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Content</h3>
      <form hx-post="/api/prompts/update" hx-target="#prompt-result" hx-swap="innerHTML">
        <input type="hidden" name="layerId" value="${layer.id}">
        <textarea name="content" rows="20" style="width:100%;font-family:monospace;font-size:0.9rem;padding:0.5rem;border:1px solid var(--border);border-radius:4px;resize:vertical">${escapeHtml(layer.content)}</textarea>
        <div class="form-actions">
          <button type="submit" formaction="/api/prompts/diff" hx-post="/api/prompts/diff" hx-target="#prompt-diff-preview" hx-swap="innerHTML" class="btn">Preview Diff</button>
          <button type="submit" class="btn">Save Changes</button>
        </div>
      </form>
      <div id="prompt-diff-preview"></div>
    </div>

    ${history.length > 0 ? `
      <div class="card" style="margin-top:1rem">
        <h3 style="margin-bottom:0.75rem">Version History</h3>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Changed By</th>
              <th>Timestamp</th>
              <th>Previous Checksum</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>
    ` : ''}

    <p style="margin-top:1rem"><a href="/prompts">&larr; Back to Prompt Soil</a></p>`;
}

export function promptRegistryDetailPage(
  prompt: PromptRegistryEntry,
  history: PromptRegistryHistoryEntry[],
): string {
  const historyRows = [...history].reverse().slice(0, 20).map(h => `
    <tr>
      <td>v${h.version}</td>
      <td>${escapeHtml(h.updatedBy)}</td>
      <td>${new Date(h.timestamp).toLocaleString()}</td>
      <td>${escapeHtml(h.previousChecksum)}</td>
      <td><code>${escapeHtml(h.previousText.slice(0, 80))}${h.previousText.length > 80 ? '...' : ''}</code></td>
      <td>
        <form hx-post="/api/prompts/static/rollback" hx-target="#prompt-registry-result" hx-swap="innerHTML" style="display:inline">
          <input type="hidden" name="key" value="${escapeHtml(prompt.key)}">
          <input type="hidden" name="version" value="${h.version}">
          <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">Restore</button>
        </form>
      </td>
    </tr>
  `).join('');

  return `
    <p style="margin-bottom:1rem">
      <code style="font-size:1rem">${escapeHtml(prompt.key)}</code>
      <span style="margin-left:0.5rem;font-size:0.85rem;color:var(--text-muted)">
        Version ${prompt.version} &middot; Checksum ${prompt.checksum}
      </span>
    </p>
    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.4rem">
      ${escapeHtml(prompt.description || 'No description')}
    </p>
    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem">
      Updated ${new Date(prompt.updatedAt).toLocaleString()} by ${escapeHtml(prompt.updatedBy)}
      &middot; Consumers: ${escapeHtml(prompt.consumers.join(', ') || 'n/a')}
    </p>

    <div id="prompt-registry-result"></div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Prompt Text</h3>
      <form hx-post="/api/prompts/static/update" hx-target="#prompt-registry-result" hx-swap="innerHTML">
        <input type="hidden" name="key" value="${escapeHtml(prompt.key)}">
        <textarea name="content" rows="20" style="width:100%;font-family:monospace;font-size:0.9rem;padding:0.5rem;border:1px solid var(--border);border-radius:4px;resize:vertical">${escapeHtml(prompt.text)}</textarea>
        <div class="form-actions">
          <button type="submit" class="btn">Save Changes</button>
        </div>
      </form>
    </div>

    ${history.length > 0 ? `
      <div class="card" style="margin-top:1rem">
        <h3 style="margin-bottom:0.75rem">Version History</h3>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Changed By</th>
              <th>Timestamp</th>
              <th>Previous Checksum</th>
              <th>Previous Text</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${historyRows}</tbody>
        </table>
      </div>
    ` : ''}

    <p style="margin-top:1rem"><a href="/prompts">&larr; Back to Prompt Soil</a></p>`;
}
