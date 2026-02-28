import type { DiscoveredModel } from '../../../llm/discovery.js';
import type {
  CapabilityTier,
  ImportProcessingRouteMode,
  ModelCatalogEntry,
  ModelRoleAssignments,
  SubstrateConfig,
} from '../../../types.js';
import type { ModelsRuntimeConfig } from '../../../config/models-config.js';
import type { SkillsRuntimeConfig } from '../../../config/skills-config.js';
import type { SchedulerRuntimeConfig } from '../../../config/scheduler-config.js';
import type { TrustPolicyConfig } from '../../../config/trust-policy-config.js';
import type { CapabilityTierConfig } from '../../../config/capability-tier-config.js';
import type { EnvInfo } from '../types.js';
import {
  MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT,
  MEMORY_RETRIEVAL_BUDGET_PCT_RANGE,
  MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM,
  MEMORY_RETRIEVAL_MAX_ITEMS,
  MEMORY_RETRIEVAL_MIN_ITEMS,
  MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR_DEFAULT,
  resolveMemoryRetrievalBudget,
  resolveSessionHistoryBudget,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
  SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE,
  SESSION_HISTORY_MAX_MESSAGES,
  SESSION_HISTORY_MIN_MESSAGES,
  SESSION_HISTORY_MIN_TOKENS_FLOOR_DEFAULT,
} from '../../../context-budget.js';
import { escapeHtml } from './shared.js';

const DEFAULT_ROLE_ASSIGNMENTS: ModelRoleAssignments = {
  chat: 'primary',
  background: 'extraction',
  extraction: 'extraction',
  summary: 'primary',
  reasoning: 'primary',
  longContext: 'primary',
  import_processing: 'extraction',
};

const CAPABILITY_TIERS: readonly CapabilityTier[] = [
  'nursery',
  'apprentice',
  'autonomous',
  'custom',
];

interface CatalogRowView {
  slotKey: string;
  model: string;
  provider: string;
  defaultMaxTokens: string;
  defaultContextWindow: string;
  defaultSessionHistoryMinTokens: string;
  defaultMemoryRetrievalMinTokens: string;
  overrideMaxTokens: string;
  overrideContextWindow: string;
  overrideSessionHistoryMinTokens: string;
  overrideMemoryRetrievalMinTokens: string;
}

export interface SettingsConfigEditors {
  models: ModelsRuntimeConfig;
  skills: SkillsRuntimeConfig;
  scheduler: SchedulerRuntimeConfig;
  trustPolicy: TrustPolicyConfig;
  capabilities: CapabilityTierConfig;
}

function jsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function toTextNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(Math.trunc(value))
    : '';
}

