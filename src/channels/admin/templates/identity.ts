import type {
  CharacterCardHistoryEntry,
} from '../../../identity/card-versioning.js';
import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import {
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudgetPct,
} from '../../../context-budget.js';
import { escapeHtml } from './shared.js';

const CARD_DIFF_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'description', label: 'Description' },
  { key: 'personality', label: 'Personality' },
  { key: 'scenario', label: 'Scenario' },
  { key: 'first_mes', label: 'First Message' },
  { key: 'mes_example', label: 'Message Example' },
  { key: 'system_prompt', label: 'System Prompt' },
  { key: 'post_history_instructions', label: 'Post-History Instructions' },
  { key: 'tags', label: 'Tags' },
  { key: 'creator', label: 'Creator' },
  { key: 'creator_notes', label: 'Creator Notes' },
] as const;

type CardDiffFieldKey = (typeof CARD_DIFF_FIELDS)[number]['key'];

export interface IdentityPageOptions {
  version?: number;
  checksum?: string;
  history?: CharacterCardHistoryEntry[];
}

export interface IdentityCardDiffMeta {
  fromVersion: number;
  toVersion: number;
  updatedBy: string;
  timestamp: string;
  reason?: string;
}

function cardFieldValue(card: CharacterCardV2, key: CardDiffFieldKey): string {
  if (key === 'tags') return card.data.tags.join(', ');
  const value = card.data[key as keyof CharacterCardV2['data']];
  return typeof value === 'string' ? value : '';
}

export function identityImportResult(success: boolean, message: string): string {
  return success
    ? `<span class="form-success">${escapeHtml(message)}</span>`
    : `<span class="form-error">${escapeHtml(message)}</span>`;
}

export function identityCardVersionResult(success: boolean, message: string): string {
  return success
    ? `<div class="form-success">${escapeHtml(message)}</div>`
    : `<div class="form-error">${escapeHtml(message)}</div>`;
}

