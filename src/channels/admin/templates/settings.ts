import type { DiscoveredModel } from '../../../llm/discovery.js';
import type { SubstrateConfig } from '../../../types.js';
import type { EnvInfo } from '../types.js';
import { escapeHtml } from './shared.js';

export function settingsPage(config: SubstrateConfig, envInfo: EnvInfo, models?: DiscoveredModel[]): string {
  const modelOptions = models && models.length > 0
    ? models.map(m => m.id)
    : null;
  const retryMaxAttempts = config.retryMaxAttempts ?? 3;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 2000;

  function modelSelect(name: string, value: string): string {
    if (modelOptions) {
      const opts = modelOptions.map(id =>
        `<option value="${escapeHtml(id)}"${id === value ? ' selected' : ''}>${escapeHtml(id)}</option>`
      ).join('');
      // Include current value if not in list
      const hasValue = modelOptions.includes(value);
      const extra = hasValue ? '' : `<option value="${escapeHtml(value)}" selected>${escapeHtml(value)}</option>`;
      return `<select name="${name}">${extra}${opts}</select>`;
    }
    return `<input type="text" name="${name}" value="${escapeHtml(value)}">`;
  }

  function providerInput(name: string, value: string): string {
    return `<input type="text" name="${name}" value="${escapeHtml(value)}">`;
  }

  const secretKeys: Array<[string, string]> = [
    ['DISCORD_TOKEN', envInfo.discordToken],
    ['API_KEY', envInfo.apiKey],
    ['ADMIN_TOKEN', envInfo.adminToken],
    ['OPENROUTER_API_KEY', envInfo.openrouterApiKey],
    ['LITELLM_BASE_URL', envInfo.litellmBaseUrl],
    ['LITELLM_API_KEY', envInfo.litellmApiKey],
    ['OLLAMA_URL', envInfo.ollamaUrl],
  ];

  const secretsRowsHtml = secretKeys
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');

  return `
    <form hx-post="/api/settings" hx-target="#settings-result" hx-swap="innerHTML">
      <div class="card">
        <h3 style="margin-bottom:0.75rem">Models</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Primary Model</label>
            ${modelSelect('primaryModel', config.primaryModel)}
          </div>
          <div class="form-group">
            <label>Primary Provider</label>
            ${providerInput('primaryProvider', config.primaryProvider)}
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Extraction Model</label>
            ${modelSelect('extractionModel', config.extractionModel)}
          </div>
          <div class="form-group">
            <label>Extraction Provider</label>
            ${providerInput('extractionProvider', config.extractionProvider)}
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Token Limits</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Primary Max Tokens (256-65536)</label>
            <input type="number" name="primaryMaxTokens" value="${config.primaryMaxTokens}" min="256" max="65536">
          </div>
          <div class="form-group">
            <label>Extraction Max Tokens (256-65536)</label>
            <input type="number" name="extractionMaxTokens" value="${config.extractionMaxTokens}" min="256" max="65536">
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Memory</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Retrieval Limit (1-50)</label>
            <input type="number" name="memoryRetrievalLimit" value="${config.memoryRetrievalLimit}" min="1" max="50">
          </div>
          <div class="form-group">
            <label>Extraction Interval (1-50 messages)</label>
            <input type="number" name="extractionInterval" value="${config.extractionInterval}" min="1" max="50">
          </div>
        </div>
        <table class="config-table" style="margin-top:0.5rem">
          <tr><td>Salience Floor</td><td>${envInfo.salienceFloor}</td></tr>
          <tr><td>Maintenance Interval</td><td>${envInfo.maintenanceIntervalMs / 1000}s</td></tr>
        </table>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Sessions</h3>
        <div class="form-group">
          <label>Message Limit (5-200)</label>
          <input type="number" name="sessionMessageLimit" value="${config.sessionMessageLimit}" min="5" max="200">
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">LLM Retries</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Retry Attempts (0-10)</label>
            <input type="number" name="retryMaxAttempts" value="${retryMaxAttempts}" min="0" max="10">
          </div>
          <div class="form-group">
            <label>Base Delay Ms (500-30000)</label>
            <input type="number" name="retryBaseDelayMs" value="${retryBaseDelayMs}" min="500" max="30000">
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn">Save Settings</button>
        <span id="settings-result"></span>
      </div>
    </form>

    <div class="card" style="margin-top:1.5rem">
      <h3 style="margin-bottom:0.75rem">Secrets</h3>
      <table class="config-table">${secretsRowsHtml}</table>
    </div>`;
}

export function settingsFormResult(success: boolean, message: string): string {
  return success
    ? `<span class="form-success">${escapeHtml(message)}</span>`
    : `<span class="form-error">${escapeHtml(message)}</span>`;
}
