import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import {
  resolveMemoryRetrievalBudgetPct,
  resolveSessionHistoryBudgetPct,
} from '../../../context-budget.js';
import { escapeHtml } from './shared.js';

export function identityImportResult(success: boolean, message: string): string {
  return success
    ? `<span class="form-success">${escapeHtml(message)}</span>`
    : `<span class="form-error">${escapeHtml(message)}</span>`;
}

export function identityPage(card: CharacterCardV2, config: SubstrateConfig): string {
  const d = card.data;
  const sessionBudgetPct = resolveSessionHistoryBudgetPct(config);
  const retrievalBudgetPct = resolveMemoryRetrievalBudgetPct(config);
  const maskedConfig: Record<string, string> = {
    'Primary Model': config.primaryModel,
    'Extraction Model': config.extractionModel,
    'Discord Bot ID': config.discordBotId,
    'Data Dir': config.dataDir,
    'Character Card Path': config.characterCardPath,
    'Session History Budget %': String(sessionBudgetPct),
    'Session Message Hard Override': config.sessionMessageLimit ? String(config.sessionMessageLimit) : 'auto',
    'Memory Retrieval Budget %': String(retrievalBudgetPct),
    'Memory Retrieval Hard Override': config.memoryRetrievalLimit ? String(config.memoryRetrievalLimit) : 'auto',
  };

  const configRows = Object.entries(maskedConfig)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

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
