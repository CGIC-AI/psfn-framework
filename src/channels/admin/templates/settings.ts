import type { DiscoveredModel } from '../../../llm/discovery.js';
import type { CapabilityTier, ModelCatalogEntry, ModelRoleAssignments, SubstrateConfig } from '../../../types.js';
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
  resolveMemoryRetrievalBudget,
  resolveSessionHistoryBudget,
  SESSION_HISTORY_BUDGET_PCT_DEFAULT,
  SESSION_HISTORY_BUDGET_PCT_RANGE,
  SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE,
} from '../../../context-budget.js';
import { escapeHtml } from './shared.js';

const DEFAULT_ROLE_ASSIGNMENTS: ModelRoleAssignments = {
  chat: 'primary',
  background: 'extraction',
  extraction: 'extraction',
  summary: 'primary',
  reasoning: 'primary',
  longContext: 'primary',
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
  overrideMaxTokens: string;
  overrideContextWindow: string;
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
    overrideMaxTokens: toTextNumber(entry.overrides?.maxTokens),
    overrideContextWindow: toTextNumber(entry.overrides?.contextWindow),
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

function renderCatalogRow(row: CatalogRowView): string {
  return `
    <tr data-model-slot-row>
      <td><input type="text" data-slot-key value="${escapeHtml(row.slotKey)}" placeholder="primary"></td>
      <td>
        <input type="text" data-model-id value="${escapeHtml(row.model)}" placeholder="provider/model" list="settings-model-list">
      </td>
      <td><input type="text" data-provider value="${escapeHtml(row.provider)}" placeholder="openrouter"></td>
      <td><input type="number" data-default-max-tokens value="${escapeHtml(row.defaultMaxTokens)}" min="1" placeholder="metadata"></td>
      <td><input type="number" data-default-context-window value="${escapeHtml(row.defaultContextWindow)}" min="1" placeholder="metadata"></td>
      <td><input type="number" data-override-max-tokens value="${escapeHtml(row.overrideMaxTokens)}" min="1" placeholder="optional"></td>
      <td><input type="number" data-override-context-window value="${escapeHtml(row.overrideContextWindow)}" min="1" placeholder="optional"></td>
      <td><button type="button" class="btn" data-remove-slot style="font-size:0.8rem">Remove</button></td>
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
  const retryMaxAttempts = config.retryMaxAttempts ?? 3;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? 2000;

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
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`)
    .join('');

  const discoveryMeta = Object.fromEntries(availableModels.map(model => [
    model.id,
    {
      contextLength: model.contextLength,
      maxCompletionTokens: model.maxCompletionTokens,
      description: model.description,
    },
  ]));

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
                ${catalogRows.map(row => renderCatalogRow(row)).join('')}
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
            <p class="note" style="margin:0.4rem 0 0 0" data-memory-budget-preview></p>
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
            <p class="note" style="margin:0.4rem 0 0 0" data-session-budget-preview></p>
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
      description: 'Defines trust ceilings, visibility caps, and channel classification rules.',
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
        <td><input type="text" data-provider placeholder="openrouter"></td>
        <td><input type="number" data-default-max-tokens min="1" placeholder="metadata"></td>
        <td><input type="number" data-default-context-window min="1" placeholder="metadata"></td>
        <td><input type="number" data-override-max-tokens min="1" placeholder="optional"></td>
        <td><input type="number" data-override-context-window min="1" placeholder="optional"></td>
        <td><button type="button" class="btn" data-remove-slot style="font-size:0.8rem">Remove</button></td>
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

        const DEFAULT_CONTEXT_WINDOW = ${config.modelRoster.chat?.contextWindow ?? config.defaultContextWindow};
        const DEFAULT_SESSION_BUDGET_PCT = ${config.sessionHistoryBudgetPct ?? SESSION_HISTORY_BUDGET_PCT_DEFAULT};
        const DEFAULT_MEMORY_BUDGET_PCT = ${config.memoryRetrievalBudgetPct ?? MEMORY_RETRIEVAL_BUDGET_PCT_DEFAULT};
        const SESSION_BUDGET_RANGE = { min: ${SESSION_HISTORY_BUDGET_PCT_RANGE.min}, max: ${SESSION_HISTORY_BUDGET_PCT_RANGE.max} };
        const MEMORY_BUDGET_RANGE = { min: ${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.min}, max: ${MEMORY_RETRIEVAL_BUDGET_PCT_RANGE.max} };
        const SESSION_TOKENS_PER_MESSAGE = ${SESSION_HISTORY_ESTIMATED_TOKENS_PER_MESSAGE};
        const MEMORY_TOKENS_PER_ITEM = ${MEMORY_RETRIEVAL_ESTIMATED_TOKENS_PER_ITEM};

        const toPositiveInt = (raw) => {
          const parsed = Number.parseInt(String(raw || '').trim(), 10);
          if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
          return parsed;
        };

        const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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
          if (defaultMax && !String(defaultMax.value || '').trim()) {
            const value = toPositiveInt(meta.maxCompletionTokens);
            if (value !== undefined) defaultMax.value = String(value);
          }
          if (defaultContext && !String(defaultContext.value || '').trim()) {
            const value = toPositiveInt(meta.contextLength);
            if (value !== undefined) defaultContext.value = String(value);
          }
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
            const overrideMaxTokens = toPositiveInt(getInputValue(row, '[data-override-max-tokens]'));
            const overrideContextWindow = toPositiveInt(getInputValue(row, '[data-override-context-window]'));

            if (defaultMaxTokens !== undefined) defaults.maxTokens = defaultMaxTokens;
            if (defaultContextWindow !== undefined) defaults.contextWindow = defaultContextWindow;
            if (overrideMaxTokens !== undefined) overrides.maxTokens = overrideMaxTokens;
            if (overrideContextWindow !== undefined) overrides.contextWindow = overrideContextWindow;

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

        const formatBudgetPreview = (params) => {
          const tokenBudget = Math.max(1, Math.floor(params.contextWindow * (params.pct / 100)));
          const estimatedCount = Math.max(params.minCount, Math.floor(tokenBudget / params.tokensPerItem));
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
            tokensPerItem: SESSION_TOKENS_PER_MESSAGE,
            minCount: 5,
          });
          const memoryBudgetData = formatBudgetPreview({
            contextWindow,
            pct: memoryPct,
            tokensPerItem: MEMORY_TOKENS_PER_ITEM,
            minCount: 1,
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
              updateBudgetPreviews();
            });
          }
          row.addEventListener('input', () => updateBudgetPreviews());
          applyMetadataDefaults(row);
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
