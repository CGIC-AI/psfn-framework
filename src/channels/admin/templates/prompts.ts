import type { PromptLayer, PromptHistoryEntry } from '../../../identity/prompt-types.js';
import { LAYER_TYPE_ORDER, PROMPT_LAYER_ROLES } from '../../../identity/prompt-types.js';
import type { PromptRegistryEntry, PromptRegistryHistoryEntry } from '../../../identity/prompt-registry.js';
import { PROMPT_RUNTIME_MACRO_HINTS, PROMPT_RUNTIME_TOKEN_HINT } from '../../../identity/prompt-runtime.js';
import {
  STRUCTURED_PROMPT_FORMAT,
  STRUCTURED_PROMPT_SECTION_KEYS,
  STRUCTURED_PROMPT_SECTION_LABELS,
  decomposePromptContent,
  type StructuredPromptSectionKey,
} from '../prompt-structured-content.js';
import { escapeHtml } from './shared.js';

// ── Prompt Stack Templates ──

const LAYER_TYPE_COLORS: Record<string, string> = {
  base: '#C4A035',
  operator: '#8B4513',
  runtime: '#4A7C59',
  channel: '#4A5C8B',
  task: '#8B6914',
};

const STRUCTURED_PROMPT_SECTION_ROWS: Record<StructuredPromptSectionKey, number> = {
  description: 4,
  personality: 4,
  system_prompt: 7,
  post_history_instructions: 4,
  scenario: 4,
  mes_example: 7,
  first_mes: 4,
};

function promptMacroCatalogFragment(): string {
  const rows = PROMPT_RUNTIME_MACRO_HINTS.map(entry => `
    <tr>
      <td><code>${escapeHtml(entry.token)}</code></td>
      <td>${escapeHtml(entry.description)}</td>
      <td><code>${escapeHtml(entry.example)}</code></td>
    </tr>
  `).join('');

  return `
    <div class="card">
      <h3 style="margin-bottom:0.75rem">Macro Catalog</h3>
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.75rem 0">
        Prompt macros resolve at runtime when context is available.
      </p>
      <table>
        <thead>
          <tr>
            <th>Macro</th>
            <th>Meaning</th>
            <th>Example</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function promptMetadataFields(layer: PromptLayer): string {
  const roleOptions = [
    { value: '', label: 'Unset' },
    ...PROMPT_LAYER_ROLES.map(role => ({ value: role, label: role })),
  ].map(({ value, label }) => {
    const selected = (layer.role ?? '') === value ? ' selected' : '';
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
  }).join('');

  const identifierValue = escapeHtml(layer.identifier ?? '');
  const promptOrderValue = layer.promptOrder != null ? String(layer.promptOrder) : '';

  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0.75rem;margin-bottom:1rem">
      <label style="display:block">
        <span style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:0.35rem">Identifier</span>
        <input type="text" name="identifier" value="${identifierValue}" placeholder="main" style="width:100%">
      </label>
      <label style="display:block">
        <span style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:0.35rem">Role</span>
        <select name="role" style="width:100%">
          ${roleOptions}
        </select>
      </label>
      <label style="display:block">
        <span style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:0.35rem">Prompt Order</span>
        <input type="number" name="promptOrder" min="0" step="1" value="${escapeHtml(promptOrderValue)}" style="width:100%">
      </label>
    </div>`;
}

