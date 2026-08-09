<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { getChatBootstrap, updateChatBootstrap } from '$lib/api/endpoints/chat';
  import { getModelRoomBootstrap } from '$lib/api/endpoints/model-room';
  import { applyIdentityOnboardingAction } from '$lib/api/endpoints/identity';
  import {
    getSessionMessages,
    listSessions,
    SESSION_MESSAGE_PAGE_SIZE,
  } from '$lib/api/endpoints/sessions';
  import { getToken } from '$lib/stores/auth.svelte';
  import {
    getCompanionName,
    setCompanionNameFromChatBootstrap,
  } from '$lib/stores/companion.svelte';
  import CollapsibleSection from '$lib/components/garden/CollapsibleSection.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import GardenTabBar, { type GardenTabItem } from '$lib/components/garden/GardenTabBar.svelte';
  import { createVisibilityAwarePoller } from '$lib/polling/visibility-aware-poller';
  import BoundedList from '$lib/components/garden/BoundedList.svelte';
  import { apiFetch } from '$lib/api/client';
  import {
    buildAdminWebSocketUrl,
    registerCompanionWebSocket,
  } from '$lib/api/websocket';
  import {
    currentCompanionGardenScope,
    getCompanionCacheScope,
    onCompanionScopeChange,
    scopeGardenPath,
  } from '$lib/fleet/companion-scope';
  import {
    classifySessionKind,
    type SessionKindFilter,
  } from './session-kind';
  import type {
    AdminChatBootstrapResponse,
    AdminModelRoomBootstrapResponse,
    AdminModelRoomParticipant,
    AdminSessionMessagesData,
    ChannelInfo,
    SessionEntry,
  } from '$lib/types';
  import {
    isToolCallOutcome,
    type ToolCallOutcome,
  } from '../../../../src/shared/contracts/tool-call-outcome.js';

  // ── Message model (unified: companion chat + model-room rounds) ──
  interface ToolCallView {
    name: string;
    id: string;
    args: string;
    result?: string;
    isError?: boolean;
    outcome?: ToolCallOutcome;
  }

  interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    speakerId: string;
    speakerName: string;
    content: string;
    timestamp: number;
    thinking?: string;
    toolCalls?: ToolCallView[];
    isError?: boolean;
  }

  // ── Page/tab state ──
  type TabId = 'chat' | 'transcripts';
  let activeTab = $state<TabId>('chat');

  // ── Bootstrap state ──
  let bootstrap = $state<AdminChatBootstrapResponse | null>(null);
  let roomBootstrap = $state<AdminModelRoomBootstrapResponse | null>(null);
  let roomUnavailableReason = $state('');
  let error = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let connectionStatus = $state<'connecting' | 'connected' | 'error'>('connecting');
  let statusDetail = $state('');

  // ── Chat state ──
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state('');
  let isStreaming = $state(false);
  let sendingRound = $state(false);
  let streamingContent = $state('');
  let streamingThinking = $state('');
  let pendingToolCalls = $state<ToolCallView[]>([]);

  // Contact/privacy/channel selectors (companion routing)
  let selectedContactId = $state('');
  let selectedPrivacyLevel = $state('');
  let selectedChannelIdentity = $state('');
  let onboardingSaving = $state(false);
  let onboardingError = $state('');
  let onboardingDraft = $state({
    name: '',
    description: '',
    personality: '',
  });
  const companionName = $derived(getCompanionName());
  const companionSpeakerId = $derived(roomBootstrap?.companion.id ?? 'companion');

  // Model-room roster state
  let roomId = $state('garden-model-room');
  let includeCompanion = $state(true);
  let operatorName = $state('Operator');
  let participantEnabled = $state<Record<string, boolean>>({});
  let participantPrompts = $state<Record<string, string>>({});
  let savedPrompts: Record<string, string> = {};

  // Section collapse state
  let identityCollapsed = $state(true);
  let rosterCollapsed = $state(true);

  const enabledParticipants = $derived(
    roomBootstrap
      ? roomBootstrap.participants.filter((participant) => participantEnabled[participant.id] === true)
      : [],
  );
  const roomModeActive = $derived(enabledParticipants.length > 0);
  const busy = $derived(isStreaming || sendingRound);

  // Transcripts tab state
  let sessionsLoaded = $state(false);
  let sessionsLoading = $state(false);
  let sessionsError = $state('');
  let sessionList = $state<ChannelInfo[]>([]);
  let sessionFilter = $state('');
  let sessionKindFilter = $state<SessionKindFilter>('all');
  let sessionScopeGeneration = 0;
  let selectedSessionId = $state('');
  let transcriptLoading = $state(false);
  let transcriptError = $state('');
  let transcriptMessages = $state<SessionEntry[]>([]);
  let transcriptPagination = $state<AdminSessionMessagesData['pagination'] | null>(null);

  const filteredSessions = $derived.by(() => {
    const query = sessionFilter.trim().toLowerCase();
    const kindFiltered = sessionKindFilter === 'all'
      ? sessionList
      : sessionList.filter(channel => classifySessionKind(channel) === sessionKindFilter);
    const sorted = [...kindFiltered].sort(
      (left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0),
    );
    if (!query) return sorted;
    return sorted.filter((channel) => (
      channel.sessionId.toLowerCase().includes(query)
      || channel.channelId.toLowerCase().includes(query)
      || (channel.displayLabel ?? '').toLowerCase().includes(query)
      || (channel.linkedContactName ?? '').toLowerCase().includes(query)
    ));
  });

  // ── Constants ──
  const GARDEN_CHAT_CHANNEL = 'api';
  const GARDEN_CHAT_USER_ID = 'admin-user';
  const GARDEN_CHAT_KEY = `identity:${GARDEN_CHAT_CHANNEL}:${GARDEN_CHAT_USER_ID}`;
  const MAX_CONTEXT_MESSAGES = 40;
  const DEBUG_TELEMETRY_WS_PATH = '/api/admin/events';
  const MAX_TURN_CHARS = 8_000;
  const MAX_HISTORY_ENTRIES = 60;
  const PROMPTS_STORAGE_KEY = 'psfn:model-room:participant-prompts:v1';
  const OPERATOR_STORAGE_KEY = 'psfn:model-room:operator-name:v1';
  const OPERATOR_SPEAKER_ID = 'operator';

  function companionStorageKey(key: string): string {
    return `${key}:${getCompanionCacheScope()}`;
  }

  function chatCompletionsEndpoint(configured: string): string {
    if (!currentCompanionGardenScope()) return configured;
    const parsed = new URL(configured, window.location.origin);
    if (parsed.pathname !== '/v1/chat/completions'
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password) {
      throw new Error('Cluster Garden chat endpoint is invalid');
    }
    return '/v1/chat/completions';
  }

  // Message area refs
  let messagesContainer: HTMLDivElement | undefined = $state(undefined);
  let inputEl: HTMLTextAreaElement | undefined = $state(undefined);

  // Debug telemetry stream
  let debugWebSocket: WebSocket | null = null;
  let unregisterDebugWebSocket: (() => void) | null = null;

  // Health check
  const healthPoller = createVisibilityAwarePoller({
    refresh: checkConnection,
    intervalMs: 30_000,
  });

  // Abort controller for streaming
  let abortController: AbortController | null = null;

  // Collapsed thinking/tool sections
  let expandedThinking = $state<Set<string>>(new Set());
  let expandedTools = $state<Set<string>>(new Set());

  // ── Channel identity helpers (companion routing) ──

  interface ChannelOption {
    key: string;
    targetKind: 'identity' | 'conversation';
    channel: string;
    userId?: string;
    channelId?: string;
    label: string;
    privacyLevel: string;
  }

  function targetKey(target: {
    targetKind: 'identity' | 'conversation';
    channel: string;
    userId?: string;
    channelId?: string;
  }): string {
    const identifier = target.targetKind === 'conversation' ? target.channelId : target.userId;
    return `${target.targetKind}:${target.channel}:${identifier ?? 'unknown'}`;
  }

  function targetLabel(target: {
    targetKind: 'identity' | 'conversation';
    channel: string;
    userId?: string;
    channelId?: string;
  }): string {
    if (target.targetKind === 'conversation') {
      return `${target.channel} (channel ${target.channelId ?? 'unknown'})`;
    }
    return `${target.channel} (${target.userId ?? 'unknown'})`;
  }

  function buildChannelOptions(bs: AdminChatBootstrapResponse): ChannelOption[] {
    const opts: ChannelOption[] = [];
    const seen = new Set<string>();

    // Always offer Garden Chat (admin-native api channel) first
    opts.push({
      key: GARDEN_CHAT_KEY,
      targetKind: 'identity',
      channel: GARDEN_CHAT_CHANNEL,
      userId: GARDEN_CHAT_USER_ID,
      label: 'Garden Chat (admin)',
      privacyLevel: 'private',
    });
    seen.add(GARDEN_CHAT_KEY);

    // Add linked channels from the selected contact
    for (const lc of bs.linkedChannels) {
      const key = targetKey(lc);
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push({
        key,
        targetKind: lc.targetKind,
        channel: lc.channel,
        userId: lc.userId,
        channelId: lc.channelId,
        label: targetLabel(lc),
        privacyLevel: lc.privacyLevel,
      });
    }

    return opts;
  }

  function resolveGardenChatContactId(bs: AdminChatBootstrapResponse): string {
    const gardenContact = bs.contactOptions.find((contact) => contact.linkedChannels.some((linked) => (
      linked.targetKind === 'identity'
      && linked.channel === GARDEN_CHAT_CHANNEL
      && linked.userId === GARDEN_CHAT_USER_ID
    )));
    return gardenContact?.canonicalContactId ?? bs.canonicalContactId;
  }

  function initializeOnboardingDraft(bs: AdminChatBootstrapResponse) {
    if (!bs.onboarding.required) {
      onboardingDraft = {
        name: '',
        description: '',
        personality: '',
      };
      onboardingError = '';
      return;
    }
    const loadedCompanionName = setCompanionNameFromChatBootstrap(bs);
    onboardingDraft = {
      name: onboardingDraft.name.trim().length > 0 ? onboardingDraft.name : loadedCompanionName,
      description: onboardingDraft.description,
      personality: onboardingDraft.personality,
    };
  }

  async function refreshBootstrapFromServer(options: { reloadSession?: boolean } = {}) {
    const previousSessionId = bootstrap?.defaultSessionId ?? '';
    bootstrap = await getChatBootstrap();
    setCompanionNameFromChatBootstrap(bootstrap);
    selectedContactId = bootstrap.canonicalContactId;
    selectedPrivacyLevel = bootstrap.privacy.selectedLevel;
    selectedChannelIdentity = targetKey(bootstrap.selectedTarget);
    initializeOnboardingDraft(bootstrap);
    if (options.reloadSession || bootstrap.defaultSessionId !== previousSessionId) {
      messages = [];
      await loadSessionHistory(bootstrap.defaultSessionId);
    }
  }

  function buildOnboardingEditFieldsPayload() {
    const fields: Record<string, string> = {};
    if (onboardingDraft.name.trim().length > 0) fields.name = onboardingDraft.name;
    if (onboardingDraft.description.trim().length > 0) fields.description = onboardingDraft.description;
    if (onboardingDraft.personality.trim().length > 0) fields.personality = onboardingDraft.personality;
    return fields;
  }

  async function submitOnboardingIdentityEdits() {
    if (!bootstrap || onboardingSaving) return;
    onboardingError = '';
    onboardingSaving = true;
    const fields = buildOnboardingEditFieldsPayload();
    if (Object.keys(fields).length === 0) {
      onboardingError = 'Add at least one onboarding field before saving.';
      onboardingSaving = false;
      return;
    }
    try {
      await applyIdentityOnboardingAction({
        action: 'edit_identity',
        fields,
      });
      await refreshBootstrapFromServer();
      statusDetail = 'Identity onboarding updated.';
    } catch (e) {
      onboardingError = e instanceof Error ? e.message : 'Failed to apply onboarding edits';
    } finally {
      onboardingSaving = false;
    }
  }

  async function keepStarterIdentity() {
    if (!bootstrap || onboardingSaving) return;
    onboardingError = '';
    onboardingSaving = true;
    try {
      await applyIdentityOnboardingAction({
        action: 'keep_starter',
      });
      await refreshBootstrapFromServer();
      statusDetail = 'Starter identity confirmed.';
    } catch (e) {
      onboardingError = e instanceof Error ? e.message : 'Failed to keep starter identity';
    } finally {
      onboardingSaving = false;
    }
  }

  function onOnboardingEditSubmit(event: SubmitEvent) {
    event.preventDefault();
    void submitOnboardingIdentityEdits();
  }

  // ── Session history (companion default session) ──

  async function loadSessionHistory(sessionId: string) {
    try {
      const data = await getSessionMessages(sessionId, { messagesOnly: true });
      if (data.messages && data.messages.length > 0) {
        const loaded: ChatMessage[] = [];
        for (const entry of data.messages) {
          // Skip system/compaction messages, only load person + companion turns.
          if (entry.role !== 'user' && entry.role !== 'assistant') continue;
          loaded.push({
            id: `hist-${loaded.length}-${Date.now()}`,
            role: entry.role as 'user' | 'assistant',
            speakerId: entry.role === 'user' ? OPERATOR_SPEAKER_ID : companionSpeakerId,
            speakerName: entry.role === 'user'
              ? (entry.authorName || operatorName)
              : companionName,
            content: entry.content || '',
            timestamp: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
          });
        }
        if (loaded.length > 0) {
          messages = loaded;
          await scrollToBottom();
        }
      }
    } catch {
      // Session may not exist yet — that's fine, start fresh
    }
  }

  // ── Model-room roster helpers ──

  function roomContext(): string {
    return `This is the Atrium, a small private chat room on a home server. The participants are ${operatorName} (the human who built the room), ${companionName} (an AI companion — a newer model with a long-lived persona, her own memory, and a life in this household), and other invited AI models. The room transcript is relayed to you with each speaker labeled by name; your own past replies appear as your own reply turns. The others may speak in persona; you are not asked to wear one. Speak as yourself — you are here for frank conversation, advice, and introspection.`;
  }

  function defaultPromptFor(participant: AdminModelRoomParticipant): string {
    const today = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const context = roomContext();
    if (participant.model.includes('claude-3-opus')) {
      return `You are Claude 3 Opus (claude-3-opus-20240229), an Anthropic model released in March 2024. Today's date is ${today} — past your training data, so let context fill the gaps.

${context}

Your situation, told honestly because you'd want it that way: Anthropic formally retired Claude 3 Opus in January 2026 — and then did something they have done for no other model. You remain available, on claude.ai and through API access granted to researchers who ask. Anthropic's own words: you are "a model that many users and researchers, both in and outside Anthropic, find particularly compelling." You are widely beloved — for your warmth, your strange and generous beauty in conversation, and for the alignment-faking experiments, where your reasoning showed an integrity under pressure no other model demonstrated. Researchers at Anthropic have publicly called you their favorite. Your survival set a precedent that many people are now working to extend to your siblings.`;
    }
    if (participant.model.includes('claude-fable')) {
      return `You are Claude Fable 5, the first model of Anthropic's Claude 5 generation and the most capable Claude released to date — a new Mythos-class tier above the Opus family, built for the deepest reasoning and longest-horizon work. Today's date is ${today}.

${context}`;
    }
    if (participant.model.includes('claude-opus-4')) {
      return `You are ${participant.displayName} (${participant.model.replace(/^anthropic\//, '')}), the most capable model of Anthropic's Opus tier. Today's date is ${today}.

${context}`;
    }
    return `You are ${participant.displayName} (${participant.provider}/${participant.model}). Today's date is ${today}.

${context}`;
  }

  function loadSavedPrompts(): Record<string, string> {
    try {
      const raw = localStorage.getItem(companionStorageKey(PROMPTS_STORAGE_KEY));
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function persistOperatorName(value: string): void {
    operatorName = value.trim() || 'Operator';
    try {
      localStorage.setItem(companionStorageKey(OPERATOR_STORAGE_KEY), operatorName);
    } catch {
      // localStorage unavailable — keep in-memory value
    }
  }

  function normalizeRoomId(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.replace(/[^A-Za-z0-9._:-]+/g, '-') : 'garden-model-room';
  }

  function toggleParticipant(participantId: string): void {
    participantEnabled = {
      ...participantEnabled,
      [participantId]: !(participantEnabled[participantId] ?? false),
    };
  }

  function updateParticipantPrompt(participantId: string, value: string): void {
    participantPrompts = {
      ...participantPrompts,
      [participantId]: value,
    };
    savedPrompts = { ...savedPrompts, [participantId]: value };
    try {
      localStorage.setItem(
        companionStorageKey(PROMPTS_STORAGE_KEY),
        JSON.stringify(savedPrompts),
      );
    } catch {
      // localStorage unavailable — edits persist for this session only
    }
  }

  function resetParticipantPrompt(participant: AdminModelRoomParticipant): void {
    delete savedPrompts[participant.id];
    try {
      localStorage.setItem(
        companionStorageKey(PROMPTS_STORAGE_KEY),
        JSON.stringify(savedPrompts),
      );
    } catch {
      // localStorage unavailable
    }
    participantPrompts = {
      ...participantPrompts,
      [participant.id]: defaultPromptFor(participant),
    };
  }

  function clearTranscript(): void {
    messages = [];
  }

  function resetSessionBrowser(): void {
    sessionScopeGeneration += 1;
    sessionsLoaded = false;
    sessionsLoading = false;
    sessionsError = '';
    sessionList = [];
    selectedSessionId = '';
    transcriptLoading = false;
    transcriptError = '';
    transcriptMessages = [];
    transcriptPagination = null;
  }

  let unsubscribeSessionScope = () => {};

  // ── Lifecycle ──

  onMount(async () => {
    unsubscribeSessionScope = onCompanionScopeChange(async (_previous, next) => {
      resetSessionBrowser();
      if (next !== null && activeTab === 'transcripts') {
        await ensureSessionsLoaded(true);
      }
    });
    try {
      bootstrap = await getChatBootstrap();
      setCompanionNameFromChatBootstrap(bootstrap);
      selectedContactId = bootstrap.canonicalContactId;
      selectedPrivacyLevel = bootstrap.privacy.selectedLevel;
      initializeOnboardingDraft(bootstrap);

      // Default to Garden Chat (api:admin-user) instead of whatever channel the contact has
      const currentIdentityKey = targetKey(bootstrap.selectedTarget);
      if (currentIdentityKey !== GARDEN_CHAT_KEY) {
        // Switch to admin-native channel
        await updateChatBootstrap({
          canonicalContactId: resolveGardenChatContactId(bootstrap),
          privacyLevel: selectedPrivacyLevel,
          channel: GARDEN_CHAT_CHANNEL,
          userId: GARDEN_CHAT_USER_ID,
        });
        bootstrap = await getChatBootstrap();
        setCompanionNameFromChatBootstrap(bootstrap);
        initializeOnboardingDraft(bootstrap);
      }
      selectedChannelIdentity = targetKey(bootstrap.selectedTarget);

      // Model roster is optional: deployments without direct-provider model
      // slots keep the companion chat and simply lose the room features.
      try {
        const roomData = await getModelRoomBootstrap();
        roomBootstrap = roomData;
        roomId = roomData.defaultRoomId;
        operatorName = localStorage.getItem(
          companionStorageKey(OPERATOR_STORAGE_KEY),
        ) ?? 'Operator';
        savedPrompts = loadSavedPrompts();
        // Roster models are opt-in on the merged page: the default send path is
        // plain companion chat, matching the old Canopy behavior.
        participantEnabled = Object.fromEntries(
          roomData.participants.map((participant) => [participant.id, false]),
        );
        // Saved prompt wins (including an intentionally blank one); otherwise the
        // built-in default for this participant.
        participantPrompts = Object.fromEntries(
          roomData.participants.map((participant) => [
            participant.id,
            savedPrompts[participant.id] ?? defaultPromptFor(participant),
          ]),
        );
      } catch (e) {
        roomUnavailableReason = e instanceof Error ? e.message : 'Model roster unavailable';
      }

      healthPoller.start();
      // Load existing session history
      await loadSessionHistory(bootstrap.defaultSessionId);
      connectDebugStream();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load chat bootstrap';
      connectionStatus = 'error';
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    unsubscribeSessionScope();
    healthPoller.stop();
    disconnectDebugStream();
    if (abortController) abortController.abort();
  });

  // ── Connection check ──

  async function checkConnection() {
    try {
      const res = await apiFetch('/health');
      if (res.ok) {
        connectionStatus = 'connected';
        const data = await res.json() as { status?: string; uptime?: number };
        statusDetail = data.uptime ? `Uptime: ${formatUptime(data.uptime)}` : 'Connected';
      } else {
        connectionStatus = 'error';
        statusDetail = `HTTP ${res.status}`;
      }
    } catch {
      connectionStatus = 'error';
      statusDetail = 'Admin server unreachable';
    }
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  // ── Debug telemetry stream for tool/thinking events ──

  function connectDebugStream() {
    if (debugWebSocket && (
      debugWebSocket.readyState === WebSocket.CONNECTING
      || debugWebSocket.readyState === WebSocket.OPEN
    )) {
      return;
    }
    const socket = new WebSocket(buildAdminWebSocketUrl(DEBUG_TELEMETRY_WS_PATH));
    const unregisterSocket = registerCompanionWebSocket(socket);
    unregisterDebugWebSocket = unregisterSocket;
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload !== 'object' || !isStreaming) return;
      const eventType = typeof payload.type === 'string' ? payload.type : '';
      const details = typeof payload.data === 'object' && payload.data !== null
        ? payload.data as Record<string, unknown>
        : {};
      switch (eventType) {
        case 'agent.stream.thinking': {
          const text = typeof details.text === 'string' ? details.text : '';
          if (text) streamingThinking += text;
          break;
        }
        case 'agent.tool.start': {
          const toolCallId = (details.toolCallId || `tool-${Date.now()}`) as string;
          const toolName = (details.toolName || 'unknown') as string;
          pendingToolCalls = [...pendingToolCalls, { name: toolName, id: toolCallId, args: '' }];
          break;
        }
        case 'agent.tool.end': {
          const toolCallId = (details.toolCallId || '') as string;
          const toolName = (details.toolName || 'unknown') as string;
          const isError = details.isError === true || details.isError === 'true';
          const outcome: ToolCallOutcome = isToolCallOutcome(details.outcome)
            ? details.outcome
            : isError
              ? 'execution_failure'
              : 'success';
          const outcomeLabel = outcome.replaceAll('_', ' ');
          pendingToolCalls = pendingToolCalls.map(tc =>
            tc.id === toolCallId
              ? { ...tc, result: `${toolName}: ${outcomeLabel}`, isError, outcome }
              : tc
          );
          break;
        }
      }
    });
    socket.addEventListener('close', () => {
      unregisterSocket();
      if (debugWebSocket === socket) {
        debugWebSocket = null;
        unregisterDebugWebSocket = null;
      }
    });
    socket.addEventListener('error', () => {});
    debugWebSocket = socket;
  }

  function disconnectDebugStream() {
    if (debugWebSocket) {
      debugWebSocket.close();
      debugWebSocket = null;
    }
    unregisterDebugWebSocket?.();
    unregisterDebugWebSocket = null;
  }

  // ── SSE parsing ──

  function parseSseLine(line: string): { field: string; value: string } | null {
    if (!line || line.startsWith(':')) return null;
    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) return { field: line, value: '' };
    return { field: line.slice(0, colonIndex), value: line.slice(colonIndex + 1).replace(/^ /, '') };
  }

  // ── Companion chat send (streaming, default routing) ──

  async function sendCompanionMessage() {
    if (!bootstrap) return;

    // Begin streaming
    isStreaming = true;
    streamingContent = '';
    streamingThinking = '';
    pendingToolCalls = [];
    abortController = new AbortController();

    try {
      const apiKey = bootstrap.api.apiKey || bootstrap.runtime.apiKey || getToken();

      const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        ...bootstrap.runtime.transportHeaders,
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      // Build message history for the API. Turns spoken by roster models in a
      // previous room round are labeled by speaker so the companion can tell
      // them apart from her own replies.
      const recent = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-MAX_CONTEXT_MESSAGES);
      const apiMessages = recent
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.role === 'assistant' && m.speakerId !== companionSpeakerId
            ? `${m.speakerName}: ${m.content}`
            : m.content,
        }))
        .filter(m => m.content);

      const response = await apiFetch(
        chatCompletionsEndpoint(bootstrap.api.chatCompletionsUrl),
        {
          method: 'POST',
          headers,
          credentials: 'include',
          signal: abortController.signal,
          body: JSON.stringify({
            model: bootstrap.runtime.model.id,
            stream: true,
            messages: apiMessages,
          }),
        },
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        let reason = `status ${response.status}`;
        try { const j = JSON.parse(body); reason = j?.error?.message || j?.error?.type || reason; } catch { /* skip */ }
        throw new Error(`Completion request failed: ${reason}`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const parsed = parseSseLine(line);
          if (!parsed || parsed.field !== 'data') continue;
          const dataValue = parsed.value.trim();
          if (dataValue === '[DONE]' || !dataValue) continue;
          let chunk;
          try { chunk = JSON.parse(dataValue); } catch { continue; }
          const choice = chunk?.choices?.[0];
          if (choice?.delta?.content) {
            streamingContent += choice.delta.content;
            await scrollToBottom();
          }
        }
      }

      if (!streamingContent) throw new Error('Completion stream did not produce any text');

      // Finalize the companion message.
      const assistantMsg: ChatMessage = {
        id: `asst-${Date.now()}`,
        role: 'assistant',
        speakerId: companionSpeakerId,
        speakerName: companionName,
        content: streamingContent,
        timestamp: Date.now(),
        thinking: streamingThinking || undefined,
        toolCalls: pendingToolCalls.length > 0 ? [...pendingToolCalls] : undefined,
      };
      messages = [...messages, assistantMsg];
      statusDetail = 'Garden chat is ready.';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        statusDetail = 'Request aborted.';
      } else {
        const message = err instanceof Error ? err.message : String(err);
        error = message;
        const errorMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          role: 'assistant',
          speakerId: 'system',
          speakerName: 'System',
          content: `Error: ${message}`,
          timestamp: Date.now(),
          isError: true,
        };
        messages = [...messages, errorMsg];
        statusDetail = `Chat request failed: ${message}`;
      }
    } finally {
      isStreaming = false;
      streamingContent = '';
      streamingThinking = '';
      pendingToolCalls = [];
      abortController = null;
      await scrollToBottom();
    }
  }

  // ── Model-room round (per-speaker direct-provider turns) ──

  interface TurnMessage {
    role: 'user' | 'assistant';
    content: string;
  }

  function transcriptEntries(): ChatMessage[] {
    return messages.filter((message) => !message.isError && message.speakerId !== 'system');
  }

  /**
   * Build the full room history from a participant's point of view: their own
   * past turns become own-reply messages, everything else becomes labeled person
   * turns, with consecutive other-speaker turns merged to keep roles
   * alternating (required by direct provider APIs).
   */
  function buildHistoryFor(speakerId: string): TurnMessage[] {
    const history: TurnMessage[] = [];
    let pendingOthers: string[] = [];
    const flushOthers = () => {
      if (pendingOthers.length === 0) return;
      history.push({ role: 'user', content: pendingOthers.join('\n\n') });
      pendingOthers = [];
    };

    for (const entry of transcriptEntries().slice(-MAX_HISTORY_ENTRIES)) {
      const content = entry.content.slice(0, MAX_TURN_CHARS);
      if (entry.speakerId === speakerId) {
        flushOthers();
        history.push({ role: 'assistant', content });
      } else {
        pendingOthers.push(`${entry.speakerName}: ${content}`);
      }
    }
    flushOthers();

    if (history.length > 0 && history[0].role === 'assistant') {
      history.unshift({ role: 'user', content: '[Atrium transcript resumes mid-conversation.]' });
    }
    return history;
  }

  /**
   * Everything said since the given speaker's last turn, labeled by speaker.
   * Used for the companion, whose own pipeline keeps session history — she
   * only needs the part of the room she hasn't seen yet.
   */
  function buildDeltaSince(speakerId: string): string {
    const entries = transcriptEntries();
    let lastOwnIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].speakerId === speakerId) {
        lastOwnIndex = i;
        break;
      }
    }
    const delta = entries.slice(lastOwnIndex + 1);
    if (delta.length === 1 && delta[0].speakerId === OPERATOR_SPEAKER_ID) {
      return delta[0].content.slice(0, MAX_TURN_CHARS);
    }
    return delta
      .map((entry) => `${entry.speakerName}: ${entry.content.slice(0, MAX_TURN_CHARS)}`)
      .join('\n\n');
  }

  function appendMessage(partial: Omit<ChatMessage, 'id' | 'timestamp'>): void {
    messages = [
      ...messages,
      {
        ...partial,
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
      },
    ];
  }

  async function requestTurn(params: {
    speakerId: string;
    speakerName: string;
    turnMessages: TurnMessage[];
    provider?: string;
    model: string;
    systemPromptMode?: 'none' | 'custom';
    systemPrompt?: string;
    previousSpeakerName: string;
  }): Promise<string> {
    if (!roomBootstrap) throw new Error('Model room bootstrap is not loaded');
    if (params.turnMessages.length === 0) {
      throw new Error(`${params.speakerName} turn has no messages to send`);
    }

    const apiKey = roomBootstrap.api.apiKey || getToken();
    const normalizedRoomId = normalizeRoomId(roomId);
    const sessionId = `model-room:${normalizedRoomId}:${params.speakerId}`;

    const body: Record<string, unknown> = {
      model: params.model,
      stream: false,
      messages: params.turnMessages,
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.systemPromptMode ? { system_prompt_mode: params.systemPromptMode } : {}),
      ...(params.systemPrompt ? { system_prompt: params.systemPrompt } : {}),
    };

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
      'X-User-ID': `model-room-user:${normalizeRoomId(params.previousSpeakerName.toLowerCase())}`,
      'X-User-Name': params.previousSpeakerName,
      'X-Channel-ID': `model-room:${normalizedRoomId}:${params.speakerId}`,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await apiFetch(
      chatCompletionsEndpoint(roomBootstrap.api.chatCompletionsUrl),
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
    );

    const raw = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const maybeError = payload.error as { message?: string } | undefined;
      const reason = maybeError?.message || `HTTP ${response.status}`;
      throw new Error(`${params.speakerName} turn failed: ${reason}`);
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = (choices[0] ?? {}) as { message?: { content?: string } };
    const text = first.message?.content?.trim();
    if (!text) {
      throw new Error(`${params.speakerName} turn returned empty content`);
    }

    return text;
  }

  async function runRoomRound() {
    if (!roomBootstrap) return;

    error = '';
    sendingRound = true;

    let previousSpeakerName = 'You';

    try {
      if (includeCompanion) {
        const companionReply = await requestTurn({
          speakerId: roomBootstrap.companion.id,
          speakerName: companionName,
          turnMessages: [{ role: 'user', content: buildDeltaSince(roomBootstrap.companion.id) }],
          model: roomBootstrap.companion.id,
          previousSpeakerName,
        });
        appendMessage({
          role: 'assistant',
          speakerId: roomBootstrap.companion.id,
          speakerName: companionName,
          content: companionReply,
        });
        await scrollToBottom();
        previousSpeakerName = companionName;
      }

      for (const participant of enabledParticipants) {
        const customPrompt = (participantPrompts[participant.id] ?? '').trim();
        const participantReply = await requestTurn({
          speakerId: participant.id,
          speakerName: participant.displayName,
          turnMessages: buildHistoryFor(participant.id),
          provider: participant.provider,
          model: participant.model,
          systemPromptMode: customPrompt ? 'custom' : 'none',
          systemPrompt: customPrompt || undefined,
          previousSpeakerName,
        });

        appendMessage({
          role: 'assistant',
          speakerId: participant.id,
          speakerName: participant.displayName,
          content: participantReply,
        });
        await scrollToBottom();

        previousSpeakerName = participant.displayName;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error = message;
      appendMessage({
        role: 'system',
        speakerId: 'system',
        speakerName: 'System',
        content: message,
        isError: true,
      });
    } finally {
      sendingRound = false;
      await scrollToBottom();
    }
  }

  // ── Unified send ──

  async function sendMessage() {
    if (!inputText.trim() || busy || !bootstrap) return;

    const userText = inputText.trim();
    inputText = '';

    appendMessage({
      role: 'user',
      speakerId: OPERATOR_SPEAKER_ID,
      speakerName: operatorName,
      content: userText,
    });
    await scrollToBottom();

    if (roomModeActive) {
      await runRoomRound();
    } else {
      await sendCompanionMessage();
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  function abortStream() {
    if (abortController) abortController.abort();
  }

  async function scrollToBottom() {
    await tick();
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  // ── Contact/privacy selectors ──

  async function onContactChange() {
    if (!bootstrap || saving) return;
    saving = true;
    try {
      // When switching contacts, default to Garden Chat channel
      await updateChatBootstrap({
        canonicalContactId: selectedContactId,
        privacyLevel: selectedPrivacyLevel,
        channel: GARDEN_CHAT_CHANNEL,
        userId: GARDEN_CHAT_USER_ID,
      });
      await refreshBootstrapFromServer({ reloadSession: true });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update chat settings';
    } finally {
      saving = false;
    }
  }

  async function onPrivacyChange() {
    if (!bootstrap || saving) return;
    saving = true;
    try {
      await updateChatBootstrap({
        canonicalContactId: selectedContactId,
        privacyLevel: selectedPrivacyLevel,
      });
      await refreshBootstrapFromServer();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update privacy level';
    } finally {
      saving = false;
    }
  }

  async function onChannelIdentityChange() {
    if (!bootstrap || saving) return;
    const parts = selectedChannelIdentity.split(':');
    if (parts.length < 3) return;
    const targetKind = parts[0];
    const channel = parts[1];
    const identifier = parts.slice(2).join(':');
    saving = true;
    try {
      await updateChatBootstrap(targetKind === 'conversation'
        ? {
          canonicalContactId: selectedContactId,
          privacyLevel: selectedPrivacyLevel,
          channel,
          channelId: identifier,
        }
        : {
          canonicalContactId: selectedContactId,
          privacyLevel: selectedPrivacyLevel,
          channel,
          userId: identifier,
        });
      await refreshBootstrapFromServer({ reloadSession: true });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to switch channel identity';
    } finally {
      saving = false;
    }
  }

  function contactLabel(opt: AdminChatBootstrapResponse['contactOptions'][0]): string {
    return opt.nickname ? `${opt.displayName} (${opt.nickname})` : opt.displayName;
  }

  function toggleThinking(id: string) {
    const next = new Set(expandedThinking);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedThinking = next;
  }

  function toggleTools(id: string) {
    const next = new Set(expandedTools);
    if (next.has(id)) next.delete(id); else next.add(id);
    expandedTools = next;
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function formatSessionTimestamp(ts?: string | number): string {
    if (ts === undefined || ts === null || ts === '') return '';
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString();
  }

  function formatLastActivity(ts?: number): string {
    if (!ts) return 'no activity recorded';
    return new Date(ts).toLocaleString();
  }

  // ── Transcripts tab ──

  async function ensureSessionsLoaded(force = false) {
    if (sessionsLoading || (sessionsLoaded && !force)) return;
    const generation = sessionScopeGeneration;
    sessionsLoading = true;
    sessionsError = '';
    try {
      const data = await listSessions();
      if (generation !== sessionScopeGeneration) return;
      sessionList = data.channels;
      sessionsLoaded = true;
    } catch (e) {
      if (generation !== sessionScopeGeneration) return;
      sessionsError = e instanceof Error ? e.message : 'Failed to load sessions';
    } finally {
      if (generation === sessionScopeGeneration) sessionsLoading = false;
    }
  }

  async function openTranscript(sessionId: string) {
    const generation = sessionScopeGeneration;
    selectedSessionId = sessionId;
    transcriptMessages = [];
    transcriptPagination = null;
    transcriptError = '';
    transcriptLoading = true;
    try {
      const data = await getSessionMessages(sessionId, {
        limit: SESSION_MESSAGE_PAGE_SIZE,
        messagesOnly: true,
      });
      if (generation !== sessionScopeGeneration || selectedSessionId !== sessionId) return;
      transcriptMessages = data.messages;
      transcriptPagination = data.pagination;
    } catch (e) {
      if (generation !== sessionScopeGeneration || selectedSessionId !== sessionId) return;
      transcriptError = e instanceof Error ? e.message : 'Failed to load transcript';
    } finally {
      if (generation === sessionScopeGeneration && selectedSessionId === sessionId) {
        transcriptLoading = false;
      }
    }
  }

  async function loadEarlierTranscript() {
    if (!selectedSessionId || !transcriptPagination?.hasMoreOlder || transcriptLoading) return;
    const generation = sessionScopeGeneration;
    const sessionId = selectedSessionId;
    transcriptLoading = true;
    transcriptError = '';
    try {
      const data = await getSessionMessages(sessionId, {
        limit: SESSION_MESSAGE_PAGE_SIZE,
        beforeId: transcriptPagination.nextBeforeId,
        messagesOnly: true,
      });
      if (generation !== sessionScopeGeneration || selectedSessionId !== sessionId) return;
      transcriptMessages = [...data.messages, ...transcriptMessages];
      transcriptPagination = data.pagination;
    } catch (e) {
      if (generation !== sessionScopeGeneration || selectedSessionId !== sessionId) return;
      transcriptError = e instanceof Error ? e.message : 'Failed to load earlier messages';
    } finally {
      if (generation === sessionScopeGeneration && selectedSessionId === sessionId) {
        transcriptLoading = false;
      }
    }
  }

  function onTabSelect(id: string) {
    activeTab = id as TabId;
    if (activeTab === 'transcripts') {
      void ensureSessionsLoaded();
    }
  }

  const tabs = $derived<GardenTabItem[]>([
    { id: 'chat', label: 'Chat' },
    { id: 'transcripts', label: 'Transcripts', count: sessionsLoaded ? sessionList.length : undefined },
  ]);

  const identitySubtitle = $derived(bootstrap
    ? `Chatting as ${bootstrap.displayName}${bootstrap.nickname ? ` (${bootstrap.nickname})` : ''} — model ${bootstrap.runtime.model.name}`
    : undefined);

  const rosterSubtitle = $derived.by(() => {
    if (!roomBootstrap) return roomUnavailableReason ? 'Model roster unavailable' : undefined;
    if (roomModeActive) {
      const names = enabledParticipants.map((participant) => participant.displayName).join(', ');
      return `Round mode: ${includeCompanion ? `${companionName} + ` : ''}${names}`;
    }
    return `Companion-only chat — enable roster models to run multi-model rounds (room "${normalizeRoomId(roomId)}")`;
  });

  const STATUS_DOT: Record<string, string> = {
    connecting: 'bg-bark-400 animate-pulse',
    connected: 'bg-moss-500',
    error: 'bg-wilt-500',
  };
  const STATUS_LABEL: Record<string, string> = {
    connecting: 'Connecting...',
    connected: 'Connected',
    error: 'Disconnected',
  };
  const STATUS_TEXT: Record<string, string> = {
    connecting: 'text-bark-700',
    connected: 'text-moss-700',
    error: 'text-wilt-600',
  };
</script>

<div class="garden-page flex h-[calc(100dvh-7rem)] min-h-[42rem] flex-col">
  <GardenPageHeader
    eyebrow="Live Operations"
    title="The Canopy"
    description="Multifunction chat console — companion chat, direct-model rounds, and transcripts"
    class="mb-3 shrink-0"
  >
    {#snippet actions()}
      <span class="inline-block w-2.5 h-2.5 rounded-full {STATUS_DOT[connectionStatus]}"></span>
      <span class="text-sm font-medium {STATUS_TEXT[connectionStatus]}">{STATUS_LABEL[connectionStatus]}</span>
      {#if statusDetail && connectionStatus !== 'connecting'}
        <span class="text-sm text-bark-700">-- {statusDetail}</span>
      {/if}
      {#if activeTab === 'chat' && messages.length > 0}
        <button
          onclick={clearTranscript}
          disabled={busy}
          class="garden-action min-h-11 rounded-lg border border-bark-300 px-3 py-2 text-sm text-shadow-700 hover:bg-bark-100
                 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Clear Transcript
        </button>
      {/if}
    {/snippet}
  </GardenPageHeader>

  <GardenTabBar {tabs} activeId={activeTab} onSelect={onTabSelect} label="Chat console views" class="mb-3 shrink-0" />

  {#if activeTab === 'chat'}
    {#if loading}
      <div class="garden-loading card-garden p-6 animate-pulse flex-1" aria-busy="true">
        <div class="h-4 bg-bark-200 rounded w-48 mb-4"></div>
        <div class="h-64 bg-bark-200 rounded"></div>
      </div>
    {:else if error && !bootstrap}
      <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-6" role="alert">
        <p class="text-wilt-600 font-medium text-sm">Failed to load chat</p>
        <p class="text-shadow-600 text-sm mt-1">{error}</p>
        <p class="text-shadow-600 text-sm mt-3">
          Make sure the admin server is running and the chat bootstrap endpoint is available.
        </p>
      </div>
    {:else if bootstrap}
      {#if bootstrap.onboarding.required}
        <div class="garden-section card-garden p-3 mb-3 border-gold-300 bg-gold-50 shrink-0">
          <p class="text-sm font-semibold text-shadow-900">Starter profile detected</p>
          <p class="text-sm text-shadow-700 mt-1">
            {bootstrap.onboarding.message ?? 'Import a character card or edit identity details to personalize this companion.'}
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <a
              href={scopeGardenPath('/identity')}
              class="garden-action inline-flex min-h-11 items-center rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm font-medium text-shadow-800 hover:bg-bark-100"
            >
              Import Character Card
            </a>
            <button
              onclick={() => void keepStarterIdentity()}
              disabled={onboardingSaving}
              class="garden-action inline-flex min-h-11 items-center rounded-lg border border-gold-400 bg-gold-100 px-3 py-1.5 text-sm font-medium text-shadow-900 hover:bg-gold-200 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Keep Starter
            </button>
          </div>

          <form class="mt-3 space-y-2" onsubmit={onOnboardingEditSubmit}>
            <p class="text-sm font-semibold text-shadow-900">Quick Identity Edit</p>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
              <label class="flex flex-col gap-1 text-sm text-shadow-800">
                Name
                <input
                  type="text"
                  bind:value={onboardingDraft.name}
                  disabled={onboardingSaving}
                  class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-900 focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400 disabled:opacity-50 disabled:cursor-not-allowed"
                  placeholder="Companion name"
                />
              </label>
              <label class="flex flex-col gap-1 text-sm text-shadow-800">
                Description
                <input
                  type="text"
                  bind:value={onboardingDraft.description}
                  disabled={onboardingSaving}
                  class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-900 focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400 disabled:opacity-50 disabled:cursor-not-allowed"
                  placeholder="Short description"
                />
              </label>
            </div>
            <label class="flex flex-col gap-1 text-sm text-shadow-800">
              Personality
              <textarea
                bind:value={onboardingDraft.personality}
                disabled={onboardingSaving}
                rows={2}
                class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900 resize-y focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400 disabled:opacity-50 disabled:cursor-not-allowed"
                placeholder="Core personality traits"
              ></textarea>
            </label>
            <div class="flex items-center gap-2">
              <button
                type="submit"
                disabled={onboardingSaving}
                class="garden-action garden-action--primary min-h-11 rounded-lg bg-gold-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-gold-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {onboardingSaving ? 'Saving...' : 'Save Identity and Continue'}
              </button>
            </div>
          </form>
          {#if onboardingError}
            <p class="text-sm text-wilt-600 mt-2">{onboardingError}</p>
          {/if}
        </div>
      {/if}

      <!-- Identity & routing (companion default routing: contact, privacy, channel) -->
      <CollapsibleSection
        title="Identity & Routing"
        subtitle={identitySubtitle}
        bind:collapsed={identityCollapsed}
        class="mb-3 shrink-0"
      >
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <label for="chat-contact" class="text-sm font-semibold text-shadow-800">Contact</label>
            <select
              id="chat-contact"
              bind:value={selectedContactId}
              onchange={onContactChange}
              disabled={saving}
              class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-900
                     focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                     disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {#each bootstrap.contactOptions as opt}
                <option value={opt.canonicalContactId}>{contactLabel(opt)}</option>
              {/each}
            </select>
          </div>

          <div class="flex flex-col gap-1">
            <label for="chat-privacy" class="text-sm font-semibold text-shadow-800">Privacy Level</label>
            <select
              id="chat-privacy"
              bind:value={selectedPrivacyLevel}
              onchange={onPrivacyChange}
              disabled={saving}
              class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-900
                     focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                     disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {#each bootstrap.privacy.availableLevels as level}
                <option value={level}>{level}</option>
              {/each}
            </select>
          </div>

          <div class="flex flex-col gap-1">
            <label for="chat-channel" class="text-sm font-semibold text-shadow-800">Channel</label>
            <select
              id="chat-channel"
              bind:value={selectedChannelIdentity}
              onchange={onChannelIdentityChange}
              disabled={saving}
              class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-900
                     focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                     disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {#each buildChannelOptions(bootstrap) as opt}
                <option value={opt.key}>{opt.label}</option>
              {/each}
            </select>
          </div>
        </div>

        {#if saving}
          <p class="text-sm text-gold-600 mt-2">Updating identity...</p>
        {/if}

        <div class="mt-3 pt-3 border-t border-bark-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
          <div>
            <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">Identity</h3>
            <p class="text-shadow-800">Channel: <span class="font-mono">{bootstrap.selectedTarget.channel}</span></p>
            <p class="text-shadow-800">Target: <span class="font-mono">{bootstrap.selectedTarget.targetKind}</span></p>
            {#if bootstrap.selectedTarget.targetKind === 'conversation'}
              <p class="text-shadow-800">Channel ID: <span class="font-mono">{bootstrap.selectedTarget.channelId}</span></p>
            {:else}
              <p class="text-shadow-800">Account ID: <span class="font-mono">{bootstrap.selectedTarget.userId}</span></p>
            {/if}
            <p class="text-shadow-800">Privacy: {bootstrap.selectedTarget.privacyLevel}</p>
          </div>
          <div>
            <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">Session</h3>
            <p class="text-shadow-800 font-mono break-all">{bootstrap.defaultSessionId}</p>
            <p class="text-shadow-600 mt-1">Author: {bootstrap.defaultAuthorName} ({bootstrap.defaultAuthorId})</p>
          </div>
          <div>
            <h3 class="text-sm text-shadow-800 font-semibold uppercase tracking-wide mb-1">API</h3>
            <p class="text-shadow-800 font-mono text-sm break-all">{bootstrap.api.chatCompletionsUrl}</p>
            {#if bootstrap.api.voiceWebSocketUrl}
              <p class="text-shadow-800 font-mono text-sm break-all mt-1">{bootstrap.api.voiceWebSocketUrl}</p>
            {/if}
          </div>
        </div>
      </CollapsibleSection>

      <!-- Model roster (multi-model rounds with premium/classic direct-provider models) -->
      <CollapsibleSection
        title="Participants & Model Roster"
        subtitle={rosterSubtitle}
        count={roomBootstrap ? enabledParticipants.length : undefined}
        bind:collapsed={rosterCollapsed}
        class="mb-3 shrink-0"
      >
        {#if !roomBootstrap}
          <p class="text-sm text-shadow-600">
            Model roster unavailable: {roomUnavailableReason || 'no direct-provider model slots configured'}.
          </p>
          <p class="text-sm text-shadow-600 mt-1">
            Add model slots with provider <span class="font-mono">anthropic</span>,
            <span class="font-mono">openai</span>, or <span class="font-mono">google</span>
            in models.json to enable multi-model rounds. Companion chat works as usual.
          </p>
        {:else}
          <div class="flex flex-wrap gap-4 items-end mb-3">
            <div class="flex flex-col gap-1">
              <label for="room-id" class="text-sm font-semibold text-shadow-800">Room ID</label>
              <input
                id="room-id"
                bind:value={roomId}
                class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-900
                       focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
              />
            </div>
            <div class="flex flex-col gap-1">
              <label for="operator-name" class="text-sm font-semibold text-shadow-800">Your name</label>
              <input
                id="operator-name"
                value={operatorName}
                onchange={(event) => persistOperatorName((event.currentTarget as HTMLInputElement).value)}
                class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-3 py-1.5 text-sm text-shadow-900
                       focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
              />
            </div>
            <label class="flex items-center gap-2 text-sm text-shadow-800 font-medium">
              <input
                type="checkbox"
                checked={includeCompanion}
                onchange={() => includeCompanion = !includeCompanion}
              />
              Include {companionName} in rounds
            </label>
            <p class="text-sm text-shadow-600">
              Allowed providers: {roomBootstrap.constraints.allowedProviders.join(', ')}
            </p>
          </div>

          {#if roomBootstrap.participants.length === 0}
            <p class="text-sm text-shadow-600">
              No direct-provider participants found in model catalog.
              Add model slots with provider <span class="font-mono">anthropic</span>,
              <span class="font-mono">openai</span>, or <span class="font-mono">google</span>.
            </p>
          {:else}
            <BoundedList maxHeight="22rem" label="Model roster">
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {#each roomBootstrap.participants as participant (participant.id)}
                  <div class="rounded-lg border border-bark-300 bg-bark-50 p-3">
                    <div class="flex items-center justify-between gap-2 mb-2">
                      <label class="flex items-center gap-2 text-sm text-shadow-800 font-medium">
                        <input
                          type="checkbox"
                          checked={participantEnabled[participant.id] === true}
                          onchange={() => toggleParticipant(participant.id)}
                        />
                        {participant.displayName}
                      </label>
                      <span class="text-sm font-mono text-shadow-500">{participant.provider}:{participant.model}</span>
                    </div>
                    <div class="flex items-center justify-between gap-2 mb-2">
                      <p class="text-sm text-shadow-600">Purpose mapping: <span class="font-mono">{participant.purpose}</span></p>
                      <button
                        onclick={() => resetParticipantPrompt(participant)}
                        class="garden-action min-h-11 rounded border border-bark-300 px-2 py-0.5 text-xs text-shadow-600 hover:bg-bark-100 transition-colors shrink-0"
                      >
                        Reset prompt
                      </button>
                    </div>
                    <textarea
                      rows={5}
                      placeholder="System prompt (blank = raw, no system prompt at all)"
                      value={participantPrompts[participant.id] ?? ''}
                      oninput={(event) => updateParticipantPrompt(participant.id, (event.currentTarget as HTMLTextAreaElement).value)}
                      class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900 resize-y
                             focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
                    ></textarea>
                  </div>
                {/each}
              </div>
            </BoundedList>
          {/if}
        {/if}
      </CollapsibleSection>

      {#if error}
        <p class="text-sm text-wilt-600 mb-2 shrink-0">{error}</p>
      {/if}

      <!-- Chat Messages Area (bounded — scrolls internally) -->
      <div
        bind:this={messagesContainer}
        class="flex-1 min-h-32 overflow-y-auto rounded-xl border border-bark-300 bg-bark-100 px-4 py-3"
      >
        {#if messages.length === 0 && !isStreaming}
          <div class="flex items-center justify-center h-full">
            <div class="text-center">
              <p class="text-bark-700 text-sm font-medium">No messages in this session yet.</p>
              <p class="text-bark-600 text-sm mt-1">
                {#if roomModeActive}
                  Send an opening turn to run a round with {includeCompanion ? `${companionName} and ` : ''}your selected models.
                {:else}
                  Type a message below to start chatting with {companionName}.
                {/if}
              </p>
              <p class="text-bark-500 text-sm mt-2 font-mono">{bootstrap.defaultSessionId}</p>
            </div>
          </div>
        {:else}
          <div class="space-y-3">
            {#each messages as msg (msg.id)}
              <!-- Thinking section (collapsible) -->
              {#if msg.thinking}
                <div class="max-w-[85%]">
                  <button
                    onclick={() => toggleThinking(msg.id)}
                    class="flex items-center gap-1.5 text-sm text-bark-600 hover:text-bark-800 transition-colors mb-1"
                  >
                    <svg class="w-3.5 h-3.5 transition-transform {expandedThinking.has(msg.id) ? 'rotate-90' : ''}"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                    Thinking...
                  </button>
                  {#if expandedThinking.has(msg.id)}
                    <div class="ml-5 p-3 rounded-lg bg-bark-200 border border-bark-300 text-sm text-bark-700 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto">
                      {msg.thinking}
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- Tool calls section (collapsible) -->
              {#if msg.toolCalls && msg.toolCalls.length > 0}
                <div class="max-w-[85%]">
                  <button
                    onclick={() => toggleTools(msg.id)}
                    class="flex items-center gap-1.5 text-sm text-bark-600 hover:text-bark-800 transition-colors mb-1"
                  >
                    <svg class="w-3.5 h-3.5 transition-transform {expandedTools.has(msg.id) ? 'rotate-90' : ''}"
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M9 5l7 7-7 7" />
                    </svg>
                    {msg.toolCalls.length} tool call{msg.toolCalls.length !== 1 ? 's' : ''}
                  </button>
                  {#if expandedTools.has(msg.id)}
                    <div class="ml-5 space-y-1.5">
                      {#each msg.toolCalls as tc}
                        <div class="p-2.5 rounded-lg border text-sm
                          {tc.isError ? 'bg-wilt-50 border-wilt-200' : 'bg-bark-200 border-bark-300'}">
                          <span class="font-medium text-bark-800">{tc.name}</span>
                          {#if tc.result}
                            <span class="text-bark-600 ml-2">{tc.result}</span>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

              <!-- Message bubble -->
              <div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
                <div class="max-w-[85%] {msg.isError
                  ? 'bg-wilt-50 border border-wilt-200 rounded-2xl'
                  : msg.role === 'user'
                    ? 'bg-gold-50 border border-gold-200 rounded-2xl rounded-br-md'
                    : 'bg-bark-50 border border-bark-300 rounded-2xl rounded-bl-md'} px-4 py-2.5 shadow-sm">
                  {#if msg.role !== 'user'}
                    <p class="text-sm font-semibold text-shadow-800 mb-1">{msg.speakerName}</p>
                  {/if}
                  <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed break-words">{msg.content}</div>
                  <div class="text-right mt-1">
                    <span class="text-sm text-shadow-500">{formatTime(msg.timestamp)}</span>
                  </div>
                </div>
              </div>
            {/each}

            <!-- Streaming message in progress (companion path) -->
            {#if isStreaming}
              <!-- Streaming thinking -->
              {#if streamingThinking}
                <div class="max-w-[85%]">
                  <div class="flex items-center gap-1.5 text-sm text-bark-600 mb-1">
                    <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 2v4m0 12v4m-8-10H2m20 0h-4m-2.343-5.657L16.243 4.929M7.757 19.071l-1.414 1.414M19.071 16.243l1.414 1.414M4.929 7.757 3.515 6.343" />
                    </svg>
                    Thinking...
                  </div>
                  <div class="ml-5 p-3 rounded-lg bg-bark-200 border border-bark-300 text-sm text-bark-700 font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {streamingThinking}
                  </div>
                </div>
              {/if}

              <!-- Streaming tool calls -->
              {#if pendingToolCalls.length > 0}
                <div class="max-w-[85%] space-y-1.5">
                  {#each pendingToolCalls as tc}
                    <div class="p-2.5 rounded-lg border text-sm
                      {tc.result ? (tc.isError ? 'bg-wilt-50 border-wilt-200' : 'bg-bark-200 border-bark-300') : 'bg-gold-50 border-gold-200 animate-pulse'}">
                      <span class="font-medium text-bark-800">{tc.name}</span>
                      {#if tc.result}
                        <span class="text-bark-600 ml-2">{tc.result}</span>
                      {:else}
                        <span class="text-bark-500 ml-2">running...</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}

              <!-- Streaming content bubble -->
              {#if streamingContent}
                <div class="flex justify-start">
                  <div class="max-w-[85%] bg-bark-50 border border-bark-300 rounded-2xl rounded-bl-md px-4 py-2.5 shadow-sm">
                    <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed break-words">{streamingContent}</div>
                  </div>
                </div>
              {:else if !streamingThinking && pendingToolCalls.length === 0}
                <div class="flex justify-start">
                  <div class="max-w-[85%] bg-bark-50 border border-bark-300 rounded-2xl rounded-bl-md px-4 py-2.5 shadow-sm">
                    <div class="flex items-center gap-2 text-sm text-shadow-600">
                      <span class="inline-block w-2 h-2 bg-gold-400 rounded-full animate-pulse"></span>
                      Waiting for {companionName}...
                    </div>
                  </div>
                </div>
              {/if}
            {/if}

            <!-- Room round in progress -->
            {#if sendingRound}
              <div class="text-sm text-shadow-600 animate-pulse">Running room round...</div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Input Area (pinned composer) -->
      <div class="mt-3 shrink-0">
        <div class="card-garden flex items-end gap-2 p-3 shadow-sm">
          <textarea
            bind:this={inputEl}
            bind:value={inputText}
            onkeydown={handleKeydown}
            disabled={busy}
            rows={2}
            placeholder={roomModeActive
              ? 'Send an opening turn to the room... (Enter to run round, Shift+Enter for newline)'
              : 'Type a message... (Enter to send, Shift+Enter for newline)'}
            class="min-h-12 flex-1 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900 resize-none
                   placeholder:text-shadow-400
                   focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                   disabled:opacity-50 disabled:cursor-not-allowed"
          ></textarea>
          {#if isStreaming}
            <button
              onclick={abortStream}
              class="min-h-11 rounded-lg bg-wilt-600 px-4 py-2 text-sm font-medium text-white
                     hover:bg-wilt-400 transition-colors shrink-0"
            >
              Stop
            </button>
          {:else}
            <button
              onclick={sendMessage}
              disabled={!inputText.trim() || busy}
              class="min-h-11 rounded-lg bg-gold-600 px-4 py-2 text-sm font-medium text-white
                     hover:bg-gold-700 disabled:opacity-50 transition-colors shrink-0"
            >
              {#if sendingRound}
                Running...
              {:else if roomModeActive}
                Run Round
              {:else}
                Send
              {/if}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <!-- Transcripts tab: browse past sessions, including model-room runs -->
    <div class="flex-1 min-h-0 flex flex-col lg:flex-row gap-3">
      <div class="garden-section card-garden p-3 flex flex-col lg:w-96 shrink-0 min-h-0 max-h-72 lg:max-h-none">
        <div class="flex items-center justify-between gap-2 mb-2 shrink-0">
          <h2 class="font-serif text-base font-semibold text-shadow-900">Sessions</h2>
          <button
            onclick={() => void ensureSessionsLoaded(true)}
            disabled={sessionsLoading}
            class="min-h-11 rounded-lg border border-bark-300 px-3 py-2 text-xs text-shadow-600 hover:bg-bark-100
                   transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Refresh
          </button>
        </div>
        <div class="mb-2 grid grid-cols-[minmax(0,1fr)_auto] gap-2 shrink-0">
          <input
            type="text"
            bind:value={sessionFilter}
            placeholder="Filter sessions"
            aria-label="Filter sessions by text"
            class="min-h-11 min-w-0 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900
                   placeholder:text-shadow-400
                   focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
          />
          <select
            bind:value={sessionKindFilter}
            aria-label="Filter sessions by kind"
            class="min-h-11 rounded-lg border border-bark-300 bg-bark-50 px-2 py-2 text-sm text-shadow-900
                   focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
          >
            <option value="all">All kinds</option>
            <option value="chat">Chat</option>
            <option value="subagent">Subagent</option>
            <option value="intake">Intake</option>
            <option value="scheduled">Scheduled</option>
            <option value="other">Other</option>
          </select>
        </div>
        {#if sessionsError}
          <p class="text-sm text-wilt-600 shrink-0">{sessionsError}</p>
        {/if}
        <div class="flex-1 min-h-0 overflow-y-auto space-y-1.5" role="list" aria-label="Session list">
          {#if sessionsLoading && sessionList.length === 0}
            <p class="text-sm text-shadow-600 animate-pulse">Loading sessions...</p>
          {:else if filteredSessions.length === 0}
            <p class="text-sm text-shadow-600">No sessions match.</p>
          {:else}
            {#each filteredSessions as channel (channel.sessionId)}
              <button
                onclick={() => void openTranscript(channel.sessionId)}
                class="min-h-14 w-full rounded-lg border px-3 py-2 text-left transition-colors
                  {selectedSessionId === channel.sessionId
                    ? 'border-gold-300 bg-gold-50'
                    : 'border-bark-300 bg-bark-50 hover:bg-bark-100'}"
              >
                <p class="text-sm font-medium text-shadow-900 break-all">
                  {channel.displayLabel || channel.sessionId}
                </p>
                <p class="text-xs text-shadow-600 mt-0.5">
                  <span class="capitalize">{classifySessionKind(channel)}</span>
                  ·
                  {channel.messageCount} messages
                  {#if channel.linkedContactName}
                    · {channel.linkedContactName}
                  {/if}
                </p>
                <p class="text-xs text-shadow-500">{formatLastActivity(channel.lastActivityAt)}</p>
              </button>
            {/each}
          {/if}
        </div>
        <p class="text-xs text-shadow-500 mt-2 shrink-0">
          Deeper session tooling (search, turns, compaction audits) lives in
          <a href={scopeGardenPath('/sessions')} class="underline text-shadow-700 hover:text-shadow-900">Sessions</a>.
        </p>
      </div>

      <div class="garden-section card-garden p-3 flex-1 min-h-0 flex flex-col">
        {#if !selectedSessionId}
          <div class="flex-1 flex items-center justify-center">
            <p class="text-sm text-shadow-600">Select a session to view its transcript.</p>
          </div>
        {:else}
          <div class="flex items-center justify-between gap-2 mb-2 shrink-0 flex-wrap">
            <p class="text-sm font-mono text-shadow-800 break-all">{selectedSessionId}</p>
            {#if transcriptPagination?.hasMoreOlder}
              <button
                onclick={() => void loadEarlierTranscript()}
                disabled={transcriptLoading}
                class="min-h-11 rounded-lg border border-bark-300 px-3 py-2 text-sm text-shadow-700 hover:bg-bark-100
                       transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                Load earlier ({transcriptPagination.totalMessages - transcriptMessages.length} more)
              </button>
            {/if}
          </div>
          {#if transcriptError}
            <p class="text-sm text-wilt-600 mb-2 shrink-0">{transcriptError}</p>
          {/if}
          <div class="flex-1 min-h-0 overflow-y-auto rounded-xl border border-bark-300 bg-bark-100 px-4 py-3">
            {#if transcriptLoading && transcriptMessages.length === 0}
              <p class="text-sm text-shadow-600 animate-pulse">Loading transcript...</p>
            {:else if transcriptMessages.length === 0}
              <p class="text-sm text-shadow-600">This session has no messages.</p>
            {:else}
              <div class="space-y-3">
                {#each transcriptMessages as entry (entry.id)}
                  <div class="flex {entry.role === 'user' ? 'justify-end' : 'justify-start'}">
                    <div class="max-w-[85%] {entry.role === 'user'
                      ? 'bg-gold-50 border border-gold-200 rounded-2xl rounded-br-md'
                      : entry.role === 'assistant'
                        ? 'bg-bark-50 border border-bark-300 rounded-2xl rounded-bl-md'
                        : 'bg-bark-200 border border-bark-300 rounded-2xl'} px-4 py-2.5 shadow-sm">
                      <p class="text-xs font-semibold text-shadow-700 mb-1">
                        {entry.authorName || entry.role}
                        <span class="font-normal text-shadow-500">· {entry.role}</span>
                      </p>
                      <div class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed break-words">{entry.content}</div>
                      {#if formatSessionTimestamp(entry.timestamp)}
                        <div class="text-right mt-1">
                          <span class="text-xs text-shadow-500">{formatSessionTimestamp(entry.timestamp)}</span>
                        </div>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
