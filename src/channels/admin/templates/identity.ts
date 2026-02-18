import type { CharacterCardV2 } from '../../../identity/types.js';
import type { SubstrateConfig } from '../../../types.js';
import { escapeHtml } from './shared.js';

export function identityPage(card: CharacterCardV2, config: SubstrateConfig): string {
  const d = card.data;
  const maskedConfig: Record<string, string> = {
    'Primary Model': config.primaryModel,
    'Extraction Model': config.extractionModel,
    'Discord Bot ID': config.discordBotId,
    'Data Dir': config.dataDir,
    'Session Limit': String(config.sessionMessageLimit),
    'Memory Retrieval Limit': String(config.memoryRetrievalLimit),
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
    </div>`;
}