export function promptsPage(layers: PromptLayer[], prompts: PromptRegistryEntry[]): string {
  return `
    <p class="description" style="color:var(--text-muted);margin-bottom:1rem">The layered foundation that shapes Purrsephone's voice. Base &rarr; Operator &rarr; Runtime &rarr; Channel &rarr; Task.</p>

    ${promptMacroCatalogFragment()}

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
        <td><a href="/legacy/prompts/static/${encodeURIComponent(prompt.key)}"><code>${escapeHtml(prompt.key)}</code></a></td>
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
    const typeOrder = (LAYER_TYPE_ORDER[a.type]) - (LAYER_TYPE_ORDER[b.type]);
    if (typeOrder !== 0) return typeOrder;
    return a.priority - b.priority;
  });

  const isCardBackedFoundationLayer = (layer: PromptLayer): boolean =>
    layer.type === 'base' && (layer.identifier === 'main' || layer.name === 'Character Foundation');

  const rows = sorted.map(layer => {
    const color = LAYER_TYPE_COLORS[layer.type] ?? '#666';
    const statusClass = layer.enabled ? 'form-success' : 'form-error';
    const status = layer.enabled ? 'ON' : 'OFF';
    const actions = isCardBackedFoundationLayer(layer)
      ? '<span style="font-size:0.75rem;color:var(--text-muted)">Managed via Identity</span>'
      : `
          <form hx-post="/api/prompts/toggle" hx-target="#prompt-layers" hx-swap="innerHTML" style="display:inline">
            <input type="hidden" name="layerId" value="${layer.id}">
            <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">${layer.enabled ? 'Disable' : 'Enable'}</button>
          </form>
        `;
    return `
      <tr>
        <td><span class="badge" style="background:${color};color:white">${escapeHtml(layer.type)}</span></td>
        <td><a href="/legacy/prompts/${encodeURIComponent(layer.id)}">${escapeHtml(layer.name)}</a></td>
        <td><span class="${statusClass}">${status}</span></td>
        <td>${layer.priority}</td>
        <td>v${layer.version}</td>
        <td>${escapeHtml(layer.updatedBy)}</td>
        <td>${new Date(layer.updatedAt).toLocaleDateString()}</td>
        <td>${actions}</td>
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
    const oldLine = oldLines[i] as string | undefined;
    const newLine = newLines[i] as string | undefined;
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
  const parsedContent = decomposePromptContent(layer.content);
  const isCardBackedFoundationLayer =
    layer.type === 'base' && (layer.identifier === 'main' || layer.name === 'Character Foundation');

  const historyRows = [...history].reverse().slice(0, 20).map(h => `
    <tr>
      <td>v${h.version}</td>
      <td>${escapeHtml(h.updatedBy)}</td>
      <td>${new Date(h.timestamp).toLocaleString()}</td>
      <td>${escapeHtml(h.previousChecksum)}</td>
      <td>
        ${isCardBackedFoundationLayer
          ? '<span style="font-size:0.75rem;color:var(--text-muted)">Managed via Identity</span>'
          : `
            <form hx-post="/api/prompts/rollback" hx-target="#prompt-result" hx-swap="innerHTML" style="display:inline">
              <input type="hidden" name="layerId" value="${layer.id}">
              <input type="hidden" name="version" value="${h.version}">
              <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">Restore</button>
            </form>
          `}
      </td>
    </tr>
  `).join('');

  const parseWarnings = parsedContent.warnings.map(warning => `
    <div style="background:#FFF7DE;border:1px solid #E6CC7E;color:#6A4C00;border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:0.75rem">
      ${escapeHtml(warning)}
    </div>
  `).join('');

  const parseErrors = parsedContent.errors.length > 0
    ? `
      <div class="form-error" style="margin-bottom:0.5rem">
        Malformed structured prompt content detected. Fix the raw content below to restore structured editing.
      </div>
      <ul style="margin:0 0 0.75rem 1.25rem;color:var(--error);font-size:0.9rem">
        ${parsedContent.errors.map(err => `<li>${escapeHtml(err)}</li>`).join('')}
      </ul>
    `
    : '';

  const structuredFields = STRUCTURED_PROMPT_SECTION_KEYS.map(key => `
    <div style="margin-bottom:0.75rem">
      <label style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:0.35rem">${STRUCTURED_PROMPT_SECTION_LABELS[key]}</label>
      <textarea name="${key}" rows="${STRUCTURED_PROMPT_SECTION_ROWS[key]}" style="width:100%;font-family:monospace;font-size:0.9rem;padding:0.5rem;border:1px solid var(--border);border-radius:4px;resize:vertical">${escapeHtml(parsedContent.sections[key])}</textarea>
    </div>
  `).join('');

  const editorForm = isCardBackedFoundationLayer
    ? `
      <div style="background:rgba(77, 124, 15, 0.08);border:1px solid rgba(77, 124, 15, 0.25);border-radius:8px;padding:0.85rem 1rem;margin-bottom:1rem">
        <p style="margin:0 0 0.5rem 0;font-weight:600">Character Foundation is card-backed</p>
        <p style="margin:0 0 0.5rem 0;font-size:0.8rem;font-weight:600;color:var(--text-muted)">Managed via Identity</p>
        <p style="margin:0;font-size:0.9rem;color:var(--text-muted)">
          This layer is derived from the character card and cannot be edited or rolled back from Prompt Soil.
          Update companion identity fields on the <a href="/legacy/identity">Identity page</a>; imports and card edits will refresh this layer automatically.
        </p>
      </div>
      <pre style="margin:0;font-family:monospace;font-size:0.9rem;padding:0.75rem;border:1px solid var(--border);border-radius:6px;overflow:auto;white-space:pre-wrap">${escapeHtml(layer.content)}</pre>
    `
    : parsedContent.errors.length > 0
    ? `
      <form hx-post="/api/prompts/update" hx-target="#prompt-result" hx-swap="innerHTML">
        <input type="hidden" name="layerId" value="${layer.id}">
        ${promptMetadataFields(layer)}
        <textarea name="content" rows="20" style="width:100%;font-family:monospace;font-size:0.9rem;padding:0.5rem;border:1px solid var(--border);border-radius:4px;resize:vertical">${escapeHtml(layer.content)}</textarea>
        <div class="form-actions">
          <button type="submit" formaction="/api/prompts/diff" hx-post="/api/prompts/diff" hx-target="#prompt-diff-preview" hx-swap="innerHTML" class="btn">Preview Diff</button>
          <button type="submit" class="btn">Save Changes</button>
        </div>
      </form>
    `
    : `
      <form hx-post="/api/prompts/update" hx-target="#prompt-result" hx-swap="innerHTML">
        <input type="hidden" name="layerId" value="${layer.id}">
        <input type="hidden" name="prompt_format" value="${STRUCTURED_PROMPT_FORMAT}">
        ${promptMetadataFields(layer)}
        ${structuredFields}
        <div class="form-actions">
          <button type="submit" formaction="/api/prompts/diff" hx-post="/api/prompts/diff" hx-target="#prompt-diff-preview" hx-swap="innerHTML" class="btn">Preview Diff</button>
          <button type="submit" class="btn">Save Changes</button>
        </div>
      </form>
    `;

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
      &middot; Identifier: <code>${escapeHtml(layer.identifier ?? '(unset)')}</code>
      &middot; Role: <code>${escapeHtml(layer.role ?? '(unset)')}</code>
      &middot; Order: <code>${escapeHtml(String(layer.promptOrder ?? '(unset)'))}</code>
    </p>

    <div id="prompt-result"></div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Content</h3>
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.75rem 0">
        ${escapeHtml(PROMPT_RUNTIME_TOKEN_HINT)}
      </p>
      ${parseWarnings}
      ${parseErrors}
      ${editorForm}
      ${isCardBackedFoundationLayer ? '' : '<div id="prompt-diff-preview"></div>'}
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

    <p style="margin-top:1rem"><a href="/legacy/prompts">&larr; Back to Prompt Soil</a></p>`;
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
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.75rem 0">
        ${escapeHtml(PROMPT_RUNTIME_TOKEN_HINT)}
      </p>
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

    <p style="margin-top:1rem"><a href="/legacy/prompts">&larr; Back to Prompt Soil</a></p>`;
}
