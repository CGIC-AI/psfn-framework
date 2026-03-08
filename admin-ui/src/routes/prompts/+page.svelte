<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listPrompts,
    getConstitutionSnapshot,
    saveConstitutionMutableLayers,
    createPromptLayer,
    getPromptDetail,
    updatePrompt,
    togglePrompt,
    rollbackPrompt,
    getPromptDiff,
  } from '$lib/api/endpoints/prompts';
  import { apiPost } from '$lib/api/client';
  import type {
    PromptLayer,
    PromptRegistryEntry,
    AdminPromptDetailData,
    PromptHistoryEntry,
    PromptDiffResult,
    PromptUpdateResult,
    ConstitutionSnapshotData,
    ConstitutionCompanionLayer,
    ConstitutionImmutableBlock,
    ConstitutionMutableLayer,
  } from '$lib/types';

  // ── Structured prompt constants ──
  const STRUCTURED_SECTION_KEYS = [
    'description', 'personality', 'system_prompt',
    'post_history_instructions', 'scenario', 'mes_example', 'first_mes',
  ] as const;

  type StructuredSectionKey = typeof STRUCTURED_SECTION_KEYS[number];

  const SECTION_LABELS: Record<StructuredSectionKey, string> = {
    description: 'Description',
    personality: 'Personality',
    system_prompt: 'System Prompt',
    post_history_instructions: 'Post-History Instructions',
    scenario: 'Scenario',
    mes_example: 'Message Example',
    first_mes: 'First Message',
  };

  const SECTION_ROWS: Record<StructuredSectionKey, number> = {
    description: 4,
    personality: 4,
    system_prompt: 7,
    post_history_instructions: 4,
    scenario: 4,
    mes_example: 7,
    first_mes: 4,
  };

  // ── Macro catalog ──
  const MACROS = [
    { token: '{{current_datetime}}', alias: '{{now()}}', desc: 'Current UTC datetime in ISO-8601 format.', example: '2026-02-21T13:20:11.123Z' },
    { token: '{{current_date}}', alias: null, desc: 'Current UTC calendar date.', example: '2026-02-21' },
    { token: '{{current_time}}', alias: null, desc: 'Current UTC time.', example: '13:20:11Z' },
    { token: '{{unix_timestamp}}', alias: null, desc: 'Current Unix epoch timestamp in seconds.', example: '1769020811' },
    { token: '{{user}}', alias: null, desc: 'Current author/user display name from runtime context.', example: 'PrimaryUser' },
    { token: '{{char}}', alias: null, desc: 'Character/assistant name from runtime context.', example: 'Companion' },
    { token: '{{description}}', alias: '{{character.description}}', desc: 'Character card description field.', example: 'A new companion identity waiting to be customized.' },
    { token: '{{personality}}', alias: '{{character.personality}}', desc: 'Character card personality field.', example: 'A blank starter personality.' },
    { token: '{{scenario}}', alias: '{{character.scenario}}', desc: 'Character card scenario field.', example: '{{user}} and {{char}} are chatting.' },
    { token: '{{system_prompt}}', alias: '{{character.system_prompt}}', desc: 'Character card system prompt field.', example: 'Use clear language and stay grounded.' },
    { token: '{{mes_example}}', alias: '{{character.mes_example}}', desc: 'Character card dialogue example field.', example: 'Example dialogue style:\\n{{user}}: Hi\\n{{char}}: Hey there!' },
    { token: '{{post_history_instructions}}', alias: '{{character.post_history_instructions}}', desc: 'Character card post-history instructions field.', example: 'Stay concise and ask focused questions when needed.' },
    { token: '{{channel_id}}', alias: null, desc: 'Resolved channel/session identifier.', example: 'discord:dm:123456789' },
    { token: '{{channel_type}}', alias: null, desc: 'Resolved channel type.', example: 'discord_text' },
    { token: '{{trust_level}}', alias: null, desc: 'Current trust tier for the author/context.', example: 'primary' },
    { token: '{{model}}', alias: null, desc: 'Current active model identifier.', example: 'moonshotai/kimi-k2.5' },
  ];

  // ── Layer type badge colors ──
  const LAYER_BADGE: Record<string, { bg: string; text: string; label: string }> = {
    base:     { bg: 'bg-[#8B6914]', text: 'text-white', label: 'BASE' },
    operator: { bg: 'bg-[#4A7C59]', text: 'text-white', label: 'OPERATOR' },
    runtime:  { bg: 'bg-[#4A5C8B]', text: 'text-white', label: 'RUNTIME' },
    channel:  { bg: 'bg-[#6C5B7B]', text: 'text-white', label: 'CHANNEL' },
    task:     { bg: 'bg-[#C44569]', text: 'text-white', label: 'TASK' },
  };

  const STATIC_BADGE = { bg: 'bg-[#8B7355]', text: 'text-white', label: 'STATIC' };

  // ── Runtime marker definitions ──
  interface RuntimeMarker {
    id: string;
    label: string;
    description: string;
    afterType: string; // Insert after last layer of this type
    afterPriority?: number;
  }

  const RUNTIME_MARKERS: RuntimeMarker[] = [
    { id: 'runtime-context', label: 'RUNTIME CONTEXT', description: 'buildRuntimeContext() injects date/time, channel/visibility, user/trust, active model info', afterType: 'operator' },
    { id: 'persona-adaptation', label: 'PERSONA ADAPTATION', description: 'Trust-tier persona hints (honne/tatemae) injected based on current user trust level', afterType: 'runtime' },
    { id: 'memory-retrieval', label: 'MEMORY RETRIEVAL', description: 'L2 memory query results injected based on conversation context and trust-gated retrieval', afterType: 'runtime' },
    { id: 'chat-history', label: 'CHAT HISTORY', description: 'Session messages from JSONL store, including cross-channel continuity and compaction summaries', afterType: 'channel' },
  ];

  // ── State ──
  let layers = $state<PromptLayer[]>([]);
  let staticPrompts = $state<PromptRegistryEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let constitutionLoading = $state(true);
  let constitutionSaving = $state(false);
  let constitutionError = $state('');
  let constitutionSaveMessage = $state('');
  let showConstitutionSection = $state(true);
  let constitutionImmutableBlocks = $state<ConstitutionImmutableBlock[]>([]);
  let constitutionCompanionLayer = $state<ConstitutionCompanionLayer | null>(null);
  let constitutionMutableLayers = $state<ConstitutionMutableLayer[]>([]);
  let constitutionServerPreview = $state('');

  // Inline expansion state — which layer/static is expanded
  let expandedLayerId = $state<string | null>(null);
  let detailData = $state<AdminPromptDetailData | null>(null);
  let detailLoading = $state(false);

  // Content editing state
  let editingContent = $state(false);
  let editSections = $state<Record<StructuredSectionKey, string>>({
    description: '', personality: '', system_prompt: '',
    post_history_instructions: '', scenario: '', mes_example: '', first_mes: '',
  });
  let editRawContent = $state('');
  let isStructured = $state(false);
  let savingContent = $state(false);
  let saveMessage = $state('');

  // Metadata editing within inline edit
  let editName = $state('');
  let editIdentifier = $state('');
  let editRole = $state('');
  let editPromptOrder = $state<number | undefined>(undefined);

  // Rollback
  let rollingBack = $state(false);

  // Diff
  let showDiff = $state(false);
  let diffData = $state<PromptDiffResult | null>(null);
  let diffLoading = $state(false);

  // Static prompt expansion
  let expandedStatic = $state<string | null>(null);

  // Section toggles
  let showMacroCatalog = $state(false);
  let showStaticSection = $state(true);

  // Drag state
  let dragSourceIdx = $state<number | null>(null);
  let dragOverIdx = $state<number | null>(null);
  let isDragging = $state(false);

  // Toast
  let toastMessage = $state('');
  let toastTimeout: ReturnType<typeof setTimeout> | null = null;

  // ── Derived ──
  let sortedLayers = $derived(
    [...layers].sort((a, b) => {
      return a.priority - b.priority;
    })
  );

  let editCharCount = $derived(
    isStructured
      ? Object.values(editSections).reduce((sum, s) => sum + s.length, 0)
      : editRawContent.length
  );

  let constitutionPreviewText = $derived.by(() => {
    const sections: string[] = [];

    for (const block of constitutionImmutableBlocks) {
      const trimmed = block.content.trim();
      if (!trimmed) continue;
      sections.push(`[${block.title}]\n${trimmed}`);
    }

    if (constitutionCompanionLayer?.content) {
      const companion = constitutionCompanionLayer.content.trim();
      if (companion) sections.push(companion);
    }

    for (const layer of constitutionMutableLayers) {
      if (!layer.enabled) continue;
      const trimmed = layer.content.trim();
      if (!trimmed) continue;
      sections.push(trimmed);
    }

    if (sections.length === 0) {
      return constitutionServerPreview;
    }
    return sections.join('\n\n');
  });

  // Build interleaved list of layers + markers
  type StackEntry =
    | { kind: 'layer'; layer: PromptLayer; idx: number }
    | { kind: 'marker'; marker: RuntimeMarker };

  let stackEntries = $derived.by((): StackEntry[] => {
    const entries: StackEntry[] = [];
    const usedMarkers = new Set<string>();

    for (let i = 0; i < sortedLayers.length; i++) {
      const layer = sortedLayers[i];
      entries.push({ kind: 'layer', layer, idx: i });

      // After this layer, check if any markers should appear
      const nextLayer = sortedLayers[i + 1];
      for (const marker of RUNTIME_MARKERS) {
        if (usedMarkers.has(marker.id)) continue;
        // Insert marker after the last layer of marker.afterType
        // i.e., when this layer matches the afterType and the next doesn't
        if (layer.type === marker.afterType && (!nextLayer || nextLayer.type !== marker.afterType)) {
          entries.push({ kind: 'marker', marker });
          usedMarkers.add(marker.id);
        }
      }
    }

    // Any remaining markers go at the end
    for (const marker of RUNTIME_MARKERS) {
      if (!usedMarkers.has(marker.id)) {
        entries.push({ kind: 'marker', marker });
      }
    }

    return entries;
  });

  // ── Helpers ──
  function isProtected(layer: PromptLayer): boolean {
    return layer.type === 'base' || layer.type === 'operator';
  }

  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  function formatTokenCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  function showToast(msg: string) {
    toastMessage = msg;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toastMessage = ''; }, 3000);
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(`Copied: ${text}`);
    }).catch(() => {
      showToast('Failed to copy');
    });
  }

  // Backend static prompts use `text` not `content`, and may lack `name`
  function spContent(sp: PromptRegistryEntry): string {
    return sp.content ?? sp.text ?? '';
  }

  function spName(sp: PromptRegistryEntry): string {
    return sp.name ?? sp.key ?? 'unnamed';
  }

  function layerBadge(type: string) {
    return LAYER_BADGE[type] ?? { bg: 'bg-bark-400', text: 'text-white', label: type.toUpperCase() };
  }

  function roleBadge(role: string | undefined): { label: string; cls: string } | null {
    if (!role) return null;
    const map: Record<string, string> = {
      system: 'bg-[#4A5C8B] text-white',
      user: 'bg-[#4A7C59] text-white',
      assistant: 'bg-[#6C5B7B] text-white',
    };
    return { label: role, cls: map[role] ?? 'bg-bark-400 text-white' };
  }

  function applyConstitutionSnapshot(snapshot: ConstitutionSnapshotData) {
    constitutionImmutableBlocks = snapshot.immutableBlocks ?? [];
    constitutionCompanionLayer = snapshot.companionLayer ?? null;
    constitutionMutableLayers = (snapshot.mutableLayers ?? []).map(layer => ({ ...layer }));
    constitutionServerPreview = snapshot.preview?.text ?? '';
    constitutionSaveMessage = '';
  }

  async function refreshConstitution() {
    try {
      const snapshot = await getConstitutionSnapshot();
      applyConstitutionSnapshot(snapshot);
      constitutionError = '';
    } catch (e) {
      constitutionError = e instanceof Error ? e.message : 'Failed to load constitution snapshot';
    } finally {
      constitutionLoading = false;
    }
  }

  function updateConstitutionLayerContent(layerId: string, content: string) {
    constitutionMutableLayers = constitutionMutableLayers.map(layer => (
      layer.id === layerId ? { ...layer, content } : layer
    ));
  }

  function updateConstitutionLayerEnabled(layerId: string, enabled: boolean) {
    constitutionMutableLayers = constitutionMutableLayers.map(layer => (
      layer.id === layerId ? { ...layer, enabled } : layer
    ));
  }

  function moveConstitutionLayer(index: number, direction: 'up' | 'down') {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= constitutionMutableLayers.length) return;
    const next = [...constitutionMutableLayers];
    const [layer] = next.splice(index, 1);
    if (!layer) return;
    next.splice(target, 0, layer);
    constitutionMutableLayers = next;
  }

  async function saveConstitution() {
    constitutionSaving = true;
    constitutionError = '';
    constitutionSaveMessage = '';
    try {
      const result = await saveConstitutionMutableLayers({
        mutableLayers: constitutionMutableLayers.map(layer => ({
          id: layer.id,
          content: layer.content,
          enabled: layer.enabled,
          identifier: layer.identifier ?? null,
          role: layer.role ?? null,
          promptOrder: layer.promptOrder ?? null,
        })),
      });
      if (!result.ok) {
        constitutionError = result.message || 'Failed to save constitution layers';
        return;
      }
      if (result.snapshot) {
        applyConstitutionSnapshot(result.snapshot);
      } else {
        await refreshConstitution();
      }
      await refreshList();
      constitutionSaveMessage = result.message || 'Saved constitution layers';
      showToast('Constitution updated');
    } catch (e) {
      constitutionError = e instanceof Error ? e.message : 'Failed to save constitution layers';
    } finally {
      constitutionSaving = false;
    }
  }

  // ── Structured content parsing ──
  function parseStructuredContent(content: string): { sections: Record<StructuredSectionKey, string>; isStructured: boolean } {
    const sections: Record<StructuredSectionKey, string> = {
      description: '', personality: '', system_prompt: '',
      post_history_instructions: '', scenario: '', mes_example: '', first_mes: '',
    };
    if (!content) return { sections, isStructured: false };
    const lines = (content ?? '').replace(/\r\n?/g, '\n').split('\n');
    const hasHeadings = lines.some(l => /^###\s+[a-z_]+\s*$/.test(l.trim()));
    if (!hasHeadings) {
      sections.system_prompt = content.trim();
      return { sections, isStructured: false };
    }

    let currentSection: StructuredSectionKey | null = null;
    const buckets: Record<StructuredSectionKey, string[]> = {
      description: [], personality: [], system_prompt: [],
      post_history_instructions: [], scenario: [], mes_example: [], first_mes: [],
    };

    for (const line of lines) {
      const match = line.trim().match(/^###\s+([a-z_]+)\s*$/);
      if (match) {
        const key = match[1] as StructuredSectionKey;
        if (STRUCTURED_SECTION_KEYS.includes(key)) {
          currentSection = key;
          continue;
        }
      }
      if (currentSection) {
        buckets[currentSection].push(line);
      }
    }

    for (const key of STRUCTURED_SECTION_KEYS) {
      const lines2 = buckets[key];
      let start = 0;
      while (start < lines2.length && lines2[start].trim() === '') start++;
      let end = lines2.length;
      while (end > start && lines2[end - 1].trim() === '') end--;
      sections[key] = lines2.slice(start, end).join('\n');
    }

    return { sections, isStructured: true };
  }

  function composeSections(sections: Record<StructuredSectionKey, string>): string {
    const chunks: string[] = [];
    for (const key of STRUCTURED_SECTION_KEYS) {
      const value = (sections[key] ?? '').trim();
      if (!value) continue;
      chunks.push(`### ${key}\n${value}`);
    }
    return chunks.join('\n\n');
  }

  // ── Diff computation ──
  function computeDiffLines(oldText: string, newText: string): Array<{ kind: 'same' | 'remove' | 'add'; line: string }> {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const max = Math.max(oldLines.length, newLines.length);
    const rows: Array<{ kind: 'same' | 'remove' | 'add'; line: string }> = [];
    for (let i = 0; i < max; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];
      if (oldLine === newLine) {
        rows.push({ kind: 'same', line: oldLine ?? '' });
      } else {
        if (oldLine !== undefined) rows.push({ kind: 'remove', line: oldLine });
        if (newLine !== undefined) rows.push({ kind: 'add', line: newLine });
      }
    }
    return rows;
  }

  // ── Lifecycle ──
  onMount(async () => {
    const [promptsResult, constitutionResult] = await Promise.allSettled([
      listPrompts(),
      getConstitutionSnapshot(),
    ]);

    if (promptsResult.status === 'fulfilled') {
      layers = promptsResult.value?.layers ?? [];
      staticPrompts = promptsResult.value?.staticPrompts ?? [];
    } else {
      const reason = promptsResult.reason;
      error = reason instanceof Error ? reason.message : 'Failed to load prompts';
    }

    if (constitutionResult.status === 'fulfilled') {
      applyConstitutionSnapshot(constitutionResult.value);
      constitutionError = '';
    } else {
      const reason = constitutionResult.reason;
      constitutionError = reason instanceof Error
        ? reason.message
        : 'Failed to load constitution snapshot';
    }
    loading = false;
    constitutionLoading = false;
  });

  async function refreshList() {
    const data = await listPrompts();
    layers = data?.layers ?? [];
    staticPrompts = data?.staticPrompts ?? [];
    await refreshConstitution();
  }

  // ── Layer actions ──
  async function toggleExpand(layerId: string) {
    if (expandedLayerId === layerId) {
      expandedLayerId = null;
      detailData = null;
      editingContent = false;
      showDiff = false;
      saveMessage = '';
      return;
    }
    expandedLayerId = layerId;
    detailLoading = true;
    editingContent = false;
    showDiff = false;
    saveMessage = '';
    diffData = null;
    try {
      detailData = await getPromptDetail(layerId);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load layer detail';
      expandedLayerId = null;
    } finally {
      detailLoading = false;
    }
  }

  async function handleToggle(layerId: string) {
    try {
      await togglePrompt(layerId);
      await refreshList();
      if (expandedLayerId === layerId && detailData?.layer) {
        detailData = await getPromptDetail(layerId);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to toggle layer';
    }
  }

  function startEditContent(layer: PromptLayer) {
    const parsed = parseStructuredContent(layer.content);
    isStructured = parsed.isStructured;
    editSections = { ...parsed.sections };
    editRawContent = layer.content;
    editName = layer.name;
    editIdentifier = layer.identifier ?? '';
    editRole = layer.role ?? '';
    editPromptOrder = layer.promptOrder;
    editingContent = true;
    saveMessage = '';
  }

  async function saveContent(layerId: string) {
    savingContent = true;
    saveMessage = '';
    try {
      const content = isStructured ? composeSections(editSections) : editRawContent;
      const patch: Record<string, unknown> = { content };
      if (editIdentifier) patch.identifier = editIdentifier;
      if (editRole) patch.role = editRole;
      if (editPromptOrder !== undefined) patch.promptOrder = editPromptOrder;
      await updatePrompt(layerId, patch);
      await refreshList();
      detailData = await getPromptDetail(layerId);
      editingContent = false;
      saveMessage = 'Saved successfully';
      showToast('Prompt layer saved');
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to save content';
    } finally {
      savingContent = false;
    }
  }

  async function handleRollback(layerId: string, version: number) {
    if (!confirm(`Roll back layer to version ${version}? This will replace current content.`)) return;
    rollingBack = true;
    try {
      await rollbackPrompt(layerId, { version });
      await refreshList();
      detailData = await getPromptDetail(layerId);
      saveMessage = `Rolled back to version ${version}`;
      showToast(`Rolled back to v${version}`);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to rollback';
    } finally {
      rollingBack = false;
    }
  }

  async function loadDiff(layerId: string) {
    if (showDiff) {
      showDiff = false;
      return;
    }
    diffLoading = true;
    try {
      diffData = await getPromptDiff(layerId);
      showDiff = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'No previous version to diff';
    } finally {
      diffLoading = false;
    }
  }

  function buildReorderedLayerIds(sourceIdx: number, targetIdx: number): string[] | null {
    if (sourceIdx === targetIdx) return null;
    if (sourceIdx < 0 || sourceIdx >= sortedLayers.length) return null;
    if (targetIdx < 0 || targetIdx >= sortedLayers.length) return null;

    const nextOrder = sortedLayers.map(layer => layer.id);
    const [movedLayerId] = nextOrder.splice(sourceIdx, 1);
    if (!movedLayerId) return null;
    nextOrder.splice(targetIdx, 0, movedLayerId);
    return nextOrder;
  }

  async function reorderLayers(layerIds: string[]) {
    await apiPost<PromptUpdateResult>('/api/admin/prompts/reorder', { layerIds });
  }

  // ── Drag-and-drop reorder ──
  function onDragStart(e: DragEvent, idx: number) {
    dragSourceIdx = idx;
    isDragging = true;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    }
  }

  function onDragOver(e: DragEvent, idx: number) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    dragOverIdx = idx;
  }

  function onDragLeave() {
    dragOverIdx = null;
  }

  async function onDrop(e: DragEvent, targetIdx: number) {
    e.preventDefault();
    isDragging = false;
    dragOverIdx = null;
    if (dragSourceIdx === null || dragSourceIdx === targetIdx) {
      dragSourceIdx = null;
      return;
    }

    const nextOrder = buildReorderedLayerIds(dragSourceIdx, targetIdx);
    if (!nextOrder) {
      dragSourceIdx = null;
      return;
    }
    dragSourceIdx = null;

    try {
      await reorderLayers(nextOrder);
      await refreshList();
      showToast('Reordered');
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : 'Failed to reorder';
    }
  }

  function onDragEnd() {
    isDragging = false;
    dragSourceIdx = null;
    dragOverIdx = null;
  }

  // Keyboard reorder
  async function moveLayer(layerId: string, direction: 'up' | 'down') {
    const idx = sortedLayers.findIndex(l => l.id === layerId);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sortedLayers.length) return;
    const nextOrder = buildReorderedLayerIds(idx, swapIdx);
    if (!nextOrder) return;
    try {
      await reorderLayers(nextOrder);
      await refreshList();
    } catch (e2) {
      error = e2 instanceof Error ? e2.message : 'Failed to reorder';
    }
  }

  // Section tab state for structured editing
  let activeSectionTab = $state<StructuredSectionKey>('system_prompt');

  // ── New layer form ──
  let showNewLayerForm = $state(false);
  let newLayerName = $state('');
  let newLayerType = $state<'runtime' | 'channel' | 'task'>('runtime');
  let newLayerContent = $state('');
  let newLayerPriority = $state(10);
  let newLayerChannelType = $state('');
  let newLayerTaskKind = $state('');
  let creatingLayer = $state(false);

  function resetNewLayerForm() {
    newLayerName = '';
    newLayerType = 'runtime';
    newLayerContent = '';
    newLayerPriority = 10;
    newLayerChannelType = '';
    newLayerTaskKind = '';
  }

  async function handleCreateLayer() {
    if (!newLayerName.trim()) return;
    creatingLayer = true;
    try {
      const body: Record<string, unknown> = {
        name: newLayerName.trim(),
        type: newLayerType,
        content: newLayerContent,
        priority: newLayerPriority,
      };
      if (newLayerType === 'channel' && newLayerChannelType.trim()) {
        body.channelType = newLayerChannelType.trim();
      }
      if (newLayerType === 'task' && newLayerTaskKind.trim()) {
        body.taskKind = newLayerTaskKind.trim();
      }
      const result = await createPromptLayer(body);
      if (result.ok) {
        showToast(result.message || 'Layer created');
        showNewLayerForm = false;
        resetNewLayerForm();
        await refreshList();
      } else {
        error = result.message || 'Failed to create layer';
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create layer';
    } finally {
      creatingLayer = false;
    }
  }
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Prompt Soil</h1>
      <p class="text-sm text-shadow-600 mt-1">
        Layered prompt composition stack -- {layers.length} layer{layers.length === 1 ? '' : 's'}, {staticPrompts.length} static
      </p>
    </div>
    <div class="flex items-center gap-3 text-sm text-shadow-600">
      <span>Total: ~{formatTokenCount(layers.reduce((sum, l) => sum + estimateTokens(l.content), 0))} tokens</span>
    </div>
  </div>

  <!-- Error -->
  {#if error}
    <div class="card-garden p-4 flex items-center gap-3 border-wilt-400">
      <svg class="w-5 h-5 text-wilt-600 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <span class="text-sm text-wilt-600">{error}</span>
      <button onclick={() => error = ''} class="ml-auto text-shadow-600 hover:text-shadow-900 text-lg leading-none">&times;</button>
    </div>
  {/if}

  <!-- Toast -->
  {#if toastMessage}
    <div class="fixed bottom-6 right-6 z-50 px-4 py-2.5 rounded-lg bg-shadow-800 text-white text-sm shadow-lg transition-all">
      {toastMessage}
    </div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="space-y-2">
      {#each Array(5) as _}
        <div class="card-garden p-4 animate-pulse">
          <div class="flex items-center gap-3">
            <div class="h-5 w-6 bg-bark-300 rounded"></div>
            <div class="h-5 w-20 bg-bark-300 rounded"></div>
            <div class="h-4 bg-bark-300 rounded flex-1"></div>
            <div class="h-4 w-12 bg-bark-300 rounded"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <!-- ─── Constitution Builder ─── -->
    <div class="card-garden overflow-hidden">
      <button
        onclick={() => showConstitutionSection = !showConstitutionSection}
        class="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-bark-100 transition-colors"
      >
        <div>
          <h2 class="text-base font-serif font-semibold text-shadow-800">Constitution Builder</h2>
          <p class="text-sm text-shadow-600 mt-0.5">Immutable amendments are locked. Mutable layers can be reordered and edited.</p>
        </div>
        <svg class="w-4 h-4 text-shadow-600 transition-transform shrink-0 ml-4 {showConstitutionSection ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {#if showConstitutionSection}
        <div class="border-t border-bark-300 p-5 space-y-4">
          {#if constitutionLoading}
            <div class="space-y-2">
              {#each Array(3) as _}
                <div class="h-16 rounded-lg bg-bark-200 animate-pulse"></div>
              {/each}
            </div>
          {:else}
            {#if constitutionError}
              <div class="px-3 py-2 rounded-lg border border-wilt-400 bg-wilt-50 text-sm text-wilt-700">
                {constitutionError}
              </div>
            {/if}

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div class="space-y-3">
                <h3 class="text-sm font-semibold text-shadow-700 uppercase tracking-wider">Immutable Amendments</h3>
                {#each constitutionImmutableBlocks as block (block.id)}
                  <div class="rounded-lg border border-bark-300 bg-bark-100 p-3">
                    <div class="flex items-center justify-between mb-1.5">
                      <span class="text-sm font-medium text-shadow-800">{block.title}</span>
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-bark-300 text-shadow-700">Read only</span>
                    </div>
                    <p class="text-sm text-shadow-700 leading-relaxed whitespace-pre-wrap">{block.content}</p>
                  </div>
                {/each}

                {#if constitutionCompanionLayer}
                  <div class="rounded-lg border border-bark-300 bg-bark-100 p-3">
                    <div class="flex items-center justify-between mb-1.5">
                      <span class="text-sm font-medium text-shadow-800">{constitutionCompanionLayer.title}</span>
                      <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-bark-300 text-shadow-700">Derived</span>
                    </div>
                    <pre class="text-sm font-mono text-shadow-700 whitespace-pre-wrap bg-white/60 p-2 rounded border border-bark-200 max-h-48 overflow-y-auto">{constitutionCompanionLayer.content}</pre>
                  </div>
                {/if}
              </div>

              <div class="space-y-3">
                <h3 class="text-sm font-semibold text-shadow-700 uppercase tracking-wider">Mutable Layers</h3>
                <div class="space-y-2">
                  {#each constitutionMutableLayers as layer, idx (layer.id)}
                    {@const layerLocked = !layer.editable}
                    <div class="rounded-lg border border-bark-300 bg-white p-3 space-y-2">
                      <div class="flex items-center gap-2">
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider {layerBadge(layer.type).bg} {layerBadge(layer.type).text}">
                          {layerBadge(layer.type).label}
                        </span>
                        <span class="text-sm font-medium text-shadow-800 truncate">{layer.name}</span>
                        <span class="ml-auto text-sm text-shadow-600">#{idx + 1}</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <button
                          onclick={() => moveConstitutionLayer(idx, 'up')}
                          disabled={idx === 0}
                          class="px-2 py-0.5 rounded border border-bark-300 text-sm text-shadow-700 hover:bg-bark-100 disabled:opacity-40"
                        >
                          Up
                        </button>
                        <button
                          onclick={() => moveConstitutionLayer(idx, 'down')}
                          disabled={idx === constitutionMutableLayers.length - 1}
                          class="px-2 py-0.5 rounded border border-bark-300 text-sm text-shadow-700 hover:bg-bark-100 disabled:opacity-40"
                        >
                          Down
                        </button>
                        <label class="ml-auto inline-flex items-center gap-1.5 text-sm text-shadow-700">
                          <input
                            type="checkbox"
                            checked={layer.enabled}
                            disabled={layerLocked}
                            onchange={(e) => updateConstitutionLayerEnabled(layer.id, (e.target as HTMLInputElement).checked)}
                          />
                          enabled
                        </label>
                      </div>
                      <textarea
                        rows={4}
                        value={layer.content}
                        disabled={layerLocked}
                        oninput={(e) => updateConstitutionLayerContent(layer.id, (e.target as HTMLTextAreaElement).value)}
                        class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 disabled:opacity-60 disabled:cursor-not-allowed"
                      ></textarea>
                      {#if layerLocked && layer.readOnlyReason}
                        <p class="text-sm text-shadow-600">{layer.readOnlyReason}</p>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            </div>

            <div class="rounded-lg border border-bark-300 bg-bark-100 p-3">
              <div class="flex items-center justify-between mb-2">
                <h3 class="text-sm font-semibold text-shadow-700 uppercase tracking-wider">Preview Output</h3>
                <span class="text-sm text-shadow-600">~{formatTokenCount(estimateTokens(constitutionPreviewText))} tokens</span>
              </div>
              <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-white/60 p-3 rounded border border-bark-200 max-h-64 overflow-y-auto leading-relaxed">{constitutionPreviewText}</pre>
            </div>

            <div class="flex items-center gap-3">
              <button
                onclick={saveConstitution}
                disabled={constitutionSaving}
                class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
              >
                {constitutionSaving ? 'Saving...' : 'Save Constitution Layers'}
              </button>
              {#if constitutionSaveMessage}
                <span class="text-sm text-moss-700">{constitutionSaveMessage}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <!-- ─── Prompt Composition Stack ─── -->
    <div>
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-3">
          <h2 class="text-base font-serif font-semibold text-shadow-800">Composition Stack</h2>
          <span class="text-sm text-shadow-600">Drag to reorder. Click to expand.</span>
        </div>
        <button
          onclick={() => { showNewLayerForm = !showNewLayerForm; if (!showNewLayerForm) resetNewLayerForm(); }}
          class="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-bark-300 text-shadow-700 hover:bg-bark-100 hover:border-gold-300 transition-colors font-medium"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
          {showNewLayerForm ? 'Cancel' : 'New Layer'}
        </button>
      </div>

      <!-- New Layer Form -->
      {#if showNewLayerForm}
        <div class="card-garden p-5 mb-3 filigree-border-strong">
          <h3 class="text-sm font-serif font-semibold text-shadow-800 mb-3">Create New Prompt Layer</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <label class="block">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Name <span class="text-wilt-500">*</span></span>
              <input type="text" bind:value={newLayerName} placeholder="My Custom Layer"
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
            <label class="block">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Type <span class="text-wilt-500">*</span></span>
              <select bind:value={newLayerType}
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                <option value="runtime">Runtime</option>
                <option value="channel">Channel</option>
                <option value="task">Task</option>
              </select>
            </label>
            <label class="block">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Priority</span>
              <input type="number" min="0" step="1" bind:value={newLayerPriority}
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
          </div>

          {#if newLayerType === 'channel'}
            <label class="block mb-3">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Channel Type <span class="text-shadow-500">(optional -- e.g. discord_text, api, admin)</span></span>
              <input type="text" bind:value={newLayerChannelType} placeholder="discord_text"
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
          {/if}
          {#if newLayerType === 'task'}
            <label class="block mb-3">
              <span class="block text-sm font-medium text-shadow-700 mb-1">Task Kind <span class="text-shadow-500">(optional -- e.g. heartbeat, reflection)</span></span>
              <input type="text" bind:value={newLayerTaskKind} placeholder="heartbeat"
                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
            </label>
          {/if}

          <label class="block mb-3">
            <span class="block text-sm font-medium text-shadow-700 mb-1">Content</span>
            <textarea
              bind:value={newLayerContent}
              rows={6}
              placeholder="Enter prompt content..."
              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
            ></textarea>
            <span class="text-sm text-shadow-600 mt-1">{newLayerContent.length} chars | ~{formatTokenCount(estimateTokens(newLayerContent))} tokens</span>
          </label>

          <div class="flex items-center gap-2">
            <button
              onclick={handleCreateLayer}
              disabled={creatingLayer || !newLayerName.trim()}
              class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
            >
              {creatingLayer ? 'Creating...' : 'Create Layer'}
            </button>
            <button
              onclick={() => { showNewLayerForm = false; resetNewLayerForm(); }}
              data-esc-close
              class="px-3 py-1.5 rounded-lg text-shadow-700 text-sm hover:bg-bark-200 transition-colors border border-bark-300"
            >
              Cancel
            </button>
          </div>
        </div>
      {/if}

      <div class="space-y-1">
        {#each stackEntries as entry}
          {#if entry.kind === 'marker'}
            <!-- Runtime Marker -->
            <div class="flex items-center gap-3 px-4 py-2.5 rounded-lg border border-dashed border-bark-400 bg-bark-100">
              <svg class="w-4 h-4 text-shadow-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
              </svg>
              <span class="text-sm font-semibold text-shadow-600 italic tracking-wide">[{entry.marker.label}]</span>
              <span class="text-sm text-shadow-500 italic">{entry.marker.description}</span>
            </div>
          {:else}
            {@const layer = entry.layer}
            {@const idx = entry.idx}
            {@const badge = layerBadge(layer.type)}
            {@const rBadge = roleBadge(layer.role)}
            {@const isExpanded = expandedLayerId === layer.id}
            {@const locked = isProtected(layer)}
            {@const tokens = estimateTokens(layer.content)}
            {@const isDragSource = dragSourceIdx === idx}
            {@const isDragTarget = dragOverIdx === idx}

            <div
              class="card-garden overflow-hidden transition-all duration-150
                {!layer.enabled ? 'opacity-40' : ''}
                {isExpanded ? 'filigree-border-strong ring-1 ring-gold-300' : ''}
                {isDragSource ? 'opacity-50 scale-[0.98]' : ''}
                {isDragTarget ? 'ring-2 ring-gold-400 ring-offset-1' : ''}"
              draggable={layers.length > 1}
              ondragstart={(e) => onDragStart(e, idx)}
              ondragover={(e) => onDragOver(e, idx)}
              ondragleave={() => onDragLeave()}
              ondrop={(e) => onDrop(e, idx)}
              ondragend={() => onDragEnd()}
              role="listitem"
            >
              <!-- Layer header row -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-bark-100 transition-colors cursor-pointer select-none"
                onclick={() => toggleExpand(layer.id)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(layer.id); }
                  if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); moveLayer(layer.id, 'up'); }
                  if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); moveLayer(layer.id, 'down'); }
                }}
                role="button"
                tabindex="0"
              >
                <!-- Drag handle -->
                <span
                  class="flex items-center justify-center w-6 h-6 shrink-0 rounded text-shadow-500 cursor-grab hover:text-gold-600 hover:bg-bark-200"
                  title="Drag to reorder"
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="5" width="16" height="2" rx="1"/>
                    <rect x="4" y="11" width="16" height="2" rx="1"/>
                    <rect x="4" y="17" width="16" height="2" rx="1"/>
                  </svg>
                </span>

                <!-- Type badge -->
                <span class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider shrink-0 {badge.bg} {badge.text}">
                  {badge.label}
                </span>

                <!-- Name -->
                <span class="font-serif font-medium text-sm text-shadow-800 min-w-0 truncate">{layer.name}</span>

                <!-- Role badge -->
                {#if rBadge}
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 {rBadge.cls}">
                    {rBadge.label}
                  </span>
                {/if}

                <span class="flex-1"></span>

                <!-- Token count -->
                <span class="text-sm font-mono text-shadow-600 shrink-0" title="{tokens} tokens (~{layer.content.length} chars)">
                  {formatTokenCount(tokens)}t
                </span>

                <!-- Version -->
                <span class="text-sm font-mono text-shadow-600 shrink-0">v{layer.version}</span>

                <!-- Toggle switch or lock -->
                {#if locked}
                  <svg class="w-4 h-4 text-shadow-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <title>Protected layer</title>
                    <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                {:else}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
                    <button
                      onclick={() => handleToggle(layer.id)}
                      class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-gold-300 focus:ring-offset-1 {layer.enabled ? 'bg-moss-500' : 'bg-bark-400'}"
                      role="switch"
                      aria-checked={layer.enabled}
                      title={layer.enabled ? 'Disable layer' : 'Enable layer'}
                    >
                      <span class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out {layer.enabled ? 'translate-x-4' : 'translate-x-0'}"></span>
                    </button>
                  </div>
                {/if}

                <!-- Expand/collapse chevron -->
                <svg class="w-4 h-4 text-shadow-500 shrink-0 transition-transform duration-200 {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 9l-7 7-7-7" />
                </svg>
              </div>

              <!-- Expanded inline editor -->
              {#if isExpanded}
                <div class="border-t border-bark-300">
                  {#if detailLoading}
                    <div class="p-5 animate-pulse space-y-3">
                      <div class="h-4 bg-bark-300 rounded w-1/3"></div>
                      <div class="h-20 bg-bark-300 rounded"></div>
                    </div>
                  {:else if detailData?.layer}
                    {@const dl = detailData.layer}
                    <div class="p-5 space-y-5">
                      {#if !editingContent}
                        <!-- Read-only metadata -->
                        <div class="flex flex-wrap items-center gap-3 text-sm">
                          <span class="text-shadow-600">Type: <span class="text-shadow-800 font-medium capitalize">{dl.type}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Priority: <span class="text-shadow-800 font-mono">{dl.priority}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Role: <span class="text-shadow-800">{dl.role ?? 'system'}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Version: <span class="text-shadow-800 font-mono">v{dl.version}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">Updated: <span class="text-shadow-800">{dl.updatedAt ? new Date(dl.updatedAt).toLocaleString() : 'unknown'}</span></span>
                          <span class="text-shadow-300">|</span>
                          <span class="text-shadow-600">By: <span class="text-shadow-800">{dl.updatedBy ?? 'unknown'}</span></span>
                          {#if dl.checksum}
                            <span class="text-shadow-300">|</span>
                            <span class="text-shadow-600">Checksum: <span class="font-mono text-shadow-700">{dl.checksum.slice(0, 12)}</span></span>
                          {/if}
                          {#if dl.identifier}
                            <span class="text-shadow-300">|</span>
                            <span class="text-shadow-600">ID: <span class="font-mono text-shadow-800">{dl.identifier}</span></span>
                          {/if}
                          {#if dl.promptOrder !== undefined && dl.promptOrder !== null}
                            <span class="text-shadow-300">|</span>
                            <span class="text-shadow-600">Order: <span class="font-mono text-shadow-800">{dl.promptOrder}</span></span>
                          {/if}
                        </div>

                        <!-- Content display -->
                        <div>
                          <div class="flex items-center justify-between mb-2">
                            <span class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Content</span>
                            <div class="flex items-center gap-3">
                              {#if dl.version > 1}
                                <button
                                  onclick={() => loadDiff(dl.id)}
                                  disabled={diffLoading}
                                  class="text-sm text-shadow-700 hover:text-gold-600 transition-colors"
                                >
                                  {diffLoading ? 'Loading...' : showDiff ? 'Hide Diff' : 'Show Diff'}
                                </button>
                              {/if}
                              <button
                                onclick={() => startEditContent(dl)}
                                class="text-sm text-gold-600 hover:text-gold-700 hover:underline font-medium"
                              >
                                Edit
                              </button>
                            </div>
                          </div>

                          <!-- Diff view -->
                          {#if showDiff && diffData}
                            {@const diffLines = computeDiffLines(diffData.oldContent, diffData.newContent)}
                            <div class="mb-3 rounded-lg border border-bark-300 overflow-hidden">
                              <div class="px-3 py-2 bg-bark-200 text-sm text-shadow-700 font-medium">Diff: Previous vs Current</div>
                              <div class="font-mono text-sm max-h-64 overflow-y-auto">
                                {#each diffLines as line}
                                  {#if line.kind === 'add'}
                                    <div class="px-3 py-0.5 bg-moss-50 text-moss-700">+ {line.line}</div>
                                  {:else if line.kind === 'remove'}
                                    <div class="px-3 py-0.5 bg-wilt-50 text-wilt-600">- {line.line}</div>
                                  {:else}
                                    <div class="px-3 py-0.5 text-shadow-600">  {line.line}</div>
                                  {/if}
                                {/each}
                              </div>
                            </div>
                          {/if}

                          <!-- Read-only content -->
                          <div class="relative">
                            {#if locked}
                              <div class="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded text-sm bg-bark-200 text-shadow-600">
                                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                                Protected
                              </div>
                            {/if}
                            <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-bark-100 p-3 rounded-lg max-h-72 overflow-y-auto leading-relaxed {locked ? 'border border-bark-300' : ''}">{dl.content ?? ''}</pre>
                            <div class="flex justify-between mt-1.5">
                              <span class="text-sm text-shadow-600">{(dl.content ?? '').length} chars</span>
                              <span class="text-sm text-shadow-600">~{formatTokenCount(estimateTokens(dl.content ?? ''))} tokens</span>
                            </div>
                          </div>
                        </div>

                      {:else}
                        <!-- ── Edit mode ── -->
                        <div class="space-y-4">
                          <!-- Metadata fields -->
                          <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Name</span>
                              <input type="text" bind:value={editName} disabled={locked}
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400 disabled:opacity-50 disabled:cursor-not-allowed" />
                            </label>
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Role</span>
                              <select bind:value={editRole}
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                                <option value="">system (default)</option>
                                <option value="system">system</option>
                                <option value="user">user</option>
                                <option value="assistant">assistant</option>
                              </select>
                            </label>
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Identifier</span>
                              <input type="text" bind:value={editIdentifier} placeholder="main"
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
                            </label>
                            <label class="block">
                              <span class="block text-sm font-medium text-shadow-700 mb-1">Prompt Order</span>
                              <input type="number" min="0" step="1"
                                value={editPromptOrder ?? ''}
                                onchange={(e) => { const v = (e.target as HTMLInputElement).value; editPromptOrder = v ? Number(v) : undefined; }}
                                class="w-full px-3 py-1.5 rounded-lg border border-bark-300 bg-white text-shadow-800 text-sm focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400" />
                            </label>
                          </div>

                          <!-- Content editor -->
                          {#if isStructured}
                            <!-- Section tabs for structured content -->
                            <div>
                              <div class="flex flex-wrap gap-1 border-b border-bark-300 mb-3">
                                {#each STRUCTURED_SECTION_KEYS as key}
                                  {@const hasContent = (editSections[key] ?? '').trim().length > 0}
                                  <button
                                    onclick={() => activeSectionTab = key}
                                    class="px-3 py-1.5 text-sm font-medium rounded-t-lg border border-b-0 transition-colors
                                      {activeSectionTab === key ? 'bg-white border-bark-300 text-shadow-800' : 'bg-bark-100 border-transparent text-shadow-600 hover:text-shadow-800 hover:bg-bark-200'}
                                      {hasContent ? '' : 'opacity-60'}"
                                  >
                                    {SECTION_LABELS[key]}
                                    {#if hasContent}
                                      <span class="ml-1 text-[10px] text-gold-600 font-bold">*</span>
                                    {/if}
                                  </button>
                                {/each}
                              </div>
                              {#each STRUCTURED_SECTION_KEYS as key}
                                {#if activeSectionTab === key}
                                  <textarea
                                    bind:value={editSections[key]}
                                    rows={SECTION_ROWS[key]}
                                    placeholder="{SECTION_LABELS[key]} content..."
                                    class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                                  ></textarea>
                                {/if}
                              {/each}
                            </div>
                          {:else}
                            <textarea
                              bind:value={editRawContent}
                              rows={14}
                              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800 text-sm font-mono resize-vertical leading-relaxed focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                            ></textarea>
                          {/if}

                          <!-- Edit footer -->
                          <div class="flex items-center justify-between">
                            <div class="flex items-center gap-4 text-sm text-shadow-600">
                              <span>{editCharCount} chars</span>
                              <span>~{formatTokenCount(Math.ceil(editCharCount / 4))} tokens</span>
                            </div>
                            <div class="flex gap-2">
                              <button
                                onclick={() => { editingContent = false; saveMessage = ''; }}
                                data-esc-close
                                class="px-3 py-1.5 rounded-lg text-shadow-700 text-sm hover:bg-bark-200 transition-colors border border-bark-300"
                              >
                                Cancel
                              </button>
                              <button
                                onclick={() => saveContent(dl.id)}
                                disabled={savingContent}
                                class="px-4 py-1.5 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
                              >
                                {savingContent ? 'Saving...' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </div>
                      {/if}

                      {#if saveMessage}
                        <p class="text-sm text-moss-600">{saveMessage}</p>
                      {/if}

                      <!-- Version history + rollback -->
                      {#if detailData?.layerHistory && detailData.layerHistory.length > 0 && !editingContent}
                        <div>
                          <span class="text-sm font-medium text-shadow-700 uppercase tracking-wider">Version History</span>
                          <p class="text-sm text-shadow-600 mt-0.5 mb-2">{detailData.layerHistory.length} version{detailData.layerHistory.length === 1 ? '' : 's'}</p>
                          <div class="space-y-1.5 max-h-48 overflow-y-auto">
                            {#each detailData.layerHistory as entry (entry.version)}
                              {@const isCurrent = entry.version === dl.version}
                              <div class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm {isCurrent ? 'bg-gold-50 border border-gold-300' : 'bg-bark-100'}">
                                <span class="font-mono font-medium {isCurrent ? 'text-gold-700' : 'text-shadow-800'}">v{entry.version}</span>
                                <span class="text-shadow-700">{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown'}</span>
                                <span class="text-shadow-600">{entry.updatedBy ?? 'unknown'}</span>
                                {#if entry.reason}
                                  <span class="text-shadow-600 italic truncate max-w-48">{entry.reason}</span>
                                {/if}
                                {#if isCurrent}
                                  <span class="ml-auto px-2 py-0.5 rounded-full text-sm font-medium bg-gold-100 text-gold-700 border border-gold-300">current</span>
                                {:else}
                                  <button
                                    onclick={() => handleRollback(dl.id, entry.version)}
                                    disabled={rollingBack}
                                    class="ml-auto px-2.5 py-0.5 text-sm font-medium rounded border border-wilt-400 text-wilt-600 hover:bg-wilt-50 transition-colors disabled:opacity-50"
                                  >
                                    {rollingBack ? '...' : 'Rollback'}
                                  </button>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/each}

        {#if sortedLayers.length === 0}
          <div class="card-garden p-8 text-center text-shadow-600 italic">
            No prompt layers configured
          </div>
        {/if}
      </div>
    </div>

    <!-- ─── Static Prompt Registry ─── -->
    {#if staticPrompts.length > 0}
      <hr class="divider-filigree my-6" />

      <div>
        <button
          onclick={() => showStaticSection = !showStaticSection}
          class="w-full flex items-center justify-between text-left mb-3"
        >
          <div>
            <h2 class="text-base font-serif font-semibold text-shadow-800">Static Prompt Registry</h2>
            <p class="text-sm text-shadow-600 mt-0.5">{staticPrompts.length} registered prompt{staticPrompts.length === 1 ? '' : 's'} -- always active, used by extraction/compaction/synthesis</p>
          </div>
          <svg class="w-4 h-4 text-shadow-600 transition-transform shrink-0 ml-4 {showStaticSection ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {#if showStaticSection}
          <div class="space-y-1">
            {#each staticPrompts as sp (sp.key)}
              {@const isExpanded = expandedStatic === sp.key}
              {@const spTokens = estimateTokens(spContent(sp))}

              <div class="card-garden overflow-hidden {sp.enabled === false ? 'opacity-40' : ''} {isExpanded ? 'filigree-border-strong ring-1 ring-gold-300' : ''}">
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="px-3 py-2.5 flex items-center gap-2.5 hover:bg-bark-100 transition-colors cursor-pointer select-none"
                  onclick={() => expandedStatic = isExpanded ? null : sp.key}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandedStatic = isExpanded ? null : sp.key; }}}
                  role="button"
                  tabindex="0"
                >
                  <!-- No drag handle for static -->
                  <span class="w-6 shrink-0"></span>

                  <!-- Static badge -->
                  <span class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider shrink-0 {STATIC_BADGE.bg} {STATIC_BADGE.text}">
                    {STATIC_BADGE.label}
                  </span>

                  <!-- Name -->
                  <span class="font-serif font-medium text-sm text-shadow-800">{spName(sp)}</span>

                  <!-- Key -->
                  <span class="text-sm font-mono text-shadow-600 hidden sm:inline">{sp.key}</span>

                  <span class="flex-1"></span>

                  <!-- Consumers -->
                  {#if sp.consumers && sp.consumers.length > 0}
                    <div class="hidden md:flex items-center gap-1">
                      {#each sp.consumers as consumer}
                        <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-bark-200 text-shadow-600 font-mono">{consumer}</span>
                      {/each}
                    </div>
                  {/if}

                  <!-- Category -->
                  {#if sp.category}
                    <span class="text-sm px-1.5 py-0.5 rounded-full bg-bark-200 text-shadow-600">{sp.category}</span>
                  {/if}

                  <!-- Token count -->
                  <span class="text-sm font-mono text-shadow-600 shrink-0">{formatTokenCount(spTokens)}t</span>

                  <!-- Version -->
                  <span class="text-sm font-mono text-shadow-600 shrink-0">v{sp.version ?? 1}</span>

                  <!-- Chevron -->
                  <svg class="w-4 h-4 text-shadow-500 shrink-0 transition-transform duration-200 {isExpanded ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 9l-7 7-7-7" />
                  </svg>
                </div>

                {#if isExpanded}
                  <div class="border-t border-bark-300 p-4 space-y-3">
                    <!-- Metadata row -->
                    <div class="flex flex-wrap items-center gap-3 text-sm">
                      <span class="text-shadow-600">Key: <span class="font-mono text-shadow-800">{sp.key}</span></span>
                      {#if sp.description}
                        <span class="text-shadow-300">|</span>
                        <span class="text-shadow-600">{sp.description}</span>
                      {/if}
                      <span class="text-shadow-300">|</span>
                      <span class="text-shadow-600">Updated: <span class="text-shadow-800">{sp.updatedAt ? new Date(sp.updatedAt).toLocaleString() : 'unknown'}</span></span>
                      {#if sp.updatedBy}
                        <span class="text-shadow-300">|</span>
                        <span class="text-shadow-600">By: <span class="text-shadow-800">{sp.updatedBy}</span></span>
                      {/if}
                      {#if sp.checksum}
                        <span class="text-shadow-300">|</span>
                        <span class="text-shadow-600">Checksum: <span class="font-mono text-shadow-700">{sp.checksum.slice(0, 12)}</span></span>
                      {/if}
                      {#if sp.consumers && sp.consumers.length > 0}
                        <span class="text-shadow-300">|</span>
                        <span class="text-shadow-600">Used by: <span class="text-shadow-800">{sp.consumers.join(', ')}</span></span>
                      {/if}
                    </div>

                    <!-- Content -->
                    <pre class="text-sm font-mono text-shadow-800 whitespace-pre-wrap bg-bark-100 p-3 rounded-lg max-h-64 overflow-y-auto leading-relaxed">{spContent(sp)}</pre>
                    <div class="flex justify-between">
                      <span class="text-sm text-shadow-600">{spContent(sp).length} chars</span>
                      <span class="text-sm text-shadow-600">~{formatTokenCount(spTokens)} tokens</span>
                    </div>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- ─── Macro Catalog ─── -->
    <hr class="divider-filigree my-6" />

    <div class="card-garden overflow-hidden">
      <button
        onclick={() => showMacroCatalog = !showMacroCatalog}
        class="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-bark-100 transition-colors"
      >
        <div class="flex items-center gap-3">
          <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gold-100 text-gold-700 text-sm font-bold border border-gold-300">{'{}'}</span>
          <h2 class="text-sm font-serif font-semibold text-shadow-800">Macro Catalog</h2>
          <span class="text-sm text-shadow-600">{MACROS.length} runtime macros</span>
        </div>
        <svg class="w-4 h-4 text-shadow-600 transition-transform {showMacroCatalog ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {#if showMacroCatalog}
        <div class="border-t border-bark-300">
          <div class="grid gap-0 divide-y divide-bark-200">
            {#each MACROS as macro}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="flex items-center gap-4 px-5 py-3 hover:bg-bark-100 transition-colors cursor-pointer group"
                onclick={() => copyToClipboard(macro.token)}
                onkeydown={(e) => { if (e.key === 'Enter') copyToClipboard(macro.token); }}
                role="button"
                tabindex="0"
                title="Click to copy"
              >
                <code class="text-sm font-mono text-gold-700 bg-gold-50 px-2 py-0.5 rounded border border-gold-200 shrink-0 group-hover:bg-gold-100 transition-colors">
                  {macro.token}
                </code>
                {#if macro.alias}
                  <code class="text-sm font-mono text-shadow-500 shrink-0">{macro.alias}</code>
                {/if}
                <span class="text-sm text-shadow-700 flex-1">{macro.desc}</span>
                <code class="text-sm font-mono text-shadow-500 hidden sm:inline shrink-0">{macro.example}</code>
                <svg class="w-4 h-4 text-shadow-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
                </svg>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