export function identityCardDiffFragment(
  previousCard: CharacterCardV2,
  nextCard: CharacterCardV2,
  meta: IdentityCardDiffMeta,
): string {
  const rows = CARD_DIFF_FIELDS.map(({ key, label }) => {
    const previous = cardFieldValue(previousCard, key);
    const next = cardFieldValue(nextCard, key);
    const changed = previous !== next;
    const cellStyle = changed
      ? 'background:#FFF9E6;border-color:#E8C766'
      : 'background:#FAFAF7;border-color:var(--border)';

    return `
      <tr>
        <td style="vertical-align:top;font-weight:600">${escapeHtml(label)}</td>
        <td style="vertical-align:top;border:1px solid var(--border);${cellStyle};padding:0.5rem">
          <div style="white-space:pre-wrap;font-family:monospace;font-size:0.85rem">${escapeHtml(previous)}</div>
        </td>
        <td style="vertical-align:top;border:1px solid var(--border);${cellStyle};padding:0.5rem">
          <div style="white-space:pre-wrap;font-family:monospace;font-size:0.85rem">${escapeHtml(next)}</div>
        </td>
      </tr>
    `;
  }).join('');

  const reasonSuffix = meta.reason ? ` &middot; ${escapeHtml(meta.reason)}` : '';

  return `
    <div class="card" style="margin-top:1rem">
      <h3 style="margin-bottom:0.5rem">Character Card Diff (v${meta.fromVersion} &rarr; v${meta.toVersion})</h3>
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.75rem 0">
        Updated ${new Date(meta.timestamp).toLocaleString()} by ${escapeHtml(meta.updatedBy)}${reasonSuffix}
      </p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Previous</th>
            <th>Next</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

export function identityPage(card: CharacterCardV2, config: SubstrateConfig, options: IdentityPageOptions = {}): string {
  const d = card.data;
  const sessionBudgetPct = resolveSessionHistoryBudgetPct(config);
  const retrievalBudgetPct = resolveMemoryRetrievalBudgetPct(config);
  const history = options.history ?? [];
  const historyRows = [...history].reverse().slice(0, 20).map(entry => `
    <tr>
      <td>v${entry.version} &rarr; v${entry.version + 1}</td>
      <td>${escapeHtml(entry.updatedBy)}</td>
      <td>${new Date(entry.timestamp).toLocaleString()}</td>
      <td><code>${escapeHtml(entry.previousChecksum)}</code></td>
      <td>
        <form hx-post="/api/identity/card/diff" hx-target="#identity-card-diff" hx-swap="innerHTML" style="display:inline">
          <input type="hidden" name="version" value="${entry.version}">
          <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">Diff</button>
        </form>
        <form hx-post="/api/identity/card/rollback" hx-target="#identity-card-result" hx-swap="innerHTML" style="display:inline;margin-left:0.35rem">
          <input type="hidden" name="version" value="${entry.version}">
          <button type="submit" class="btn" style="font-size:0.75rem;padding:0.25rem 0.5rem">Restore</button>
        </form>
      </td>
    </tr>
  `).join('');

  const configRows = Object.entries({
    'Primary Model': config.primaryModel,
    'Extraction Model': config.extractionModel,
    'Discord Bot ID': config.discordBotId,
    'Data Dir': config.dataDir,
    'Character Card Path': config.characterCardPath,
    'Session History Budget %': String(sessionBudgetPct),
    'Session Message Hard Override': config.sessionMessageLimit ? String(config.sessionMessageLimit) : 'auto',
    'Memory Retrieval Budget %': String(retrievalBudgetPct),
    'Memory Retrieval Hard Override': config.memoryRetrievalLimit ? String(config.memoryRetrievalLimit) : 'auto',
  })
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  const version = options.version ?? 1;
  const checksum = options.checksum;

  return `
    <div class="card">
      <h3 style="margin-bottom:0.75rem">${escapeHtml(d.name)}</h3>
      <table class="config-table">
        <tr><td>Creator</td><td>${escapeHtml(d.creator)}</td></tr>
        <tr><td>Tags</td><td>${d.tags.map(t => escapeHtml(t)).join(', ')}</td></tr>
      </table>
      <p style="margin-top:1rem;white-space:pre-wrap">${escapeHtml(d.personality.slice(0, 500))}${d.personality.length > 500 ? '...' : ''}</p>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Character Card Versioning</h3>
      <p style="font-size:0.85rem;color:var(--text-muted);margin:0 0 0.75rem 0">
        Current version: <strong>v${version}</strong>
        ${checksum ? ` &middot; Checksum: <code>${escapeHtml(checksum)}</code>` : ''}
      </p>
      <h4 style="margin:0 0 0.6rem 0">Card Version History</h4>
      <div id="identity-card-result"></div>
      ${history.length > 0 ? `
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
      ` : '<p class="empty">No card history yet.</p>'}
      <div id="identity-card-diff"></div>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Runtime Configuration</h3>
      <table class="config-table">${configRows}</table>
    </div>

    <div class="card">
      <h3 style="margin-bottom:0.75rem">Import Character Card</h3>
      <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
        Import from JSON, PNG, or CharX using a local filesystem path.
      </p>
      <form hx-post="/api/identity/import" hx-target="#identity-import-result" hx-swap="innerHTML">
        <div class="form-group">
          <label for="identity-import-path">Source Path</label>
          <input id="identity-import-path" name="path" type="text" placeholder="/path/to/character-card.png" required>
        </div>
        <div class="form-group">
          <label for="identity-import-target">Import Destination</label>
          <input
            id="identity-import-target"
            type="text"
            value="${escapeHtml(config.characterCardPath)}"
            readonly
            aria-readonly="true"
          >
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Import Character</button>
          <span id="identity-import-result"></span>
        </div>
      </form>
    </div>`;
}
