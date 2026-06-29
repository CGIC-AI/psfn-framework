<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '$app/paths';
  import {
    getModelsConfigRaw,
    getProvidersConfigRaw,
    saveModelsConfigRaw,
    listDiscoveredModels,
    refreshDiscoveredModels,
  } from '$lib/api/endpoints/models';
  import { saveSubConfig } from '$lib/api/endpoints/settings';
  import { ApiError } from '$lib/api/client';
  import type {
    CanonicalProviderRegistry,
    ProviderRegistryEntry,
    DiscoveredModel,
  } from '$lib/types';
  import {
    CANONICAL_PURPOSES,
    DEFAULT_BUDGET_POLICY,
    PURPOSE_LABELS,
    isRecord,
    normalizeRouting,
    parseModelRegistryJson,
    toNonEmptyString,
    type CanonicalModelPurpose,
    type CanonicalModelRegistry,
    type ModelRegistryBudgetPolicy,
    type ModelRegistryEntry,
    type ModelRegistryPurposeTag,
  } from '$lib/models/registry';
  import {
    backfillDiscoveredMetadata,
    buildUniqueModelId,
    deriveDiscoveryAutofill,
    resolveDiscoveredModelSelection,
  } from './discovery-autofill';
  import {
    parseProviderRegistryJson,
    PROVIDER_TYPE_LABELS,
    PROVIDER_TYPES,
    providerIsEnabled,
    providerSupportsModelsApi,
  } from '$lib/providers/registry';
  import {
    appendProviderEntry,
    cloneProviderRegistry,
    providerRegistryIsDirty,
    providerRuntimeRole,
    providerTypeSummary,
    removeProviderEntry as removeProviderRegistryEntry,
    serializeProviderRegistry,
    setProviderField as setProviderRegistryField,
    setProviderType as setProviderRegistryType,
    type ProviderEditableField,
    updateProviderEntry as updateProviderRegistryEntry,
    validateProviderRegistry,
  } from '$lib/providers/editor';

  const TUNING_NUMBER_FIELDS = [
    { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.01, integer: false },
    { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.01, integer: false },
    { key: 'topK', label: 'Top K', min: 1, max: 500, step: 1, integer: true },
    { key: 'frequencyPenalty', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01, integer: false },
    { key: 'repetitionPenalty', label: 'Repetition Penalty', min: 0, max: 2, step: 0.01, integer: false },
  ] as const;

  const CAPABILITY_BOOLEAN_FIELDS = [
    { key: 'supportsReasoning', label: 'Supports Thinking / Reasoning' },
    { key: 'supportsVision', label: 'Supports Vision' },
  ] as const;
  const MODEL_SLOT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

  let loading = $state(true);
  let saving = $state(false);
  let refreshingDiscovery = $state(false);
  let error = $state('');
  let discoveryError = $state('');
  let flashMessage = $state('');
  let flashOk = $state(true);
  let validationErrors = $state<string[]>([]);
  let models = $state<ModelRegistryEntry[]>([]);
  let budgetPolicy = $state<ModelRegistryBudgetPolicy>({ ...DEFAULT_BUDGET_POLICY });
  let discoveredModels = $state<DiscoveredModel[]>([]);
  let discoverySearch = $state('');
  let providerRegistry = $state<CanonicalProviderRegistry>({ schemaVersion: 1, providers: [] });
  let providerRegistryInitialJson = $state('{"schemaVersion":1,"providers":[]}');
  let providerValidationErrors = $state<string[]>([]);
  let expandedModelIds = $state<Set<string>>(new Set());
  let dragSourceIndex = $state<number | null>(null);
  let dragOverIndex = $state<number | null>(null);
  let dirty = $state(false);
  let initialSnapshot = $state('');
  let enabledProviders = $derived.by(() => providerRegistry.providers.filter(providerIsEnabled));
  let providerEntriesById = $derived.by(() => (
    new Map(providerRegistry.providers.map((entry) => [entry.id, entry] as const))
  ));
  let providerTypeOptions = $derived.by(() => (
    [...new Set(providerRegistry.providers.map((entry) => entry.type))].sort()
  ));
  let filteredDiscoveredModels = $derived.by(() => {
    const terms = discoverySearch
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) return discoveredModels;
    return discoveredModels.filter((model) => {
      const searchable = discoverySearchText(model);
      return terms.every((term) => searchable.includes(term));
    });
  });

  let purposePrimaryCounts = $derived.by(() => {
    const counts = Object.fromEntries(
      CANONICAL_PURPOSES.map((purpose) => [purpose, 0]),
    ) as Record<CanonicalModelPurpose, number>;
    for (const model of models) {
      for (const tag of model.purposes) {
        if (tag.primary) {
          counts[tag.purpose] = (counts[tag.purpose] ?? 0) + 1;
        }
      }
    }
    return counts;
  });

  let budgetInlineError = $derived.by(() => {
    if (!Number.isFinite(budgetPolicy.dailyUsdLimit) || budgetPolicy.dailyUsdLimit <= 0) {
      return 'Daily limit must be a positive number.';
    }
    if (!Number.isFinite(budgetPolicy.monthlyUsdLimit) || budgetPolicy.monthlyUsdLimit <= 0) {
      return 'Monthly limit must be a positive number.';
    }
    if (budgetPolicy.monthlyUsdLimit < budgetPolicy.dailyUsdLimit) {
      return 'Monthly limit must be greater than or equal to the daily limit.';
    }
    return '';
  });

  let budgetFormInvalid = $derived.by(() => budgetInlineError.length > 0);

  let dailyBudgetSliderMax = $derived.by(() => {
    const monthlyLimit = Number.isFinite(budgetPolicy.monthlyUsdLimit)
      ? budgetPolicy.monthlyUsdLimit
      : DEFAULT_BUDGET_POLICY.monthlyUsdLimit;
    return Math.max(50, Math.ceil(monthlyLimit));
  });

  let monthlyBudgetSliderMax = $derived.by(() => {
    const monthlyLimit = Number.isFinite(budgetPolicy.monthlyUsdLimit)
      ? budgetPolicy.monthlyUsdLimit
      : DEFAULT_BUDGET_POLICY.monthlyUsdLimit;
    const dailyLimit = Number.isFinite(budgetPolicy.dailyUsdLimit)
      ? budgetPolicy.dailyUsdLimit
      : DEFAULT_BUDGET_POLICY.dailyUsdLimit;
    return Math.max(100, Math.ceil(monthlyLimit * 2), Math.ceil(dailyLimit));
  });

  let dailyBudgetSliderValue = $derived.by(() => {
    const dailyLimit = Number.isFinite(budgetPolicy.dailyUsdLimit)
      ? budgetPolicy.dailyUsdLimit
      : DEFAULT_BUDGET_POLICY.dailyUsdLimit;
    return Math.min(Math.max(dailyLimit, 1), dailyBudgetSliderMax);
  });

  let monthlyBudgetSliderValue = $derived.by(() => {
    const monthlyLimit = Number.isFinite(budgetPolicy.monthlyUsdLimit)
      ? budgetPolicy.monthlyUsdLimit
      : DEFAULT_BUDGET_POLICY.monthlyUsdLimit;
    return Math.min(Math.max(monthlyLimit, 1), monthlyBudgetSliderMax);
  });

  $effect(() => {
    if (!initialSnapshot) return;
    dirty = JSON.stringify({ models, budgetPolicy, providerRegistry }) !== initialSnapshot;
  });

  function toErrorMessage(value: unknown, fallback: string): string {
    if (value instanceof Error && value.message.trim().length > 0) {
      return value.message.trim();
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    return fallback;
  }

  function parseApiErrorDetail(error: ApiError): string | undefined {
    const rawBody = typeof error.body === 'string' ? error.body.trim() : '';
    if (rawBody.length === 0) return undefined;
    try {
      const parsed = JSON.parse(rawBody) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
        return parsed.error.trim();
      }
      if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
        return parsed.message.trim();
      }
    } catch {
      // Non-JSON response body; fall back to raw text
    }
    return rawBody;
  }

  function discoverySearchText(model: DiscoveredModel): string {
    return [
      model.id,
      model.description,
      ...(model.providerHints ?? []),
      ...(model.zdrProviderTags ?? []),
      ...(model.zdrProviderNames ?? []),
      model.supportsVision ? 'vision image multimodal' : '',
      model.supportsReasoning ? 'reasoning thinking' : '',
      model.zdrAvailable ? 'zdr zero data retention' : 'no zdr',
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();
  }

  function discoveryLimitSummary(model: DiscoveredModel): string {
    const parts: string[] = [];
    if (model.contextLength) {
      parts.push(`ctx ${model.contextLength.toLocaleString()}`);
    }
    if (model.maxCompletionTokens) {
      parts.push(`max out ${model.maxCompletionTokens.toLocaleString()}`);
    }
    return parts.length > 0 ? parts.join(' · ') : 'limits unknown';
  }

  function discoveryZdrProviderSummary(model: DiscoveredModel): string {
    const tags = model.zdrProviderTags ?? [];
    if (tags.length > 0) {
      return tags.slice(0, 3).join(', ') + (tags.length > 3 ? ` +${tags.length - 3}` : '');
    }
    const names = model.zdrProviderNames ?? [];
    if (names.length > 0) {
      return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
    }
    return 'ZDR endpoint available';
  }

  function setProviderRegistryState(nextRegistry: CanonicalProviderRegistry): void {
    providerRegistry = cloneProviderRegistry(nextRegistry);
    providerRegistryInitialJson = serializeProviderRegistry(providerRegistry);
    providerValidationErrors = [];
  }

  function providerRegistryDirty(): boolean {
    return providerRegistryIsDirty(providerRegistry, providerRegistryInitialJson);
  }

  function updateProviderEntry(index: number, updater: (entry: ProviderRegistryEntry) => ProviderRegistryEntry): void {
    providerRegistry = updateProviderRegistryEntry(providerRegistry, index, updater);
    providerValidationErrors = [];
  }

  function addProviderEntry(): void {
    providerRegistry = appendProviderEntry(providerRegistry);
    providerValidationErrors = [];
  }

  function removeProviderEntry(index: number): void {
    providerRegistry = removeProviderRegistryEntry(providerRegistry, index);
    providerValidationErrors = [];
  }

  function setProviderType(index: number, value: string): void {
    providerRegistry = setProviderRegistryType(providerRegistry, index, value);
    providerValidationErrors = [];
  }

  function setProviderField(index: number, field: ProviderEditableField, value: string): void {
    providerRegistry = setProviderRegistryField(providerRegistry, index, field, value);
    providerValidationErrors = [];
  }

  async function saveProviderRegistry(): Promise<void> {
    saving = true;
    try {
      const errors = validateProviderRegistry(providerRegistry);
      providerValidationErrors = errors;
      if (errors.length > 0) {
        flashOk = false;
        flashMessage = errors[0] ?? 'Provider registry validation failed';
        return;
      }
      await saveSubConfig('providers', JSON.stringify(providerRegistry, null, 2));
      const providersRaw = await getProvidersConfigRaw();
      setProviderRegistryState(parseProviderRegistryJson(providersRaw));
      initialSnapshot = JSON.stringify({
        models,
        budgetPolicy,
        providerRegistry,
      });
      flashOk = true;
      flashMessage = 'providers.json saved';
    } catch (error) {
      flashOk = false;
      flashMessage = error instanceof Error ? error.message : 'Failed to save providers.json';
    } finally {
      saving = false;
    }
  }

  function discardProviderRegistryChanges(): void {
    try {
      providerRegistry = JSON.parse(providerRegistryInitialJson) as CanonicalProviderRegistry;
      providerValidationErrors = [];
    } catch {
      providerRegistry = { schemaVersion: 1, providers: [] };
      providerValidationErrors = [];
    }
  }

  function toOptionalNumber(raw: string, integer = false): number | undefined {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return undefined;
    return integer ? Math.round(numeric) : numeric;
  }

  function cloneModelEntry(entry: ModelRegistryEntry): ModelRegistryEntry {
    return {
      ...entry,
      identity: {
        ...entry.identity,
        source: {
          ...entry.identity.source,
          ...(isRecord(entry.identity.source.metadata)
            ? { metadata: { ...entry.identity.source.metadata } }
            : {}),
        },
      },
      purposes: entry.purposes.map((purpose) => ({ ...purpose })),
      ...(entry.routing ? { routing: { providerOrder: [...(entry.routing.providerOrder ?? [])] } } : {}),
      ...(isRecord(entry.capabilities) ? { capabilities: { ...entry.capabilities } } : {}),
      ...(isRecord(entry.tuning) ? { tuning: { ...entry.tuning } } : {}),
      ...(isRecord(entry.cost) ? { cost: { ...entry.cost } } : {}),
      ...(isRecord(entry.metadata) ? { metadata: { ...entry.metadata } } : {}),
    };
  }

  function resequenceRanks(entries: ModelRegistryEntry[]): ModelRegistryEntry[] {
    const total = entries.length;
    return entries.map((entry, index) => ({
      ...entry,
      rank: (total - index) * 10,
    }));
  }

  function setBudgetPolicyEnabled(enabled: boolean): void {
    budgetPolicy = {
      ...budgetPolicy,
      enabled,
    };
  }

  function setBudgetPolicyLimit(field: 'dailyUsdLimit' | 'monthlyUsdLimit', rawValue: string): void {
    const numeric = toOptionalNumber(rawValue, false);
    budgetPolicy = {
      ...budgetPolicy,
      [field]: numeric !== undefined && numeric > 0
        ? numeric
        : DEFAULT_BUDGET_POLICY[field],
    };
  }

  function purposeState(entry: ModelRegistryEntry, purpose: CanonicalModelPurpose): 'none' | 'standard' | 'primary' {
    const tag = entry.purposes.find((candidate) => candidate.purpose === purpose);
    if (!tag) return 'none';
    return tag.primary ? 'primary' : 'standard';
  }

  function updateModelAt(index: number, updater: (entry: ModelRegistryEntry) => ModelRegistryEntry): void {
    models = models.map((entry, entryIndex) => (
      entryIndex === index
        ? updater(cloneModelEntry(entry))
        : entry
    ));
  }

  function cyclePurposeTag(index: number, purpose: CanonicalModelPurpose): void {
    const target = models[index];
    if (!target) return;

    const currentTag = target.purposes.find((tag) => tag.purpose === purpose);
    if (!currentTag) {
      updateModelAt(index, (entry) => {
        entry.purposes = [...entry.purposes, { purpose, primary: false }].sort(
          (a, b) => CANONICAL_PURPOSES.indexOf(a.purpose) - CANONICAL_PURPOSES.indexOf(b.purpose),
        );
        return entry;
      });
      return;
    }

    if (currentTag.primary !== true) {
      models = models.map((entry, entryIndex) => {
        const cloned = cloneModelEntry(entry);
        const nextPurposes = cloned.purposes.map((tag) => ({ ...tag }));
        const purposeIndex = nextPurposes.findIndex((tag) => tag.purpose === purpose);
        if (purposeIndex < 0) return cloned;

        if (entryIndex === index) {
          nextPurposes[purposeIndex].primary = true;
        } else if (nextPurposes[purposeIndex].primary) {
          nextPurposes[purposeIndex].primary = false;
        }
        cloned.purposes = nextPurposes.sort(
          (a, b) => CANONICAL_PURPOSES.indexOf(a.purpose) - CANONICAL_PURPOSES.indexOf(b.purpose),
        );
        return cloned;
      });
      return;
    }

    updateModelAt(index, (entry) => {
      entry.purposes = entry.purposes
        .filter((tag) => tag.purpose !== purpose)
        .sort((a, b) => CANONICAL_PURPOSES.indexOf(a.purpose) - CANONICAL_PURPOSES.indexOf(b.purpose));
      return entry;
    });
  }

  function setIdentityField(index: number, key: 'provider' | 'model' | 'family', value: string): void {
    updateModelAt(index, (entry) => {
      if (key === 'family') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          delete entry.identity.family;
        } else {
          entry.identity.family = trimmed;
        }
      } else {
        entry.identity[key] = value;
        if (key === 'provider') {
          const normalizedProvider = value.trim().toLowerCase();
          if (normalizedProvider.length > 0) {
            applyProviderDefaults(entry, normalizedProvider);
          }
        }
        if (key === 'model') {
          const normalizedModel = value.trim();
          if (normalizedModel.length > 0) {
            const discovered = resolveDiscoveredModelSelection(normalizedModel, discoveredModels);
            if (discovered) {
              applyDiscoveredMetadata(entry, discovered);
            }
          }
        }
      }
      return entry;
    });
  }

  function setSourceField(index: number, key: 'type' | 'label' | 'baseUrl', value: string): void {
    updateModelAt(index, (entry) => {
      if (key === 'label' || key === 'baseUrl') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          delete entry.identity.source[key];
        } else {
          entry.identity.source[key] = trimmed;
        }
      } else {
        entry.identity.source.type = value;
      }
      return entry;
    });
  }

  function providerLabel(entry: ProviderRegistryEntry | undefined): string {
    if (!entry) return 'Unknown provider';
    return entry.label?.trim() || PROVIDER_TYPE_LABELS[entry.type] || entry.id;
  }

  function providerAvailability(entry: ProviderRegistryEntry | undefined): string {
    if (!entry) return 'not registered';
    return providerIsEnabled(entry) ? 'enabled' : 'disabled';
  }

  function providerForModel(entry: ModelRegistryEntry): ProviderRegistryEntry | undefined {
    return providerEntriesById.get(entry.identity.provider.trim().toLowerCase());
  }

  function applyProviderDefaults(entry: ModelRegistryEntry, providerId: string): ModelRegistryEntry {
    const provider = providerEntriesById.get(providerId);
    if (!provider) return entry;
    entry.identity.provider = provider.id;
    if (!entry.identity.source.type.trim()) {
      entry.identity.source.type = provider.type;
    }
    if (!entry.identity.source.label?.trim()) {
      entry.identity.source.label = provider.label ?? PROVIDER_TYPE_LABELS[provider.type];
    }
    if (!entry.identity.source.baseUrl?.trim() && provider.apiBaseUrl) {
      entry.identity.source.baseUrl = provider.apiBaseUrl;
    }
    return entry;
  }

  function setRoutingProviderOrder(index: number, rawValue: string): void {
    updateModelAt(index, (entry) => {
      const providerOrder = rawValue
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value, orderIndex, array) => value.length > 0 && array.indexOf(value) === orderIndex);
      if (providerOrder.length === 0) {
        delete entry.routing;
      } else {
        entry.routing = { providerOrder };
      }
      return entry;
    });
  }

  function toggleRoutingProvider(index: number, providerId: string): void {
    updateModelAt(index, (entry) => {
      const currentOrder = entry.routing?.providerOrder ?? [];
      const nextOrder = currentOrder.includes(providerId)
        ? currentOrder.filter((value) => value !== providerId)
        : [...currentOrder, providerId];
      if (nextOrder.length === 0) {
        delete entry.routing;
      } else {
        entry.routing = { providerOrder: nextOrder };
      }
      return entry;
    });
  }

  function routingProviderOrderValue(entry: ModelRegistryEntry): string {
    return entry.routing?.providerOrder?.join(', ') ?? '';
  }

  function setContainerValue(
    index: number,
    containerKey: 'capabilities' | 'tuning' | 'cost',
    field: string,
    value: unknown,
  ): void {
    updateModelAt(index, (entry) => {
      const nextContainer = isRecord(entry[containerKey]) ? { ...entry[containerKey] } : {};
      if (value === undefined) {
        delete nextContainer[field];
      } else {
        nextContainer[field] = value;
      }
      if (Object.keys(nextContainer).length === 0) {
        delete entry[containerKey];
      } else {
        entry[containerKey] = nextContainer;
      }
      return entry;
    });
  }

  function setContainerNumber(
    index: number,
    containerKey: 'capabilities' | 'tuning' | 'cost',
    field: string,
    rawValue: string,
    integer = false,
  ): void {
    setContainerValue(index, containerKey, field, toOptionalNumber(rawValue, integer));
  }

  function setContainerBoolean(
    index: number,
    containerKey: 'capabilities' | 'tuning',
    field: string,
    checked: boolean,
  ): void {
    setContainerValue(index, containerKey, field, checked);
  }

  function numberFromContainer(
    entry: ModelRegistryEntry,
    containerKey: 'capabilities' | 'tuning' | 'cost',
    field: string,
  ): number | undefined {
    const container = entry[containerKey];
    if (!isRecord(container)) return undefined;
    const value = container[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  function boolFromContainer(
    entry: ModelRegistryEntry,
    containerKey: 'capabilities' | 'tuning',
    field: string,
  ): boolean {
    const container = entry[containerKey];
    if (!isRecord(container)) return false;
    return container[field] === true;
  }

  function maxContext(entry: ModelRegistryEntry): string {
    const value = numberFromContainer(entry, 'tuning', 'contextWindow')
      ?? numberFromContainer(entry, 'capabilities', 'contextWindow');
    return value !== undefined ? value.toLocaleString() : 'unset';
  }

  function maxResponse(entry: ModelRegistryEntry): string {
    const value = numberFromContainer(entry, 'tuning', 'maxOutputTokens')
      ?? numberFromContainer(entry, 'capabilities', 'maxOutputTokens');
    return value !== undefined ? value.toLocaleString() : 'unset';
  }

  function summarizeThinkingFlags(entry: ModelRegistryEntry): string {
    const flags: string[] = [];
    if (boolFromContainer(entry, 'capabilities', 'supportsReasoning')) {
      flags.push('supports_reasoning');
    } else if (isRecord(entry.capabilities) && entry.capabilities.supportsReasoning === false) {
      flags.push('reasoning_off');
    }
    const tuning = isRecord(entry.tuning) ? entry.tuning : undefined;
    if (tuning && typeof tuning.reasoningEffort === 'string' && tuning.reasoningEffort.trim().length > 0) {
      flags.push(`effort:${tuning.reasoningEffort.trim()}`);
    }
    if (tuning && typeof tuning.thinkingFormat === 'string' && tuning.thinkingFormat.trim().length > 0) {
      flags.push(`format:${tuning.thinkingFormat.trim()}`);
    }
    return flags.length > 0 ? flags.join(', ') : 'none';
  }

  function toggleExpanded(modelId: string): void {
    const next = new Set(expandedModelIds);
    if (next.has(modelId)) {
      next.delete(modelId);
    } else {
      next.add(modelId);
    }
    expandedModelIds = next;
  }

  function createModelTemplate(): ModelRegistryEntry {
    const existingIds = new Set(models.map((entry) => entry.id));
    let suffix = 1;
    let nextId = `model-${suffix}`;
    while (existingIds.has(nextId)) {
      suffix += 1;
      nextId = `model-${suffix}`;
    }
    return {
      id: nextId,
      rank: 0,
      identity: {
        provider: '',
        model: '',
        source: {
          type: '',
        },
      },
      purposes: [],
      capabilities: {
        maxOutputTokens: 4096,
      },
    };
  }

  function applyDiscoveredMetadata(entry: ModelRegistryEntry, discovered: DiscoveredModel): ModelRegistryEntry {
    const autofill = deriveDiscoveryAutofill(discovered);
    entry.identity.model = discovered.id;
    if (autofill.provider) {
      entry.identity.provider = autofill.provider;
    }
    if (autofill.sourceType) {
      entry.identity.source.type = autofill.sourceType;
      entry.identity.source.label = entry.identity.source.label?.trim().length
        ? entry.identity.source.label
        : autofill.sourceType;
    }
    if (autofill.contextWindow !== undefined || autofill.maxOutputTokens !== undefined) {
      const capabilities = isRecord(entry.capabilities) ? { ...entry.capabilities } : {};
      if (autofill.contextWindow !== undefined) {
        capabilities.contextWindow = autofill.contextWindow;
      }
      if (autofill.maxOutputTokens !== undefined) {
        capabilities.maxOutputTokens = autofill.maxOutputTokens;
      }
      if (autofill.supportsVision === true) {
        capabilities.supportsVision = true;
      }
      if (autofill.supportsReasoning === true) {
        capabilities.supportsReasoning = true;
      }
      entry.capabilities = capabilities;
    } else if (autofill.supportsVision === true || autofill.supportsReasoning === true) {
      const capabilities = isRecord(entry.capabilities) ? { ...entry.capabilities } : {};
      if (autofill.supportsVision === true) {
        capabilities.supportsVision = true;
      }
      if (autofill.supportsReasoning === true) {
        capabilities.supportsReasoning = true;
      }
      entry.capabilities = capabilities;
    }
    if (autofill.maxOutputTokens !== undefined) {
      const tuning = isRecord(entry.tuning) ? { ...entry.tuning } : {};
      tuning.maxOutputTokens = autofill.maxOutputTokens;
      entry.tuning = tuning;
    }
    if (autofill.inputPer1MUsd !== undefined || autofill.outputPer1MUsd !== undefined) {
      const cost = isRecord(entry.cost) ? { ...entry.cost } : {};
      if (autofill.inputPer1MUsd !== undefined) {
        cost.inputPer1MUsd = autofill.inputPer1MUsd;
      }
      if (autofill.outputPer1MUsd !== undefined) {
        cost.outputPer1MUsd = autofill.outputPer1MUsd;
      }
      entry.cost = cost;
    }
    if (entry.purposes.length === 0) {
      const purposes: ModelRegistryPurposeTag[] = [{ purpose: 'chat', primary: false }];
      if (autofill.supportsReasoning === true) {
        purposes.push({ purpose: 'reasoning', primary: false });
      }
      if (autofill.supportsVision === true) {
        purposes.push({ purpose: 'vision', primary: false });
      }
      entry.purposes = purposes
        .filter((tag, index, array) => array.findIndex((candidate) => candidate.purpose === tag.purpose) === index)
        .sort((a, b) => CANONICAL_PURPOSES.indexOf(a.purpose) - CANONICAL_PURPOSES.indexOf(b.purpose));
    }
    return entry;
  }

  function addModel(): void {
    const nextModels = resequenceRanks([...models, createModelTemplate()]);
    models = nextModels;
    expandedModelIds = new Set([...expandedModelIds, nextModels[nextModels.length - 1].id]);
  }

  function addDiscoveredModel(discovered: DiscoveredModel): void {
    const existingIds = new Set(models.map((entry) => entry.id));
    const entry = applyDiscoveredMetadata(createModelTemplate(), discovered);
    entry.id = buildUniqueModelId(discovered.id, existingIds);

    const nextModels = resequenceRanks([...models, entry]);
    models = nextModels;
    expandedModelIds = new Set([...expandedModelIds, entry.id]);
    flashOk = true;
    flashMessage = `Added ${discovered.id} with discovery autofill.`;
  }

  function backfillExistingModelsFromDiscovery(discovered: readonly DiscoveredModel[]): number {
    let backfilled = 0;
    const nextModels = models.map((entry) => {
      const normalizedModel = entry.identity.model.trim();
      if (!normalizedModel) return entry;
      const matched = resolveDiscoveredModelSelection(normalizedModel, discovered);
      if (!matched) return entry;
      const cloned = cloneModelEntry(entry);
      if (!backfillDiscoveredMetadata(cloned, matched)) {
        return entry;
      }
      backfilled += 1;
      return cloned;
    });
    if (backfilled > 0) {
      models = nextModels;
    }
    return backfilled;
  }

  function removeModel(index: number): void {
    const target = models[index];
    if (!target) return;
    if (!confirm(`Remove model "${target.id}"?`)) return;
    models = resequenceRanks(models.filter((_, entryIndex) => entryIndex !== index));
    const nextExpanded = new Set(expandedModelIds);
    nextExpanded.delete(target.id);
    expandedModelIds = nextExpanded;
  }

  function moveEntry(entries: ModelRegistryEntry[], fromIndex: number, toIndex: number): ModelRegistryEntry[] {
    if (fromIndex === toIndex) return entries;
    const next = [...entries];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  }

  function handleDragStart(index: number): void {
    dragSourceIndex = index;
    dragOverIndex = index;
  }

  function handleDragOver(event: DragEvent, index: number): void {
    event.preventDefault();
    dragOverIndex = index;
  }

  function handleDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    if (dragSourceIndex === null) return;
    models = resequenceRanks(moveEntry(models, dragSourceIndex, index));
    dragSourceIndex = null;
    dragOverIndex = null;
  }

  function handleDragEnd(): void {
    dragSourceIndex = null;
    dragOverIndex = null;
  }

  function validateBeforeSave(entries: ModelRegistryEntry[], policy: ModelRegistryBudgetPolicy): string[] {
    const errors: string[] = [];
    if (entries.length === 0) {
      errors.push('At least one model is required.');
      return errors;
    }
    if (policy.dailyUsdLimit <= 0 || !Number.isFinite(policy.dailyUsdLimit)) {
      errors.push('Budget policy daily limit must be a positive number.');
    }
    if (policy.monthlyUsdLimit <= 0 || !Number.isFinite(policy.monthlyUsdLimit)) {
      errors.push('Budget policy monthly limit must be a positive number.');
    }
    if (policy.monthlyUsdLimit < policy.dailyUsdLimit) {
      errors.push('Budget policy monthly limit must be greater than or equal to the daily limit.');
    }

    const seenIds = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const id = entry.id.trim();
      if (!id) {
        errors.push(`Model #${index + 1} is missing "id".`);
      } else if (!MODEL_SLOT_KEY_PATTERN.test(id)) {
        errors.push(`Model "${id}" has invalid id; use only letters, numbers, dot, underscore, or hyphen.`);
      } else if (seenIds.has(id)) {
        errors.push(`Duplicate model id "${id}" is not allowed.`);
      } else {
        seenIds.add(id);
      }
      const providerId = entry.identity.provider.trim().toLowerCase();
      if (!providerId) {
        errors.push(`Model "${id || index + 1}" is missing provider.`);
      } else if (providerRegistry.providers.length > 0 && !providerEntriesById.has(providerId)) {
        errors.push(`Model "${id || index + 1}" references unknown provider "${providerId}".`);
      }
      if (!entry.identity.model.trim()) {
        errors.push(`Model "${id || index + 1}" is missing model name.`);
      }
      if (!entry.identity.source.type.trim()) {
        errors.push(`Model "${id || index + 1}" is missing source type.`);
      }
      const routingProviderOrder = entry.routing?.providerOrder ?? [];
      for (const routedProviderId of routingProviderOrder) {
        if (!providerEntriesById.has(routedProviderId)) {
          errors.push(`Model "${id || index + 1}" routes through unknown provider "${routedProviderId}".`);
        }
      }
      if (!Array.isArray(entry.purposes) || entry.purposes.length === 0) {
        errors.push(`Model "${id || index + 1}" must include at least one purpose tag.`);
      }
      const maxOutputTokens = numberFromContainer(entry, 'tuning', 'maxOutputTokens')
        ?? numberFromContainer(entry, 'capabilities', 'maxOutputTokens');
      if (maxOutputTokens === undefined || maxOutputTokens <= 0) {
        errors.push(`Model "${id || index + 1}" must define maxOutputTokens in capabilities or tuning.`);
      }
    }

    for (const purpose of CANONICAL_PURPOSES) {
      const primaryCount = entries.reduce((count, entry) => (
        count + (entry.purposes.some((tag) => tag.purpose === purpose && tag.primary) ? 1 : 0)
      ), 0);
      if (primaryCount !== 1) {
        errors.push(
          `Purpose "${purpose}" must have exactly one primary model before save (found ${primaryCount}).`,
        );
      }
    }
    return errors;
  }

  function serializeForSave(entries: ModelRegistryEntry[], policy: ModelRegistryBudgetPolicy): CanonicalModelRegistry {
    return {
      schemaVersion: 1,
      budgetPolicy: {
        enabled: policy.enabled === true,
        dailyUsdLimit: policy.dailyUsdLimit,
        monthlyUsdLimit: policy.monthlyUsdLimit,
        currency: 'USD',
      },
      models: resequenceRanks(entries).map((entry) => {
        const id = entry.id.trim();
        const identity = {
          ...entry.identity,
          provider: entry.identity.provider.trim().toLowerCase(),
          model: entry.identity.model.trim(),
          source: {
            ...entry.identity.source,
            type: entry.identity.source.type.trim(),
            ...(toNonEmptyString(entry.identity.source.label) ? { label: toNonEmptyString(entry.identity.source.label) } : {}),
            ...(toNonEmptyString(entry.identity.source.baseUrl) ? { baseUrl: toNonEmptyString(entry.identity.source.baseUrl) } : {}),
          },
          ...(toNonEmptyString(entry.identity.family) ? { family: toNonEmptyString(entry.identity.family) } : {}),
        };

        const normalizedPurposes = entry.purposes
          .filter((tag) => CANONICAL_PURPOSES.includes(tag.purpose))
          .map((tag) => ({ purpose: tag.purpose, primary: tag.primary === true }))
          .sort((a, b) => CANONICAL_PURPOSES.indexOf(a.purpose) - CANONICAL_PURPOSES.indexOf(b.purpose));

        const nextEntry: ModelRegistryEntry = {
          ...entry,
          id,
          identity,
          purposes: normalizedPurposes,
        };
        const normalizedRouting = normalizeRouting(entry.routing);
        if (normalizedRouting) {
          nextEntry.routing = normalizedRouting;
        } else {
          delete nextEntry.routing;
        }

        if (isRecord(nextEntry.capabilities) && Object.keys(nextEntry.capabilities).length === 0) {
          delete nextEntry.capabilities;
        }
        if (isRecord(nextEntry.tuning) && Object.keys(nextEntry.tuning).length === 0) {
          delete nextEntry.tuning;
        }
        if (isRecord(nextEntry.cost) && Object.keys(nextEntry.cost).length === 0) {
          delete nextEntry.cost;
        }
        if (isRecord(nextEntry.metadata) && Object.keys(nextEntry.metadata).length === 0) {
          delete nextEntry.metadata;
        }
        return nextEntry;
      }),
    };
  }

  async function loadPageData(): Promise<void> {
    error = '';
    discoveryError = '';
    validationErrors = [];
    const [modelsRaw, providersRaw] = await Promise.all([
      getModelsConfigRaw(),
      getProvidersConfigRaw(),
    ]);
    let discovered: DiscoveredModel[] = [];
    try {
      discovered = await listDiscoveredModels();
    } catch (discoveryLoadError) {
      discovered = [];
      discoveryError = toErrorMessage(discoveryLoadError, 'Model discovery unavailable');
    }
    const registry = parseModelRegistryJson(modelsRaw);
    models = registry.models;
    budgetPolicy = registry.budgetPolicy ?? { ...DEFAULT_BUDGET_POLICY };
    discoveredModels = discovered;
    setProviderRegistryState(parseProviderRegistryJson(providersRaw));
    initialSnapshot = JSON.stringify({
      models,
      budgetPolicy,
      providerRegistry,
    });
  }

  async function refreshDiscovery(): Promise<void> {
    refreshingDiscovery = true;
    try {
      await refreshDiscoveredModels();
      discoveredModels = await listDiscoveredModels();
      const backfilledCount = backfillExistingModelsFromDiscovery(discoveredModels);
      discoveryError = '';
      flashOk = true;
      flashMessage = backfilledCount > 0
        ? `Discovered ${discoveredModels.length} model(s); backfilled ${backfilledCount} existing registry entr${backfilledCount === 1 ? 'y' : 'ies'}.`
        : `Discovered ${discoveredModels.length} model(s).`;
    } catch (refreshError) {
      discoveredModels = [];
      discoveryError = toErrorMessage(refreshError, 'Model discovery unavailable');
      flashOk = false;
      flashMessage = discoveryError;
    } finally {
      refreshingDiscovery = false;
    }
  }

  async function saveModels(): Promise<void> {
    validationErrors = [];
    if (budgetFormInvalid) {
      validationErrors = [budgetInlineError];
      flashOk = false;
      flashMessage = 'Cannot save models until budget policy errors are fixed.';
      return;
    }
    const issues = validateBeforeSave(models, budgetPolicy);
    if (issues.length > 0) {
      validationErrors = issues;
      flashOk = false;
      const extra = issues.length > 1 ? ` (+${issues.length - 1} more)` : '';
      flashMessage = `Cannot save: ${issues[0]}${extra}`;
      return;
    }

    saving = true;
    try {
      const payload = serializeForSave(models, budgetPolicy);
      await saveModelsConfigRaw(JSON.stringify(payload, null, 2));
      await loadPageData();
      flashOk = true;
      flashMessage = 'models.json saved';
    } catch (saveError) {
      flashOk = false;
      if (saveError instanceof ApiError) {
        const detail = parseApiErrorDetail(saveError);
        flashMessage = detail ?? `Failed to save models (${saveError.status} ${saveError.statusText})`;
        if (detail) {
          validationErrors = [detail];
        }
      } else {
        flashMessage = saveError instanceof Error ? saveError.message : 'Failed to save models';
      }
    } finally {
      saving = false;
    }
  }

  onMount(async () => {
    loading = true;
    try {
      await loadPageData();
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Failed to load model configuration';
    } finally {
      loading = false;
    }
  });