function formatInteger(value: number): string {
  return Math.trunc(value).toLocaleString('en-US');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function estimateCountFromBudget(
  tokenBudget: number,
  tokensPerItem: number,
  minCount: number,
  maxCount: number,
): number {
  const rough = Math.floor(tokenBudget / Math.max(1, tokensPerItem));
  return clamp(rough, minCount, maxCount);
}

function formatBudgetPreviewText(options: {
  hardLimit?: number;
  estimatedCount: number;
  tokenBudget: number;
  contextWindow: number;
  tokensPerItem: number;
  minCount: number;
  maxCount: number;
  noun: 'messages' | 'memories';
}): string {
  const budgetEstimatedCount = estimateCountFromBudget(
    options.tokenBudget,
    options.tokensPerItem,
    options.minCount,
    options.maxCount,
  );

  if (options.hardLimit !== undefined) {
    return `Hard override active: ${formatInteger(options.hardLimit)} ${options.noun}. Budget preview: ~${formatInteger(budgetEstimatedCount)} ${options.noun} (${formatInteger(options.tokenBudget)} tokens of ${formatInteger(options.contextWindow)}).`;
  }

  return `Auto budget: ~${formatInteger(options.estimatedCount)} ${options.noun} (${formatInteger(options.tokenBudget)} tokens of ${formatInteger(options.contextWindow)}).`;
}

function buildCatalogRows(config: SubstrateConfig): CatalogRowView[] {
  const catalog = config.modelCatalog && Object.keys(config.modelCatalog).length > 0
    ? config.modelCatalog
    : {
      primary: {
        model: config.primaryModel,
        provider: config.primaryProvider,
        defaults: {
          maxTokens: config.primaryMaxTokens,
          contextWindow: config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow,
        },
        overrides: {
          maxTokens: config.primaryMaxTokens,
        },
      },
      extraction: {
        model: config.extractionModel,
        provider: config.extractionProvider,
        defaults: {
          maxTokens: config.extractionMaxTokens,
        },
        overrides: {
          maxTokens: config.extractionMaxTokens,
        },
      },
    } satisfies Record<string, ModelCatalogEntry>;

  return Object.entries(catalog).map(([slotKey, entry]) => ({
    slotKey,
    model: entry.model,
    provider: entry.provider,
    defaultMaxTokens: toTextNumber(entry.defaults?.maxTokens),
    defaultContextWindow: toTextNumber(entry.defaults?.contextWindow),
    defaultSessionHistoryMinTokens: toTextNumber(entry.defaults?.contextBudget?.sessionHistoryMinTokens),
    defaultMemoryRetrievalMinTokens: toTextNumber(entry.defaults?.contextBudget?.memoryRetrievalMinTokens),
    overrideMaxTokens: toTextNumber(entry.overrides?.maxTokens),
    overrideContextWindow: toTextNumber(entry.overrides?.contextWindow),
    overrideSessionHistoryMinTokens: toTextNumber(entry.overrides?.contextBudget?.sessionHistoryMinTokens),
    overrideMemoryRetrievalMinTokens: toTextNumber(entry.overrides?.contextBudget?.memoryRetrievalMinTokens),
  }));
}

function buildRoleAssignments(config: SubstrateConfig): ModelRoleAssignments {
  const assignments = config.modelRoleAssignments ?? {};
  return {
    ...DEFAULT_ROLE_ASSIGNMENTS,
    ...assignments,
  };
}

function slotSelectOptions(models: DiscoveredModel[], selected: string): string {
  if (models.length === 0) return '';
  const ids = models.map(model => model.id);
  const hasSelected = ids.includes(selected);
  const fallback = hasSelected || !selected
    ? ''
    : `<option value="${escapeHtml(selected)}">${escapeHtml(selected)}</option>`;
  const options = ids
    .map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
    .join('');
  return `${fallback}${options}`;
}

function providerSelectOptions(models: DiscoveredModel[]): string {
  const providers = [...new Set(models.flatMap(model => model.providerHints ?? []))]
    .map(provider => provider.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return providers
    .map(provider => `<option value="${escapeHtml(provider)}">${escapeHtml(provider)}</option>`)
    .join('');
}

function renderCatalogRow(
  row: CatalogRowView,
  options: {
    providerListId: string;
    showProviderHintInput: boolean;
  },
): string {
  const providerListAttr = options.showProviderHintInput
    ? ''
    : ` list="${escapeHtml(options.providerListId)}"`;
  const providerHintStyle = options.showProviderHintInput
    ? 'display:block;margin-top:0.35rem;font-size:0.75rem'
    : 'display:none';
  return `
    <tr data-model-slot-row>
      <td><input type="text" data-slot-key value="${escapeHtml(row.slotKey)}" placeholder="primary"></td>
      <td>
        <input type="text" data-model-id value="${escapeHtml(row.model)}" placeholder="provider/model" list="settings-model-list">
      </td>
      <td>
        <input type="text" data-provider value="${escapeHtml(row.provider)}" placeholder="openrouter"${providerListAttr}>
        <input type="text" data-provider-hint-copy value="" readonly placeholder="provider hint" style="${providerHintStyle}">
      </td>
      <td><input type="number" data-default-max-tokens value="${escapeHtml(row.defaultMaxTokens)}" min="1" placeholder="metadata"></td>
      <td><input type="number" data-default-context-window value="${escapeHtml(row.defaultContextWindow)}" min="1" placeholder="metadata"></td>
      <td><input type="number" data-override-max-tokens value="${escapeHtml(row.overrideMaxTokens)}" min="1" placeholder="optional"></td>
      <td><input type="number" data-override-context-window value="${escapeHtml(row.overrideContextWindow)}" min="1" placeholder="optional"></td>
      <td>
        <button type="button" class="btn" data-remove-slot style="font-size:0.8rem">Remove</button>
        <input type="hidden" data-default-session-min-tokens value="${escapeHtml(row.defaultSessionHistoryMinTokens)}">
        <input type="hidden" data-default-memory-min-tokens value="${escapeHtml(row.defaultMemoryRetrievalMinTokens)}">
        <input type="hidden" data-override-session-min-tokens value="${escapeHtml(row.overrideSessionHistoryMinTokens)}">
        <input type="hidden" data-override-memory-min-tokens value="${escapeHtml(row.overrideMemoryRetrievalMinTokens)}">
      </td>
    </tr>`;
}

function renderRoleRows(assignments: ModelRoleAssignments): string {
  return Object.entries(assignments)
    .map(([purpose, slotKey]) => `
      <tr data-purpose-row>
        <td><input type="text" data-purpose value="${escapeHtml(purpose)}" placeholder="chat"></td>
        <td><select data-purpose-slot data-selected-slot="${escapeHtml(slotKey)}"></select></td>
        <td><button type="button" class="btn" data-remove-purpose style="font-size:0.8rem">Remove</button></td>
      </tr>
    `)
    .join('');
}

function renderCapabilityTierOptions(selected: CapabilityTier): string {
  return CAPABILITY_TIERS.map((tier) => (
    `<option value="${escapeHtml(tier)}"${tier === selected ? ' selected' : ''}>${escapeHtml(tier)}</option>`
  )).join('');
}

function renderImportRouteModeOptions(selected: ImportProcessingRouteMode): string {
  const options: Array<{ value: ImportProcessingRouteMode; label: string }> = [
    { value: 'background', label: 'Background Routing (default)' },
    { value: 'openrouter_zdr', label: 'OpenRouter ZDR-only' },
    { value: 'local_endpoint', label: 'Local Endpoint Only' },
  ];
  return options.map((option) => (
    `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
  )).join('');
}

function renderJsonConfigEditor(options: {
  title: string;
  fileName: string;
  description: string;
  action: string;
  resultId: string;
  config: unknown;
  rows?: number;
}): string {
  const rows = options.rows ?? 16;
  return `
    <div class="card" style="margin-top:1.5rem">
      <h3 style="margin-bottom:0.5rem">${escapeHtml(options.title)}</h3>
      <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
        ${escapeHtml(options.description)}
      </p>
      <form hx-post="${escapeHtml(options.action)}" hx-target="#${escapeHtml(options.resultId)}" hx-swap="innerHTML">
        <textarea
          name="configJson"
          rows="${rows}"
          style="width:100%;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
        >${escapeHtml(JSON.stringify(options.config, null, 2))}</textarea>
        <div class="form-actions" style="margin-top:0.75rem">
          <button type="submit" class="btn">Save ${escapeHtml(options.fileName)}</button>
          <span id="${escapeHtml(options.resultId)}"></span>
        </div>
      </form>
    </div>
  `;
}

export function settingsPage(
  config: SubstrateConfig,
  envInfo: EnvInfo,
  configEditors: SettingsConfigEditors,
  models?: DiscoveredModel[],
): string {
  const availableModels = models ?? [];
  const catalogRows = buildCatalogRows(config);
  const roleAssignments = buildRoleAssignments(config);
  const sessionBudget = resolveSessionHistoryBudget(config);
  const retrievalBudget = resolveMemoryRetrievalBudget(config);
  const sessionBudgetPreviewText = formatBudgetPreviewText({
    hardLimit: sessionBudget.hardLimit,
    estimatedCount: sessionBudget.estimatedCount,
    tokenBudget: sessionBudget.tokenBudget,
    contextWindow: sessionBudget.contextWindow,
    tokensPerItem: SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE,
    minCount: SESSION_HISTORY_MIN_MESSAGES,
    maxCount: SESSION_HISTORY_MAX_MESSAGES,
    noun: 'messages',
  });
  const retrievalBudgetPreviewText = formatBudgetPreviewText({
    hardLimit: retrievalBudget.hardLimit,
    estimatedCount: retrievalBudget.estimatedCount,
    tokenBudget: retrievalBudget.tokenBudget,
    contextWindow: retrievalBudget.contextWindow,
    tokensPerItem: MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM,
    minCount: MEMORY_RETRIEVAL_MIN_ITEMS,
    maxCount: MEMORY_RETRIEVAL_MAX_ITEMS,
    noun: 'memories',
  });
  const retryMaxAttempts = config.retryMaxAttempts ?? 3;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 2000;
  const importRouteMode = config.importProcessingRouteMode ?? 'background';
  const importStrictPolicyEnabled = config.importProcessingStrictPolicy ?? false;
  const openRouterProviderOrderText = (config.openRouterProviderOrder ?? []).join(', ');
  const importLocalEndpointUrl = config.importProcessingLocalEndpointUrl ?? '';
  const importLocalModel = config.importProcessingLocalModel ?? '';
  const webFetchDomainAllowlistText = (config.webFetchDomainAllowlist ?? []).join(', ');
  const webFetchLocalCrawlerHostAllowlistText = (config.webFetchLocalCrawlerHostAllowlist ?? []).join(', ');
  const webFetchLocalCrawlerDomainAllowlistText = (config.webFetchLocalCrawlerDomainAllowlist ?? []).join(', ');
  const webFetchTlsCaCertPathsText = (config.webFetchTlsCaCertPaths ?? []).join(', ');

  const secretKeys: Array<[string, string]> = [
    ['DISCORD_TOKEN', envInfo.discordToken],
    ['API_KEY', envInfo.apiKey],
    ['ADMIN_TOKEN', envInfo.adminToken],
    ['OPENROUTER_API_KEY', envInfo.openrouterApiKey],
    ['LITELLM_BASE_URL', envInfo.litellmBaseUrl],
    ['LITELLM_API_KEY', envInfo.litellmApiKey],
    ['OLLAMA_URL', envInfo.ollamaUrl],
    ['IMPORT_PROCESSING_LOCAL_API_KEY', envInfo.importProcessingLocalApiKey],
  ];

  const secretsRowsHtml = secretKeys
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join('');

  const discoveryMeta = Object.fromEntries(availableModels.map(model => [
    model.id,
    {
      contextLength: model.contextLength,
      maxCompletionTokens: model.maxCompletionTokens,
      description: model.description,
      providerHints: model.providerHints ?? [],
      pricing: model.pricing,
    },
  ]));
  const providerListId = 'settings-provider-list';
  const providerOptionsHtml = providerSelectOptions(availableModels);
  const showProviderHintInput = providerOptionsHtml.length === 0;

  return `
    <form hx-post="/api/settings" hx-target="#settings-result" hx-swap="innerHTML" data-settings-form>
      <input type="hidden" name="primaryModel" value="${escapeHtml(config.primaryModel)}" data-legacy-primary-model>
      <input type="hidden" name="primaryProvider" value="${escapeHtml(config.primaryProvider)}" data-legacy-primary-provider>
      <input type="hidden" name="primaryMaxTokens" value="${escapeHtml(String(config.primaryMaxTokens))}" data-legacy-primary-max>
      <input type="hidden" name="extractionModel" value="${escapeHtml(config.extractionModel)}" data-legacy-extraction-model>
      <input type="hidden" name="extractionProvider" value="${escapeHtml(config.extractionProvider)}" data-legacy-extraction-provider>
      <input type="hidden" name="extractionMaxTokens" value="${escapeHtml(String(config.extractionMaxTokens))}" data-legacy-extraction-max>
      <input type="hidden" name="modelCatalogJson" value="" data-model-catalog-json>
      <input type="hidden" name="modelRoleAssignmentsJson" value="" data-model-role-assignments-json>

      <section data-settings-roster>
        <div class="card">
          <h3 style="margin-bottom:0.75rem">Model Catalog (Roster v2)</h3>
          <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
            Define reusable model slots, then map purposes to slots below. Discovery metadata auto-fills defaults for context/token values; override fields always win.
          </p>
          <div style="overflow-x:auto">
            <datalist id="settings-model-list">${slotSelectOptions(availableModels, '')}</datalist>
            <datalist id="${escapeHtml(providerListId)}">${providerOptionsHtml}</datalist>
            <table class="config-table" style="margin-bottom:0.75rem;min-width:980px">
              <thead>
                <tr>
                  <th>Slot Key</th>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Default Max Tokens</th>
                  <th>Default Context Window</th>
                  <th>Override Max Tokens</th>
                  <th>Override Context Window</th>
                  <th></th>
                </tr>
              </thead>
              <tbody data-model-catalog-body>
                ${catalogRows.map(row => renderCatalogRow(row, {
                  providerListId,
                  showProviderHintInput,
                })).join('')}
              </tbody>
            </table>
          </div>
          <div class="form-actions" style="margin-top:0">
            <button type="button" class="btn" data-add-slot>Add Slot</button>
          </div>
        </div>

        <div class="card">
          <h3 style="margin-bottom:0.75rem">Purpose Mappings</h3>
          <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
            Map each runtime purpose to a slot key. Defaults include chat/background plus completion purposes (extraction/summary/reasoning).
          </p>
          <table class="config-table">
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Slot</th>
                <th></th>
              </tr>
            </thead>
            <tbody data-role-assignments-body>
              ${renderRoleRows(roleAssignments)}
            </tbody>
          </table>
          <div class="form-actions" style="margin-top:0.75rem">
            <button type="button" class="btn" data-add-purpose>Add Purpose Mapping</button>
          </div>
        </div>

        <div class="card">
          <h3 style="margin-bottom:0.75rem">Legacy Compatibility Aliases</h3>
          <div class="form-row">
            <div class="form-group">
              <label>Primary Alias (chat)</label>
              <input type="text" data-alias-primary-model value="${escapeHtml(config.primaryModel)}" readonly>
            </div>
            <div class="form-group">
              <label>Extraction Alias (extraction/background)</label>
              <input type="text" data-alias-extraction-model value="${escapeHtml(config.extractionModel)}" readonly>
            </div>
          </div>
        </div>
      </section>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Memory</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Retrieval Budget % (${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min}-${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max})</label>
            <input type="number" name="memoryRetrievalBudgetPct" value="${retrievalBudget.budgetPct}" min="${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min}" max="${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max}">
            <p class="note" style="margin:0.4rem 0 0 0" data-memory-budget-preview>${escapeHtml(retrievalBudgetPreviewText)}</p>
          </div>
          <div class="form-group">
            <label>Retrieval Hard Override (optional, 1-50)</label>
            <input type="number" name="memoryRetrievalLimit" value="${toTextNumber(config.memoryRetrievalLimit)}" min="1" max="50" placeholder="auto">
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
        <div class="form-row">
          <div class="form-group">
            <label>History Budget % (${SESSION_HISTORY_BUDGET_PCT_RANGE.min}-${SESSION_HISTORY_BUDGET_PCT_RANGE.max})</label>
            <input type="number" name="sessionHistoryBudgetPct" value="${sessionBudget.budgetPct}" min="${SESSION_HISTORY_BUDGET_PCT_RANGE.min}" max="${SESSION_HISTORY_BUDGET_PCT_RANGE.max}">
            <p class="note" style="margin:0.4rem 0 0 0" data-session-budget-preview>${escapeHtml(sessionBudgetPreviewText)}</p>
          </div>
          <div class="form-group">
            <label>Message Hard Override (optional, 5-200)</label>
            <input type="number" name="sessionMessageLimit" value="${toTextNumber(config.sessionMessageLimit)}" min="5" max="200" placeholder="auto">
          </div>
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

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Sensitive Import Processing</h3>
        <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
          Configure the dedicated route for sensitive import jobs. Strict policy rejects non-ZDR routes at runtime.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label>Import Route Mode</label>
            <select name="importProcessingRouteMode">
              ${renderImportRouteModeOptions(importRouteMode)}
            </select>
          </div>
          <div class="form-group">
            <label>Strict Policy</label>
            <select name="importProcessingStrictPolicy">
              <option value="false"${!importStrictPolicyEnabled ? ' selected' : ''}>Disabled</option>
              <option value="true"${importStrictPolicyEnabled ? ' selected' : ''}>Enabled (ZDR required)</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>OpenRouter Provider Preference Order (comma-separated)</label>
            <input
              type="text"
              name="openRouterProviderOrder"
              value="${escapeHtml(openRouterProviderOrderText)}"
              placeholder="parasail, openai, anthropic"
            >
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Local Endpoint URL (llama.cpp / Ollama OpenAI-compatible)</label>
            <input
              type="text"
              name="importProcessingLocalEndpointUrl"
              value="${escapeHtml(importLocalEndpointUrl)}"
              placeholder="http://localhost:11434/v1"
            >
          </div>
          <div class="form-group">
            <label>Local Endpoint Model</label>
            <input
              type="text"
              name="importProcessingLocalModel"
              value="${escapeHtml(importLocalModel)}"
              placeholder="llama3.2:latest"
            >
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Gateway Web Fetch Policy</h3>
        <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
          Default lane stays strict (HTTPS + SSRF protections). Local crawler lane is opt-in and requires host/domain allowlist.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label>Default Lane: Allow HTTP</label>
            <select name="webFetchAllowHttp">
              <option value="false"${config.webFetchAllowHttp ? '' : ' selected'}>Disabled (HTTPS only)</option>
              <option value="true"${config.webFetchAllowHttp ? ' selected' : ''}>Enabled</option>
            </select>
          </div>
          <div class="form-group">
            <label>Default Lane Domain Allowlist (comma-separated)</label>
            <input
              type="text"
              name="webFetchDomainAllowlist"
              value="${escapeHtml(webFetchDomainAllowlistText)}"
              placeholder="example.com, docs.crawl4ai.com"
            >
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Local Crawler Lane Enabled</label>
            <select name="webFetchLocalCrawlerEnabled">
              <option value="false"${config.webFetchLocalCrawlerEnabled ? '' : ' selected'}>Disabled</option>
              <option value="true"${config.webFetchLocalCrawlerEnabled ? ' selected' : ''}>Enabled</option>
            </select>
          </div>
          <div class="form-group">
            <label>Local Crawler Lane: Allow HTTP</label>
            <select name="webFetchLocalCrawlerAllowHttp">
              <option value="false"${config.webFetchLocalCrawlerAllowHttp ? '' : ' selected'}>Disabled</option>
              <option value="true"${config.webFetchLocalCrawlerAllowHttp ? ' selected' : ''}>Enabled</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Local Crawler Host Allowlist (comma-separated)</label>
            <input
              type="text"
              name="webFetchLocalCrawlerHostAllowlist"
              value="${escapeHtml(webFetchLocalCrawlerHostAllowlistText)}"
              placeholder="localhost, 127.0.0.1, crawler.local"
            >
          </div>
          <div class="form-group">
            <label>Local Crawler Domain Allowlist (comma-separated)</label>
            <input
              type="text"
              name="webFetchLocalCrawlerDomainAllowlist"
              value="${escapeHtml(webFetchLocalCrawlerDomainAllowlistText)}"
              placeholder="internal.example, local"
            >
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>TLS CA Cert Paths (comma-separated)</label>
            <input
              type="text"
              name="webFetchTlsCaCertPaths"
              value="${escapeHtml(webFetchTlsCaCertPathsText)}"
              placeholder="/etc/ssl/local-root.pem,/etc/ssl/local-intermediate.pem"
            >
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Mixture of Agents (MoA)</h3>
        <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
          When enabled, queries are sent to multiple reference models in parallel, then an aggregator model synthesizes their outputs into a final response.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label>Enabled</label>
            <select name="moaEnabled">
              <option value="false"${config.moaEnabled ? '' : ' selected'}>Disabled</option>
              <option value="true"${config.moaEnabled ? ' selected' : ''}>Enabled</option>
            </select>
          </div>
          <div class="form-group">
            <label>Aggregator Model</label>
            <input type="text" name="moaAggregatorModel" value="${escapeHtml(config.moaAggregatorModel ?? '')}" placeholder="e.g. openai/gpt-4.1" list="settings-model-list">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group" style="flex:2">
            <label>Reference Models (comma-separated model IDs)</label>
            <input type="text" name="moaReferenceModels" value="${escapeHtml((config.moaReferenceModels ?? []).join(', '))}" placeholder="e.g. openai/gpt-4.1, z-ai/glm-5, deepseek/deepseek-v3.2">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Max Rounds (1-10)</label>
            <input type="number" name="moaMaxRounds" value="${toTextNumber(config.moaMaxRounds)}" min="1" max="10" placeholder="1">
          </div>
          <div class="form-group">
            <label>Max Tokens Per Round (256-1,000,000)</label>
            <input type="number" name="moaMaxTokensPerRound" value="${toTextNumber(config.moaMaxTokensPerRound)}" min="256" max="1000000" placeholder="4096">
          </div>
          <div class="form-group">
            <label>Timeout Per Round (ms, 5000-600,000)</label>
            <input type="number" name="moaTimeoutMs" value="${toTextNumber(config.moaTimeoutMs)}" min="5000" max="600000" placeholder="30000">
          </div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:0.75rem">Capability Tier</h3>
        <p class="note" style="margin:0 0 0.75rem 0;line-height:1.4">
          Controls which capability tokens are granted at runtime. Save Settings applies tier changes immediately.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label>Active Tier</label>
            <select name="capabilityTier">
              ${renderCapabilityTierOptions(configEditors.capabilities.tier)}
            </select>
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
    </div>

    ${renderJsonConfigEditor({
      title: 'Models JSON (models.json)',
      fileName: 'models.json',
      description: 'Raw model roster config. Prefer the roster UI above for guided editing; this is advanced mode.',
      action: '/api/settings/models',
      resultId: 'models-config-result',
      config: configEditors.models,
      rows: 20,
    })}

    ${renderJsonConfigEditor({
      title: 'Skills JSON (skills.json)',
      fileName: 'skills.json',
      description: 'Controls skill directories, load budgets, and disabled skill IDs.',
      action: '/api/settings/skills',
      resultId: 'skills-config-result',
      config: configEditors.skills,
      rows: 14,
    })}

    ${renderJsonConfigEditor({
      title: 'Scheduler JSON (scheduler.json)',
      fileName: 'scheduler.json',
      description: 'Controls scheduler tick cadence, heartbeat cadence, and salience decay interval.',
      action: '/api/settings/scheduler',
      resultId: 'scheduler-config-result',
      config: configEditors.scheduler,
      rows: 12,
    })}

    ${renderJsonConfigEditor({
      title: 'Trust Policy JSON (trust-policy.json)',
      fileName: 'trust-policy.json',
      description: 'Defines trust ceilings, visibility caps, channel classification rules, and visibility overrides (exact + prefix).',
      action: '/api/settings/trust-policy',
      resultId: 'trust-policy-config-result',
      config: configEditors.trustPolicy,
      rows: 20,
    })}

    ${renderJsonConfigEditor({
      title: 'Capability Tier JSON (capability-tier.json)',
      fileName: 'capability-tier.json',
      description: 'Defines active capability tier and custom token grants for tier "custom".',
      action: '/api/settings/capabilities',
      resultId: 'capability-tier-config-result',
      config: configEditors.capabilities,
      rows: 12,
    })}

    <script type="application/json" data-settings-model-meta>${escapeHtml(jsonScript(discoveryMeta))}</script>
    <template data-model-slot-template>
      <tr data-model-slot-row>
        <td><input type="text" data-slot-key placeholder="new-slot"></td>
        <td>
          <input type="text" data-model-id placeholder="provider/model" list="settings-model-list">
        </td>
        <td>
          <input type="text" data-provider placeholder="openrouter"${showProviderHintInput ? '' : ` list="${escapeHtml(providerListId)}"`}>
          <input type="text" data-provider-hint-copy value="" readonly placeholder="provider hint" style="${showProviderHintInput ? 'display:block;margin-top:0.35rem;font-size:0.75rem' : 'display:none'}">
        </td>
        <td><input type="number" data-default-max-tokens min="1" placeholder="metadata"></td>
        <td><input type="number" data-default-context-window min="1" placeholder="metadata"></td>
        <td><input type="number" data-override-max-tokens min="1" placeholder="optional"></td>
        <td><input type="number" data-override-context-window min="1" placeholder="optional"></td>
        <td>
          <button type="button" class="btn" data-remove-slot style="font-size:0.8rem">Remove</button>
          <input type="hidden" data-default-session-min-tokens value="">
          <input type="hidden" data-default-memory-min-tokens value="">
          <input type="hidden" data-override-session-min-tokens value="">
          <input type="hidden" data-override-memory-min-tokens value="">
        </td>
      </tr>
    </template>
    <template data-purpose-template>
      <tr data-purpose-row>
        <td><input type="text" data-purpose placeholder="new-purpose"></td>
        <td><select data-purpose-slot></select></td>
        <td><button type="button" class="btn" data-remove-purpose style="font-size:0.8rem">Remove</button></td>
      </tr>
    </template>

    <script>
      (() => {
        const form = document.querySelector('[data-settings-form]');
        const roster = document.querySelector('[data-settings-roster]');
        if (!form || !roster) return;

        const catalogBody = roster.querySelector('[data-model-catalog-body]');
        const assignmentsBody = roster.querySelector('[data-role-assignments-body]');
        const modelSlotTemplate = document.querySelector('template[data-model-slot-template]');
        const purposeTemplate = document.querySelector('template[data-purpose-template]');
        const modelMetaScript = document.querySelector('[data-settings-model-meta]');
        const addSlotButton = roster.querySelector('[data-add-slot]');
        const addPurposeButton = roster.querySelector('[data-add-purpose]');
        const resultNode = document.querySelector('#settings-result');

        const hiddenCatalog = form.querySelector('input[data-model-catalog-json]');
        const hiddenAssignments = form.querySelector('input[data-model-role-assignments-json]');
        const legacyPrimaryModel = form.querySelector('input[data-legacy-primary-model]');
        const legacyPrimaryProvider = form.querySelector('input[data-legacy-primary-provider]');
        const legacyPrimaryMax = form.querySelector('input[data-legacy-primary-max]');
        const legacyExtractionModel = form.querySelector('input[data-legacy-extraction-model]');
        const legacyExtractionProvider = form.querySelector('input[data-legacy-extraction-provider]');
        const legacyExtractionMax = form.querySelector('input[data-legacy-extraction-max]');
        const aliasPrimary = form.querySelector('input[data-alias-primary-model]');
        const aliasExtraction = form.querySelector('input[data-alias-extraction-model]');
        const sessionBudgetInput = form.querySelector('input[name="sessionHistoryBudgetPct"]');
        const sessionHardLimitInput = form.querySelector('input[name="sessionMessageLimit"]');
        const memoryBudgetInput = form.querySelector('input[name="memoryRetrievalBudgetPct"]');
        const memoryHardLimitInput = form.querySelector('input[name="memoryRetrievalLimit"]');
        const sessionBudgetPreview = form.querySelector('[data-session-budget-preview]');
        const memoryBudgetPreview = form.querySelector('[data-memory-budget-preview]');

        if (!catalogBody || !assignmentsBody || !modelSlotTemplate || !purposeTemplate || !hiddenCatalog || !hiddenAssignments
          || !legacyPrimaryModel || !legacyPrimaryProvider || !legacyPrimaryMax || !legacyExtractionModel
          || !legacyExtractionProvider || !legacyExtractionMax) {
          return;
        }

        let modelMeta = {};
        try {
          modelMeta = JSON.parse(modelMetaScript?.textContent || '{}');
        } catch {
          modelMeta = {};
        }
        const providerDatalistAvailable = ${showProviderHintInput ? 'false' : 'true'};

        const DEFAULT_CONTEXT_WINDOW = ${config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow};
        const DEFAULT_SESSION_BUDGET_PCT = ${config.sessionHistoryBudgetPct ?? SESSION_HISTORY_BUDGET_PCT_DEFAULT};
        const DEFAULT_MEMORY_BUDGET_PCT = ${config.memoryRetrievalBudgetPct ?? MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT};
        const DEFAULT_SESSION_MIN_TOKEN_FLOOR = ${config.modelRoster.chat?.contextBudget?.sessionHistoryMinTokens ?? SESSION_HISTORY_MIN_TOKENS_FLOOR_DEFAULT};
        const DEFAULT_MEMORY_MIN_TOKEN_FLOOR = ${config.modelRoster.chat?.contextBudget?.memoryRetrievalMinTokens ?? MEMORY_RETRIEVAL_MIN_TOKENS_FLOOR_DEFAULT};
        const SESSION_BUDGET_RANGE = { min: ${SESSION_HISTORY_BUDGET_PCT_RANGE.min}, max: ${SESSION_HISTORY_BUDGET_PCT_RANGE.max} };
        const MEMORY_BUDGET_RANGE = { min: ${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min}, max: ${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max} };
        const SESSION_TOKENS_PER_MESSAGE = ${SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE};
        const MEMORY_TOKENS_PER_ITEM = ${MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM};
        const SESSION_MIN_COUNT = ${SESSION_HISTORY_MIN_MESSAGES};
        const SESSION_MAX_COUNT = ${SESSION_HISTORY_MAX_MESSAGES};
        const MEMORY_MIN_COUNT = ${MEMORY_RETRIEVAL_MIN_ITEMS};
        const MEMORY_MAX_COUNT = ${MEMORY_RETRIEVAL_MAX_ITEMS};

        const toPositiveInt = (raw) => {
          const parsed = Number.parseInt(String(raw || '').trim(), 10);
          if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
          return parsed;
        };

        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

        const resolveTokenFloor = (value, fallback, contextWindow) => clamp(
          toPositiveInt(value) ?? fallback,
          1,
          Math.max(1, contextWindow),
        );

        const formatInt = (value) => Number(value).toLocaleString('en-US');

        const getInputValue = (node, selector) => {
          const input = node.querySelector(selector);
          if (!input) return '';
          return String(input.value || '').trim();
        };

        const setInputValue = (node, selector, value) => {
          const input = node.querySelector(selector);
          if (!input) return;
          input.value = value;
        };

        const getSlotKeys = () => {
          const keys = [];
          for (const row of catalogBody.querySelectorAll('[data-model-slot-row]')) {
            const slotKey = getInputValue(row, '[data-slot-key]');
            if (!slotKey) continue;
            keys.push(slotKey);
          }
          return keys;
        };

        const refreshRoleSlotOptions = () => {
          const slotKeys = getSlotKeys();
          for (const row of assignmentsBody.querySelectorAll('[data-purpose-row]')) {
            const select = row.querySelector('[data-purpose-slot]');
            if (!select) continue;
            const previous = select.value || select.getAttribute('data-selected-slot') || '';
            const options = [];
            for (const slotKey of slotKeys) {
              options.push({ value: slotKey, label: slotKey });
            }
            if (previous && !slotKeys.includes(previous)) {
              options.unshift({ value: previous, label: previous + ' (missing)' });
            }
            select.innerHTML = options
              .map((option) => '<option value="' + option.value.replace(/"/g, '&quot;') + '">' + option.label + '</option>')
              .join('');
            if (options.length > 0) {
              select.value = previous && options.some((option) => option.value === previous)
                ? previous
                : options[0].value;
            }
            select.removeAttribute('data-selected-slot');
          }
          updateBudgetPreviews();
        };

        const applyMetadataDefaults = (row) => {
          const modelId = getInputValue(row, '[data-model-id]');
          if (!modelId || !Object.prototype.hasOwnProperty.call(modelMeta, modelId)) return;
          const meta = modelMeta[modelId] || {};
          const defaultMax = row.querySelector('[data-default-max-tokens]');
          const defaultContext = row.querySelector('[data-default-context-window]');
          const providerInput = row.querySelector('[data-provider]');
          const providerHints = Array.isArray(meta.providerHints)
            ? meta.providerHints.map((value) => String(value || '').trim()).filter(Boolean)
            : [];
          if (defaultMax && !String(defaultMax.value || '').trim()) {
            const value = toPositiveInt(meta.maxCompletionTokens);
            if (value !== undefined) defaultMax.value = String(value);
          }
          if (defaultContext && !String(defaultContext.value || '').trim()) {
            const value = toPositiveInt(meta.contextLength);
            if (value !== undefined) defaultContext.value = String(value);
          }
          if (providerInput && !String(providerInput.value || '').trim() && providerHints.length === 1) {
            providerInput.value = providerHints[0];
          }
        };

        const updateProviderGuidance = (row) => {
          const modelId = getInputValue(row, '[data-model-id]');
          const hintInput = row.querySelector('[data-provider-hint-copy]');
          if (!hintInput) return;
          if (providerDatalistAvailable) {
            hintInput.style.display = 'none';
            hintInput.value = '';
            return;
          }
          const meta = modelId && Object.prototype.hasOwnProperty.call(modelMeta, modelId)
            ? (modelMeta[modelId] || {})
            : {};
          const providerHints = Array.isArray(meta.providerHints)
            ? meta.providerHints.map((value) => String(value || '').trim()).filter(Boolean)
            : [];
          hintInput.style.display = 'block';
          hintInput.value = providerHints.length > 0
            ? providerHints.join(', ')
            : 'No provider hint available';
        };

        const buildCatalog = () => {
          const catalog = {};
          for (const row of catalogBody.querySelectorAll('[data-model-slot-row]')) {
            const slotKey = getInputValue(row, '[data-slot-key]');
            const model = getInputValue(row, '[data-model-id]');
            const provider = getInputValue(row, '[data-provider]');
            if (!slotKey || !model || !provider) continue;

            const defaults = {};
            const overrides = {};

            const defaultMaxTokens = toPositiveInt(getInputValue(row, '[data-default-max-tokens]'));
            const defaultContextWindow = toPositiveInt(getInputValue(row, '[data-default-context-window]'));
            const defaultSessionMinTokens = toPositiveInt(getInputValue(row, '[data-default-session-min-tokens]'));
            const defaultMemoryMinTokens = toPositiveInt(getInputValue(row, '[data-default-memory-min-tokens]'));
            const overrideMaxTokens = toPositiveInt(getInputValue(row, '[data-override-max-tokens]'));
            const overrideContextWindow = toPositiveInt(getInputValue(row, '[data-override-context-window]'));
            const overrideSessionMinTokens = toPositiveInt(getInputValue(row, '[data-override-session-min-tokens]'));
            const overrideMemoryMinTokens = toPositiveInt(getInputValue(row, '[data-override-memory-min-tokens]'));

            if (defaultMaxTokens !== undefined) defaults.maxTokens = defaultMaxTokens;
            if (defaultContextWindow !== undefined) defaults.contextWindow = defaultContextWindow;
            if (defaultSessionMinTokens !== undefined || defaultMemoryMinTokens !== undefined) {
              defaults.contextBudget = {
                ...(defaultSessionMinTokens !== undefined ? { sessionHistoryMinTokens: defaultSessionMinTokens } : {}),
                ...(defaultMemoryMinTokens !== undefined ? { memoryRetrievalMinTokens: defaultMemoryMinTokens } : {}),
              };
            }
            if (overrideMaxTokens !== undefined) overrides.maxTokens = overrideMaxTokens;
            if (overrideContextWindow !== undefined) overrides.contextWindow = overrideContextWindow;
            if (overrideSessionMinTokens !== undefined || overrideMemoryMinTokens !== undefined) {
              overrides.contextBudget = {
                ...(overrideSessionMinTokens !== undefined ? { sessionHistoryMinTokens: overrideSessionMinTokens } : {}),
                ...(overrideMemoryMinTokens !== undefined ? { memoryRetrievalMinTokens: overrideMemoryMinTokens } : {}),
              };
            }

            catalog[slotKey] = {
              model,
              provider,
              ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
              ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
            };
          }
          return catalog;
        };

        const buildAssignments = () => {
          const assignments = {};
          for (const row of assignmentsBody.querySelectorAll('[data-purpose-row]')) {
            const purpose = getInputValue(row, '[data-purpose]');
            const slotKey = getInputValue(row, '[data-purpose-slot]');
            if (!purpose || !slotKey) continue;
            assignments[purpose] = slotKey;
          }
          return assignments;
        };

        const resolvePurposeSlot = (catalog, assignments, purpose, fallback) => {
          const byPurpose = assignments[purpose];
          if (byPurpose && catalog[byPurpose]) return catalog[byPurpose];
          if (fallback && catalog[fallback]) return catalog[fallback];
          const first = Object.keys(catalog)[0];
          return first ? catalog[first] : undefined;
        };

        const resolveChatContextWindow = (catalog, assignments) => {
          const chatSlot = resolvePurposeSlot(catalog, assignments, 'chat', 'primary');
          const overrideWindow = toPositiveInt(chatSlot?.overrides?.contextWindow);
          if (overrideWindow !== undefined) return overrideWindow;
          const defaultWindow = toPositiveInt(chatSlot?.defaults?.contextWindow);
          if (defaultWindow !== undefined) return defaultWindow;
          return DEFAULT_CONTEXT_WINDOW;
        };

        const resolveChatContextFloors = (catalog, assignments, contextWindow) => {
          const chatSlot = resolvePurposeSlot(catalog, assignments, 'chat', 'primary');
          return {
            sessionHistoryMinTokens: resolveTokenFloor(
              chatSlot?.overrides?.contextBudget?.sessionHistoryMinTokens
                ?? chatSlot?.defaults?.contextBudget?.sessionHistoryMinTokens,
              DEFAULT_SESSION_MIN_TOKEN_FLOOR,
              contextWindow,
            ),
            memoryRetrievalMinTokens: resolveTokenFloor(
              chatSlot?.overrides?.contextBudget?.memoryRetrievalMinTokens
                ?? chatSlot?.defaults?.contextBudget?.memoryRetrievalMinTokens,
              DEFAULT_MEMORY_MIN_TOKEN_FLOOR,
              contextWindow,
            ),
          };
        };

        const formatBudgetPreview = (params) => {
          const pctBudget = Math.floor(params.contextWindow * (params.pct / 100));
          const tokenBudget = Math.max(params.minTokenFloor, pctBudget);
          const roughCount = Math.floor(tokenBudget / Math.max(1, params.tokensPerItem));
          const estimatedCount = clamp(roughCount, params.minCount, params.maxCount);
          return {
            tokenBudget,
            estimatedCount,
          };
        };

        const applyLegacyAliases = (catalog, assignments) => {
          const chatSlot = resolvePurposeSlot(catalog, assignments, 'chat', 'primary');
          const extractionSlot = resolvePurposeSlot(
            catalog,
            assignments,
            'extraction',
            assignments.background || 'extraction',
          ) || resolvePurposeSlot(catalog, assignments, 'background', 'extraction');

          if (chatSlot) {
            legacyPrimaryModel.value = chatSlot.model || '';
            legacyPrimaryProvider.value = chatSlot.provider || '';
            const max = chatSlot.overrides?.maxTokens || chatSlot.defaults?.maxTokens || '';
            legacyPrimaryMax.value = String(max || '');
            if (aliasPrimary) aliasPrimary.value = chatSlot.model || '';
          }

          if (extractionSlot) {
            legacyExtractionModel.value = extractionSlot.model || '';
            legacyExtractionProvider.value = extractionSlot.provider || '';
            const max = extractionSlot.overrides?.maxTokens || extractionSlot.defaults?.maxTokens || '';
            legacyExtractionMax.value = String(max || '');
            if (aliasExtraction) aliasExtraction.value = extractionSlot.model || '';
          }
        };

        const updateBudgetPreviews = () => {
          const catalog = buildCatalog();
          const assignments = buildAssignments();
          const contextWindow = resolveChatContextWindow(catalog, assignments);
          const contextFloors = resolveChatContextFloors(catalog, assignments, contextWindow);

          const sessionPct = clamp(
            toPositiveInt(sessionBudgetInput?.value) ?? DEFAULT_SESSION_BUDGET_PCT,
            SESSION_BUDGET_RANGE.min,
            SESSION_BUDGET_RANGE.max,
          );
          const memoryPct = clamp(
            toPositiveInt(memoryBudgetInput?.value) ?? DEFAULT_MEMORY_BUDGET_PCT,
            MEMORY_BUDGET_RANGE.min,
            MEMORY_BUDGET_RANGE.max,
          );

          const sessionBudgetData = formatBudgetPreview({
            contextWindow,
            pct: sessionPct,
            minTokenFloor: contextFloors.sessionHistoryMinTokens,
            tokensPerItem: SESSION_TOKENS_PER_MESSAGE,
            minCount: SESSION_MIN_COUNT,
            maxCount: SESSION_MAX_COUNT,
          });
          const memoryBudgetData = formatBudgetPreview({
            contextWindow,
            pct: memoryPct,
            minTokenFloor: contextFloors.memoryRetrievalMinTokens,
            tokensPerItem: MEMORY_TOKENS_PER_ITEM,
            minCount: MEMORY_MIN_COUNT,
            maxCount: MEMORY_MAX_COUNT,
          });

          if (sessionBudgetPreview) {
            const hard = toPositiveInt(sessionHardLimitInput?.value);
            sessionBudgetPreview.textContent = hard !== undefined
              ? 'Hard override active: ' + formatInt(hard)
                  + ' messages. Budget preview: ~' + formatInt(sessionBudgetData.estimatedCount)
                  + ' messages (' + formatInt(sessionBudgetData.tokenBudget) + ' tokens of '
                  + formatInt(contextWindow) + ').'
              : 'Auto budget: ~' + formatInt(sessionBudgetData.estimatedCount)
                  + ' messages (' + formatInt(sessionBudgetData.tokenBudget) + ' tokens of '
                  + formatInt(contextWindow) + ').';
          }

          if (memoryBudgetPreview) {
            const hard = toPositiveInt(memoryHardLimitInput?.value);
            memoryBudgetPreview.textContent = hard !== undefined
              ? 'Hard override active: ' + formatInt(hard)
                  + ' memories. Budget preview: ~' + formatInt(memoryBudgetData.estimatedCount)
                  + ' memories (' + formatInt(memoryBudgetData.tokenBudget) + ' tokens of '
                  + formatInt(contextWindow) + ').'
              : 'Auto budget: ~' + formatInt(memoryBudgetData.estimatedCount)
                  + ' memories (' + formatInt(memoryBudgetData.tokenBudget) + ' tokens of '
                  + formatInt(contextWindow) + ').';
          }
        };

        const bindCatalogRow = (row) => {
          const remove = row.querySelector('[data-remove-slot]');
          const modelInput = row.querySelector('[data-model-id]');
          const slotInput = row.querySelector('[data-slot-key]');
          if (remove) {
            remove.addEventListener('click', () => {
              row.remove();
              refreshRoleSlotOptions();
            });
          }
          if (slotInput) {
            slotInput.addEventListener('input', () => refreshRoleSlotOptions());
          }
          if (modelInput) {
            modelInput.addEventListener('change', () => {
              applyMetadataDefaults(row);
              updateProviderGuidance(row);
              updateBudgetPreviews();
            });
          }
          row.addEventListener('input', () => updateBudgetPreviews());
          applyMetadataDefaults(row);
          updateProviderGuidance(row);
        };

        const bindPurposeRow = (row) => {
          const remove = row.querySelector('[data-remove-purpose]');
          const purposeInput = row.querySelector('[data-purpose]');
          const slotSelect = row.querySelector('[data-purpose-slot]');
          if (remove) {
            remove.addEventListener('click', () => {
              row.remove();
              updateBudgetPreviews();
            });
          }
          if (purposeInput) {
            purposeInput.addEventListener('input', () => updateBudgetPreviews());
          }
          if (slotSelect) {
            slotSelect.addEventListener('change', () => updateBudgetPreviews());
          }
        };

        for (const row of catalogBody.querySelectorAll('[data-model-slot-row]')) bindCatalogRow(row);
        for (const row of assignmentsBody.querySelectorAll('[data-purpose-row]')) bindPurposeRow(row);

        refreshRoleSlotOptions();
        updateBudgetPreviews();

        for (const input of [
          sessionBudgetInput,
          sessionHardLimitInput,
          memoryBudgetInput,
          memoryHardLimitInput,
        ]) {
          if (!input) continue;
          input.addEventListener('input', () => updateBudgetPreviews());
        }

        if (addSlotButton) {
          addSlotButton.addEventListener('click', () => {
            const fragment = modelSlotTemplate.content.cloneNode(true);
            const row = fragment.querySelector('[data-model-slot-row]');
            if (!row) return;
            catalogBody.appendChild(fragment);
            bindCatalogRow(catalogBody.lastElementChild);
            refreshRoleSlotOptions();
          });
        }

        if (addPurposeButton) {
          addPurposeButton.addEventListener('click', () => {
            const fragment = purposeTemplate.content.cloneNode(true);
            assignmentsBody.appendChild(fragment);
            bindPurposeRow(assignmentsBody.lastElementChild);
            refreshRoleSlotOptions();
          });
        }

        form.addEventListener('submit', (event) => {
          const catalog = buildCatalog();
          if (Object.keys(catalog).length === 0) {
            event.preventDefault();
            if (resultNode) {
              resultNode.innerHTML = '<span class="form-error">At least one valid model slot is required.</span>';
            }
            return;
          }

          const assignments = buildAssignments();
          hiddenCatalog.value = JSON.stringify(catalog);
          hiddenAssignments.value = JSON.stringify(assignments);
          applyLegacyAliases(catalog, assignments);
        });
      })();
    </script>
  `;
}

export function settingsFormResult(success: boolean, message: string): string {
  return success
    ? `<span class="form-success">${escapeHtml(message)}</span>`
    : `<span class="form-error">${escapeHtml(message)}</span>`;
}