</script>

<datalist id="discovered-model-list">
  {#each discoveredModels as model}
    <option value={model.id}>{model.description ?? model.id}</option>
  {/each}
</datalist>

<datalist id="provider-id-list">
  {#each providerRegistry.providers as provider}
    <option value={provider.id}>{providerLabel(provider)}</option>
  {/each}
</datalist>

<datalist id="provider-type-list">
  {#each providerTypeOptions as providerType}
    <option value={providerType}></option>
  {/each}
</datalist>

<div class="space-y-5">
  <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">The Conservatory</h1>
      <p class="text-sm text-shadow-600 mt-1">Canonical model management for routing, capabilities, and tuning</p>
    </div>
    <div class="flex items-center gap-3">
      {#if dirty}
        <span class="px-2.5 py-1 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">
          Unsaved changes
        </span>
      {/if}
      <button
        onclick={refreshDiscovery}
        disabled={refreshingDiscovery || loading}
        class="px-3 py-1.5 text-sm font-medium rounded-lg border border-bark-300 text-shadow-700 hover:bg-bark-100 disabled:opacity-50 transition-colors"
      >
        {refreshingDiscovery ? 'Refreshing...' : 'Refresh Discovery'}
      </button>
      <button
        onclick={saveModels}
        disabled={saving || loading || budgetFormInvalid}
        class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving...' : 'Save models.json'}
      </button>
    </div>
  </div>

  <div class="card-garden p-4 text-sm text-shadow-700">
    Model config is JSON-owned in <span class="font-mono">models.json</span>. Secrets stay in environment variables and are not edited here
    (for example <span class="font-mono">OPENROUTER_API_KEY</span> and <span class="font-mono">LITELLM_API_KEY</span>).
  </div>

  <div class="card-garden p-4 space-y-3">
    <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
      <div>
        <h2 class="text-sm font-serif font-semibold text-shadow-800">Provider Wiring</h2>
        <p class="text-sm text-shadow-600">Models target canonical provider ids from <span class="font-mono">providers.json</span>. Manage LiteLLM, OpenRouter, and direct provider endpoints here instead of hunting through Settings.</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-full border border-bark-300 bg-bark-100 px-3 py-1 text-sm text-shadow-700">
          {providerRegistry.providers.filter(providerIsEnabled).length} enabled / {providerRegistry.providers.length} total
        </span>
        <a
          href={`${base}/settings#settings-providers`}
          class="inline-flex items-center rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm font-medium text-shadow-700 hover:bg-bark-100 transition-colors"
        >
          Open Settings Mirror
        </a>
        <button
          onclick={addProviderEntry}
          type="button"
          class="inline-flex items-center rounded-lg border border-gold-400 bg-gold-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-gold-100 transition-colors"
        >
          Add Provider
        </button>
      </div>
    </div>
    {#if providerValidationErrors.length > 0}
      <div class="rounded-2xl border border-wilt-300 bg-wilt-50/60 p-4 space-y-2">
        <h3 class="text-sm font-medium text-wilt-700">Provider validation</h3>
        <ul class="space-y-1 text-sm text-wilt-700">
          {#each providerValidationErrors as issue}
            <li>{issue}</li>
          {/each}
        </ul>
      </div>
    {/if}
    <div class="space-y-4">
      {#each providerRegistry.providers as entry, index (entry.id)}
        <article class="rounded-2xl border border-bark-300 bg-white/90 p-4 space-y-4">
          <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full border px-2.5 py-1 text-xs font-medium {providerIsEnabled(entry) ? 'border-moss-300 bg-moss-50 text-moss-700' : 'border-bark-300 bg-bark-100 text-shadow-600'}">
                  {providerIsEnabled(entry) ? 'enabled' : 'disabled'}
                </span>
                <span class="rounded-full border border-bark-300 bg-bark-100 px-2.5 py-1 text-xs font-medium text-shadow-700">
                  {PROVIDER_TYPE_LABELS[entry.type]}
                </span>
                {#each providerRuntimeRole(entry) as role}
                  <span class="rounded-full border border-gold-300 bg-gold-50 px-2.5 py-1 text-xs text-gold-800">{role}</span>
                {/each}
              </div>
              <p class="text-sm text-shadow-600">{providerTypeSummary(entry.type)}</p>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <label class="inline-flex items-center gap-2 text-sm text-shadow-700">
                <input
                  type="checkbox"
                  checked={providerIsEnabled(entry)}
                  onchange={(event) => updateProviderEntry(index, (nextEntry) => ({
                    ...nextEntry,
                    enabled: (event.currentTarget as HTMLInputElement).checked,
                  }))}
                  class="rounded border-bark-300 text-gold-600 focus:ring-gold-500"
                />
                Enabled
              </label>
              <button
                onclick={() => removeProviderEntry(index)}
                type="button"
                class="inline-flex items-center rounded-lg border border-wilt-300 px-3 py-1.5 text-sm font-medium text-wilt-600 hover:bg-wilt-50 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label for={`provider-id-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Provider Id</label>
              <input
                id={`provider-id-${index}`}
                type="text"
                value={entry.id}
                oninput={(event) => setProviderField(index, 'id', (event.currentTarget as HTMLInputElement).value)}
                class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
                placeholder="openrouter"
              />
            </div>
            <div>
              <label for={`provider-type-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Provider Type</label>
              <select
                id={`provider-type-${index}`}
                value={entry.type}
                onchange={(event) => setProviderType(index, (event.currentTarget as HTMLSelectElement).value)}
                class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
              >
                {#each PROVIDER_TYPES as type}
                  <option value={type}>{PROVIDER_TYPE_LABELS[type]}</option>
                {/each}
              </select>
            </div>
            <div>
              <label for={`provider-label-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Label</label>
              <input
                id={`provider-label-${index}`}
                type="text"
                value={entry.label ?? ''}
                oninput={(event) => setProviderField(index, 'label', (event.currentTarget as HTMLInputElement).value)}
                class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
                placeholder="LiteLLM primary"
              />
            </div>
            <div>
              <label for={`provider-api-base-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">API Base URL</label>
              <input
                id={`provider-api-base-${index}`}
                type="text"
                value={entry.apiBaseUrl ?? ''}
                oninput={(event) => setProviderField(index, 'apiBaseUrl', (event.currentTarget as HTMLInputElement).value)}
                class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
                placeholder="https://..."
              />
            </div>
            <div>
              <label for={`provider-models-api-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">Models API URL</label>
              <input
                id={`provider-models-api-${index}`}
                type="text"
                value={entry.modelsApiUrl ?? ''}
                oninput={(event) => setProviderField(index, 'modelsApiUrl', (event.currentTarget as HTMLInputElement).value)}
                class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none disabled:bg-bark-100"
                placeholder={providerSupportsModelsApi(entry.type) ? 'https://.../models' : 'Only used for LiteLLM/OpenRouter catalogs'}
                disabled={!providerSupportsModelsApi(entry.type)}
              />
            </div>
            <div>
              <label for={`provider-api-key-env-${index}`} class="block text-sm font-medium text-shadow-700 mb-1.5">API Key Ref</label>
              <input
                id={`provider-api-key-env-${index}`}
                type="text"
                value={entry.apiKeyRef?.kind === 'env' ? entry.apiKeyRef.envName : ''}
                oninput={(event) => setProviderField(index, 'apiKeyRef', (event.currentTarget as HTMLInputElement).value)}
                class="w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
                placeholder="LITELLM_API_KEY"
              />
            </div>
          </div>
        </article>
      {/each}
    </div>
    {#if providerRegistry.providers.length === 0}
      <div class="rounded-2xl border border-dashed border-bark-300 bg-bark-50/60 p-5 text-sm text-shadow-600">
        No providers configured yet. Add LiteLLM, OpenRouter, or direct backend providers here before wiring models.
      </div>
    {/if}
    <div class="flex flex-wrap items-center gap-3 pt-1">
      <button
        onclick={saveProviderRegistry}
        disabled={saving || !providerRegistryDirty()}
        class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
      >
        {saving ? 'Saving...' : 'Save providers.json'}
      </button>
      <button
        onclick={discardProviderRegistryChanges}
        disabled={!providerRegistryDirty() || saving}
        class="px-4 py-2 rounded-lg border border-bark-300 bg-white text-sm font-medium text-shadow-700 hover:bg-bark-100 disabled:opacity-50 transition-colors"
      >
        Discard
      </button>
      {#if providerRegistryDirty()}
        <span class="text-sm text-shadow-500">Provider changes are saved separately from models.json and take effect through canonical provider ids.</span>
      {/if}
    </div>
  </div>

  <div class="card-garden p-4 space-y-3">
    <div class="flex flex-wrap gap-2">
      {#each CANONICAL_PURPOSES as purpose}
        {@const count = purposePrimaryCounts[purpose] ?? 0}
        <span class="px-2.5 py-1 rounded-full text-sm border {count === 1 ? 'bg-moss-50 border-moss-300 text-moss-700' : 'bg-wilt-50 border-wilt-300 text-wilt-600'}">
          {PURPOSE_LABELS[purpose]} primary: {count}
        </span>
      {/each}
    </div>
    <p class="text-sm text-shadow-600">Each purpose must have exactly one primary model before save. The memory recall purpose is the dedicated model route for memory retrieval, synthesis, and improvement work. Purpose chips cycle off → standard → primary.</p>
  </div>

  <div class="card-garden p-4 space-y-3">
    <h2 class="text-sm font-serif font-semibold text-shadow-800">Budget Policy (USD)</h2>
    <div class="flex flex-col gap-3">
      <label class="inline-flex items-center gap-2 text-sm text-shadow-700">
        <input
          type="checkbox"
          checked={budgetPolicy.enabled}
          onchange={(event) => setBudgetPolicyEnabled((event.currentTarget as HTMLInputElement).checked)}
          class="rounded border-bark-300 text-gold-600 focus:ring-gold-500"
        />
        Budget gating enabled
      </label>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="text-sm text-shadow-700">
          Daily limit (USD)
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputmode="decimal"
            value={budgetPolicy.dailyUsdLimit}
            oninput={(event) => setBudgetPolicyLimit('dailyUsdLimit', (event.currentTarget as HTMLInputElement).value)}
            class="mt-1 w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
          />
          <input
            type="range"
            min="1"
            max={dailyBudgetSliderMax}
            step="1"
            value={dailyBudgetSliderValue}
            oninput={(event) => setBudgetPolicyLimit('dailyUsdLimit', (event.currentTarget as HTMLInputElement).value)}
            class="mt-2 w-full accent-gold-600"
          />
          <span class="mt-1 block text-xs text-shadow-500">Quick adjust: $1 to ${dailyBudgetSliderMax}</span>
        </label>
        <label class="text-sm text-shadow-700">
          Monthly limit (USD)
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputmode="decimal"
            value={budgetPolicy.monthlyUsdLimit}
            oninput={(event) => setBudgetPolicyLimit('monthlyUsdLimit', (event.currentTarget as HTMLInputElement).value)}
            class="mt-1 w-full rounded border border-bark-300 bg-white px-2 py-1 text-sm focus:border-gold-400 focus:outline-none"
          />
          <input
            type="range"
            min="1"
            max={monthlyBudgetSliderMax}
            step="1"
            value={monthlyBudgetSliderValue}
            oninput={(event) => setBudgetPolicyLimit('monthlyUsdLimit', (event.currentTarget as HTMLInputElement).value)}
            class="mt-2 w-full accent-gold-600"
          />
          <span class="mt-1 block text-xs text-shadow-500">Quick adjust: $1 to ${monthlyBudgetSliderMax}</span>
        </label>
      </div>
    </div>
    <p class="text-sm text-shadow-600">
      Budget policy is saved to <span class="font-mono">models.json</span> and enforced on both completion and stream routing paths.
    </p>
    {#if budgetInlineError}
      <p class="text-sm text-wilt-700">{budgetInlineError}</p>
    {/if}
  </div>

  {#if flashMessage}
    <div class="px-4 py-2.5 rounded-lg text-sm font-medium {flashOk ? 'bg-moss-50 text-moss-700 border border-moss-300' : 'bg-wilt-50 text-wilt-600 border border-wilt-300'}">
      {flashMessage}
    </div>
  {/if}

  {#if validationErrors.length > 0}
    <div class="card-garden p-4 border border-wilt-300 bg-wilt-50/40">
      <h2 class="text-sm font-semibold text-wilt-700 mb-2">Validation errors</h2>
      <ul class="space-y-1 text-sm text-wilt-700">
        {#each validationErrors as issue}
          <li>{issue}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if loading}
    <div class="card-garden p-8">
      <div class="animate-pulse space-y-3">
        {#each Array(4) as _}
          <div class="h-16 rounded-lg bg-bark-200"></div>
        {/each}
      </div>
    </div>
  {:else if error}
    <div class="card-garden p-6 text-sm text-wilt-600">{error}</div>
  {:else}
    <div class="space-y-4">
      <section class="card-garden p-4 space-y-3" aria-labelledby="discovered-models-heading">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 id="discovered-models-heading" class="text-sm font-serif font-semibold text-shadow-800">Discovered Models</h2>
            <p class="text-sm text-shadow-600 mt-1">
              Discovery uses OpenRouter model metadata. ZDR tags come from OpenRouter endpoint metadata.
            </p>
          </div>
          <div class="w-full lg:w-80">
            <label class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1" for="discovered-model-search">
              Search
            </label>
            <input
              id="discovered-model-search"
              type="search"
              value={discoverySearch}
              oninput={(event) => {
                discoverySearch = (event.currentTarget as HTMLInputElement).value;
              }}
              class="w-full rounded border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-800"
              placeholder="model, provider, vision, zdr"
            />
          </div>
        </div>
        {#if discoveryError}
          <p class="text-sm text-wilt-600">{discoveryError}</p>
        {/if}
        {#if discoveredModels.length === 0}
          <p class="text-sm text-shadow-500">No models discovered yet.</p>
        {:else if filteredDiscoveredModels.length === 0}
          <p class="text-sm text-shadow-500">No discovered models match the current search.</p>
        {:else}
          <div class="overflow-x-auto pb-1">
            <div class="flex min-w-full gap-3">
              {#each filteredDiscoveredModels as discovered}
                <article class="min-w-[18rem] max-w-[22rem] rounded-lg border border-bark-200 bg-bark-50 px-3 py-2">
                  <div class="flex items-start justify-between gap-2">
                    <p class="font-mono text-xs text-shadow-800 break-all">{discovered.id}</p>
                    {#if discovered.zdrAvailable}
                      <span class="shrink-0 rounded-full border border-moss-300 bg-moss-50 px-2 py-0.5 text-[11px] font-semibold text-moss-700">
                        ZDR {discovered.zdrEndpointCount ?? 1}
                      </span>
                    {:else}
                      <span class="shrink-0 rounded-full border border-wilt-200 bg-wilt-50 px-2 py-0.5 text-[11px] font-semibold text-wilt-600">
                        no ZDR
                      </span>
                    {/if}
                  </div>
                  {#if discovered.description}
                    <p class="mt-1 line-clamp-2 text-xs text-shadow-600">{discovered.description}</p>
                  {/if}
                  <div class="mt-2 flex flex-wrap gap-1.5">
                    {#if discovered.supportsVision}
                      <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-[11px] text-shadow-600">vision</span>
                    {/if}
                    {#if discovered.supportsReasoning}
                      <span class="rounded-full border border-bark-300 bg-white px-2 py-0.5 text-[11px] text-shadow-600">reasoning</span>
                    {/if}
                    {#if discovered.zdrAvailable}
                      <span class="rounded-full border border-moss-200 bg-white px-2 py-0.5 text-[11px] text-moss-700">
                        {discoveryZdrProviderSummary(discovered)}
                      </span>
                    {/if}
                  </div>
                  <p class="mt-2 text-xs text-shadow-500">{discoveryLimitSummary(discovered)}</p>
                  <button
                    onclick={() => addDiscoveredModel(discovered)}
                    class="mt-3 px-2.5 py-1 text-xs font-medium rounded border border-gold-400 text-gold-700 hover:bg-gold-100 transition-colors"
                  >
                    + Add + Autofill
                  </button>
                </article>
              {/each}
            </div>
          </div>
        {/if}
      </section>

      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-serif font-semibold text-shadow-800">Model Registry</h2>
          <button
            onclick={addModel}
            class="px-3 py-1.5 text-sm font-medium rounded border border-gold-400 text-gold-700 hover:bg-gold-50 transition-colors"
          >
            + Add Model
          </button>
        </div>

        {#each models as entry, index (entry.id)}
          {@const isExpanded = expandedModelIds.has(entry.id)}
          {@const currentDragOver = dragOverIndex === index}
          <article
            draggable="true"
            ondragstart={() => handleDragStart(index)}
            ondragover={(event) => handleDragOver(event, index)}
            ondrop={(event) => handleDrop(event, index)}
            ondragend={handleDragEnd}
            class="card-garden overflow-hidden border {currentDragOver ? 'border-gold-400' : 'border-bark-300'}"
          >
            <div class="px-4 py-3 space-y-3">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="space-y-2 min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="text-shadow-400 cursor-grab" title="Drag to reorder">⋮⋮</span>
                    <input
                      type="text"
                      value={entry.id}
                      onchange={(event) => updateModelAt(index, (nextEntry) => {
                        nextEntry.id = (event.target as HTMLInputElement).value;
                        return nextEntry;
                      })}
                      class="px-2 py-1 rounded border border-bark-300 text-sm font-mono text-shadow-800 bg-white"
                    />
                    <span class="px-2 py-0.5 rounded-full text-xs bg-bark-100 text-shadow-600 border border-bark-300">rank {entry.rank}</span>
                  </div>
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 text-sm">
                    <div class="rounded-lg border border-bark-200 bg-bark-50 px-2 py-1.5">
                      <p class="text-shadow-500 text-xs">model</p>
                      <p class="font-mono text-shadow-800 truncate">{entry.identity.model || 'unset'}</p>
                    </div>
                    <div class="rounded-lg border border-bark-200 bg-bark-50 px-2 py-1.5">
                      <p class="text-shadow-500 text-xs">provider / source</p>
                      <p class="font-mono text-shadow-800 truncate">{entry.identity.provider || 'unset'} / {entry.identity.source.type || 'unset'}</p>
                    </div>
                    <div class="rounded-lg border border-bark-200 bg-bark-50 px-2 py-1.5">
                      <p class="text-shadow-500 text-xs">max context</p>
                      <p class="font-mono text-shadow-800">{maxContext(entry)}</p>
                    </div>
                    <div class="rounded-lg border border-bark-200 bg-bark-50 px-2 py-1.5">
                      <p class="text-shadow-500 text-xs">max response</p>
                      <p class="font-mono text-shadow-800">{maxResponse(entry)}</p>
                    </div>
                    <div class="rounded-lg border border-bark-200 bg-bark-50 px-2 py-1.5">
                      <p class="text-shadow-500 text-xs">thinking flags</p>
                      <p class="font-mono text-shadow-800 truncate">{summarizeThinkingFlags(entry)}</p>
                    </div>
                  </div>
                  <div class="rounded-lg border border-moss-200 bg-moss-50 px-3 py-2 text-sm">
                    <p class="text-xs font-semibold uppercase tracking-[0.12em] text-moss-700">Memory model purpose</p>
                    <p class="mt-1 text-moss-800">
                      {purposeState(entry, 'memory') === 'primary'
                        ? 'Primary memory recall model'
                        : (purposeState(entry, 'memory') === 'standard'
                          ? 'Eligible for memory recall'
                          : 'Not assigned to memory recall')}
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <button
                    onclick={() => toggleExpanded(entry.id)}
                    class="px-3 py-1.5 text-sm rounded border border-bark-300 text-shadow-700 hover:bg-bark-100 transition-colors"
                  >
                    {isExpanded ? 'Hide Advanced' : 'Advanced'}
                  </button>
                  <button
                    onclick={() => removeModel(index)}
                    class="px-3 py-1.5 text-sm rounded border border-wilt-300 text-wilt-600 hover:bg-wilt-50 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <div class="flex flex-wrap gap-2">
                {#each CANONICAL_PURPOSES as purpose}
                  {@const state = purposeState(entry, purpose)}
                  <button
                    onclick={() => cyclePurposeTag(index, purpose)}
                    class="px-2.5 py-1 rounded-full border text-xs font-medium transition-colors
                      {state === 'primary'
                        ? 'bg-gold-100 border-gold-400 text-gold-800'
                        : (state === 'standard'
                          ? 'bg-moss-50 border-moss-300 text-moss-700'
                          : 'bg-white border-bark-300 text-shadow-600 hover:bg-bark-100')}"
                    title="Cycle: off → standard → primary"
                  >
                    {PURPOSE_LABELS[purpose]}{state === 'primary' ? ' ★' : ''}
                  </button>
                {/each}
              </div>
            </div>

            {#if isExpanded}
              <div class="px-4 pb-4 border-t border-bark-300 pt-4 space-y-4">
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Provider</p>
                    <input
                      type="text"
                      list="provider-id-list"
                      value={entry.identity.provider}
                      onchange={(event) => setIdentityField(index, 'provider', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                    <p class="mt-1 text-xs text-shadow-500">
                      {providerAvailability(providerForModel(entry))}{#if providerForModel(entry)} · {providerLabel(providerForModel(entry))}{/if}
                    </p>
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Model</p>
                    <input
                      type="text"
                      list="discovered-model-list"
                      value={entry.identity.model}
                      oninput={(event) => setIdentityField(index, 'model', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Family (optional)</p>
                    <input
                      type="text"
                      value={entry.identity.family ?? ''}
                      onchange={(event) => setIdentityField(index, 'family', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800"
                    />
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Source Type</p>
                    <input
                      type="text"
                      list="provider-type-list"
                      value={entry.identity.source.type}
                      onchange={(event) => setSourceField(index, 'type', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Source Label (optional)</p>
                    <input
                      type="text"
                      value={entry.identity.source.label ?? ''}
                      onchange={(event) => setSourceField(index, 'label', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800"
                    />
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Source Base URL (optional)</p>
                    <input
                      type="text"
                      value={entry.identity.source.baseUrl ?? ''}
                      onchange={(event) => setSourceField(index, 'baseUrl', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                  <div class="md:col-span-2 xl:col-span-3">
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Routing Provider Order</p>
                    <input
                      type="text"
                      value={routingProviderOrderValue(entry)}
                      onchange={(event) => setRoutingProviderOrder(index, (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                      placeholder="comma-separated provider ids for fallback routing"
                    />
                    <div class="mt-2 flex flex-wrap gap-2">
                      {#each enabledProviders as provider}
                        {@const selected = entry.routing?.providerOrder?.includes(provider.id) ?? false}
                        <button
                          type="button"
                          onclick={() => toggleRoutingProvider(index, provider.id)}
                          class="rounded-full border px-2.5 py-1 text-xs font-medium transition-colors {selected ? 'border-gold-400 bg-gold-100 text-gold-800' : 'border-bark-300 bg-white text-shadow-600 hover:bg-bark-100'}"
                        >
                          {provider.id}
                        </button>
                      {/each}
                    </div>
                    <p class="mt-1 text-xs text-shadow-500">Optional per-slot provider fallback order written to <span class="font-mono">routing.providerOrder</span>.</p>
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Capabilities: Context Window</p>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={numberFromContainer(entry, 'capabilities', 'contextWindow') ?? ''}
                      onchange={(event) => setContainerNumber(index, 'capabilities', 'contextWindow', (event.target as HTMLInputElement).value, true)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Capabilities: Max Output Tokens</p>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={numberFromContainer(entry, 'capabilities', 'maxOutputTokens') ?? ''}
                      onchange={(event) => setContainerNumber(index, 'capabilities', 'maxOutputTokens', (event.target as HTMLInputElement).value, true)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Tuning: Max Output Tokens</p>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={numberFromContainer(entry, 'tuning', 'maxOutputTokens') ?? ''}
                      onchange={(event) => setContainerNumber(index, 'tuning', 'maxOutputTokens', (event.target as HTMLInputElement).value, true)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {#each CAPABILITY_BOOLEAN_FIELDS as field}
                    <label class="inline-flex items-center gap-2 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-700">
                      <input
                        type="checkbox"
                        checked={boolFromContainer(entry, 'capabilities', field.key)}
                        onchange={(event) => setContainerBoolean(index, 'capabilities', field.key, (event.target as HTMLInputElement).checked)}
                        class="w-4 h-4 rounded border-bark-400 text-gold-600 focus:ring-gold-300"
                      />
                      <span>{field.label}</span>
                    </label>
                  {/each}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {#each TUNING_NUMBER_FIELDS as field}
                    <div>
                      <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">{field.label}</p>
                      <input
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={numberFromContainer(entry, 'tuning', field.key) ?? ''}
                        onchange={(event) => setContainerNumber(index, 'tuning', field.key, (event.target as HTMLInputElement).value, field.integer)}
                        class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                      />
                    </div>
                  {/each}
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Cost Input / 1M (USD)</p>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={numberFromContainer(entry, 'cost', 'inputPer1MUsd') ?? ''}
                      onchange={(event) => setContainerNumber(index, 'cost', 'inputPer1MUsd', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                  <div>
                    <p class="block text-xs font-semibold uppercase tracking-[0.12em] text-shadow-500 mb-1">Cost Output / 1M (USD)</p>
                    <input
                      type="number"
                      min="0"
                      step="0.000001"
                      value={numberFromContainer(entry, 'cost', 'outputPer1MUsd') ?? ''}
                      onchange={(event) => setContainerNumber(index, 'cost', 'outputPer1MUsd', (event.target as HTMLInputElement).value)}
                      class="w-full px-3 py-2 rounded border border-bark-300 bg-white text-sm text-shadow-800 font-mono"
                    />
                  </div>
                </div>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    </div>
  {/if}
</div>
