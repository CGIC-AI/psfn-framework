<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    getCachedSessionList,
    getCachedSessionMessages,
    getSessionDetail,
    getSessionMessages,
    getSessionTurnDetail,
    revalidateSessionList,
    revalidateSessionMessages,
    SESSION_MESSAGE_PAGE_SIZE,
  } from '$lib/api/endpoints/sessions';
  import {
    loadSelectedSessionData,
    loadSessionIndex,
  } from './session-data-loader';
  import { buildIcpTranscriptPresentation } from './icp-transcript';
  import { getCompanionName } from '$lib/stores/companion.svelte';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import type {
    AdminSessionDetailData,
    AdminSessionListData,
    ChannelInfo,
    AdminSessionMessagesData,
    AdminSessionTurnDetailData,
    SessionEntry,
  } from '$lib/types';

  type SessionMessageOntologyView = AdminSessionMessagesData['messageOntologyViews'][number];

  let channels = $state<ChannelInfo[]>([]);
  let selectedSessionId = $state<string | null>(null);
  let selectedSessionDetail = $state<AdminSessionDetailData | null>(null);
  let messages = $state<SessionEntry[]>([]);
  let messageOntologyViews = $state<AdminSessionMessagesData['messageOntologyViews']>([]);
  let compactionAudits = $state<AdminSessionMessagesData['compactionAuditViews']>([]);
  let error = $state('');
  let loadingChannels = $state(true);
  let loadingMessages = $state(false);
  let loadingOlderMessages = $state(false);
  let hasMoreOlderMessages = $state(false);
  let oldestLoadedMessageId = $state<number | null>(null);
  let messageScrollContainer = $state<HTMLDivElement | null>(null);

  let expandedTurnId = $state<string | null>(null);
  let turnDetail = $state<AdminSessionTurnDetailData | null>(null);
  let turnDetailLoading = $state(false);
  let turnDetailError = $state('');
  let channelLastActivity = $state<Map<string, number>>(new Map());
  let channelSearch = $state('');
  let channelSort = $state<'recent' | 'messages_desc' | 'messages_asc' | 'name_asc' | 'name_desc'>('recent');
  let messageSearch = $state('');
  const companionName = $derived(getCompanionName());
  const selectedChannel = $derived(
    selectedSessionDetail?.channel
      ?? channels.find(channel => channel.sessionId === selectedSessionId)
      ?? null,
  );

  // Channel type labels matching the htmx admin
  const CHANNEL_TYPE_LABELS: Record<string, string> = {
    api: 'API',
    discord: 'Discord',
    'discord-voice': 'Discord Voice',
    internal: 'Internal',
    openwebui: 'OpenWebUI',
    shard: 'Shard',
    sillytavern: 'SillyTavern',
    social: 'Social',
    twitter: 'Twitter',
  };

  const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

  function toChannelTypeLabel(channelType: string): string {
    const normalized = channelType.trim().toLowerCase();
    if (!normalized) return 'Session';
    const mapped = CHANNEL_TYPE_LABELS[normalized];
    if (mapped) return mapped;
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function toReadableChannelLabel(channelId: string): string {
    if (DISCORD_CHANNEL_ID_PATTERN.test(channelId)) {
      return `Discord . channel ${channelId}`;
    }
    const separatorIndex = channelId.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= channelId.length - 1) return channelId;
    const channelType = channelId.slice(0, separatorIndex);
    const channelName = channelId.slice(separatorIndex + 1);
    const typeLabel = toChannelTypeLabel(channelType);
    return `${typeLabel} . ${channelName}`;
  }

  function toTimestampMs(value: string | number | undefined): number | null {
    if (value === undefined) return null;
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function applySessionList(data: AdminSessionListData) {
    channels = data.channels;
    const seeded = new Map(channelLastActivity);
    for (const channel of data.channels) {
      const ts = toTimestampMs(channel.lastActivityAt);
      if (ts !== null && ts > (seeded.get(channel.sessionId) ?? 0)) {
        seeded.set(channel.sessionId, ts);
      }
    }
    channelLastActivity = seeded;
  }

  async function loadChannels() {
    loadingChannels = true;
    error = '';
    try {
      await loadSessionIndex({
        getCached: getCachedSessionList,
        revalidate: revalidateSessionList,
        onList: (data, source) => {
          applySessionList(data);
          if (source === 'cache') loadingChannels = false;
        },
      });
    } catch (e) {
      if (channels.length === 0) {
        error = e instanceof Error ? e.message : 'Failed to load sessions';
      }
    } finally {
      loadingChannels = false;
    }
  }

  function mergeMessageOntologyViews(
    olderViews: SessionMessageOntologyView[],
    newerViews: SessionMessageOntologyView[],
  ): SessionMessageOntologyView[] {
    const merged = new Map<number, SessionMessageOntologyView>();
    for (const view of olderViews) {
      merged.set(view.sessionEntryId, view);
    }
    for (const view of newerViews) {
      merged.set(view.sessionEntryId, view);
    }
    return [...merged.values()];
  }

  function updatePaginationState(data: AdminSessionMessagesData) {
    hasMoreOlderMessages = data.pagination.hasMoreOlder;
    oldestLoadedMessageId = data.pagination.nextBeforeId ?? messages[0]?.id ?? null;
  }

  function updateLastActivityFromMessages(data: AdminSessionMessagesData) {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg?.timestamp) return;
    const ts = typeof lastMsg.timestamp === 'number'
      ? lastMsg.timestamp
      : Date.parse(lastMsg.timestamp);
    if (!Number.isFinite(ts)) return;
    const next = new Map(channelLastActivity);
    next.set(data.sessionId, ts);
    channelLastActivity = next;
  }

  async function scrollMessagesToBottom() {
    await tick();
    if (!messageScrollContainer) return;
    messageScrollContainer.scrollTop = messageScrollContainer.scrollHeight;
  }

  async function selectChannel(sessionId: string) {
    selectedSessionId = sessionId;
    selectedSessionDetail = null;
    const requestSessionId = sessionId;
    loadingMessages = true;
    loadingOlderMessages = false;
    hasMoreOlderMessages = false;
    oldestLoadedMessageId = null;
    messages = [];
    messageOntologyViews = [];
    compactionAudits = [];
    resetTurnDetail();
    const initialRequest = {
      limit: SESSION_MESSAGE_PAGE_SIZE,
      includeTurns: false,
    };
    try {
      await loadSelectedSessionData({
        sessionId,
        loadCachedMessages: requestSessionId => getCachedSessionMessages(
          requestSessionId,
          initialRequest,
        ),
        loadMessages: requestSessionId => revalidateSessionMessages(
          requestSessionId,
          initialRequest,
        ),
        loadDetail: getSessionDetail,
        onMessages: async (data) => {
          if (selectedSessionId !== requestSessionId) return;
          messages = data.messages;
          messageOntologyViews = data.messageOntologyViews ?? [];
          compactionAudits = data.compactionAuditViews ?? [];
          updatePaginationState(data);
          updateLastActivityFromMessages(data);
          loadingMessages = false;
          await scrollMessagesToBottom();
        },
        onDetail: (data) => {
          if (selectedSessionId !== requestSessionId) return;
          selectedSessionDetail = data;
        },
      });
    } catch (e) {
      if (selectedSessionId === requestSessionId) {
        error = e instanceof Error ? e.message : 'Failed to load messages';
      }
    } finally {
      if (selectedSessionId === requestSessionId) {
        loadingMessages = false;
      }
    }
  }

  async function loadOlderMessages() {
    if (
      !selectedSessionId
      || loadingMessages
      || loadingOlderMessages
      || !hasMoreOlderMessages
      || oldestLoadedMessageId === null
    ) {
      return;
    }

    const requestSessionId = selectedSessionId;
    const scrollContainer = messageScrollContainer;
    const previousScrollHeight = scrollContainer?.scrollHeight ?? 0;
    loadingOlderMessages = true;
    try {
      // Pagination pages carry messages + ontology only (no turns, previews, or
      // compaction) so deep scrolling stays cheap over WAN (bead t5z7.1).
      const data = await getSessionMessages(requestSessionId, {
        limit: SESSION_MESSAGE_PAGE_SIZE,
        beforeId: oldestLoadedMessageId,
        messagesOnly: true,
      });
      if (selectedSessionId !== requestSessionId) return;

      const existingIds = new Set(messages.map(message => message.id));
      const olderMessages = data.messages.filter(message => !existingIds.has(message.id));
      messages = [...olderMessages, ...messages];
      messageOntologyViews = mergeMessageOntologyViews(data.messageOntologyViews ?? [], messageOntologyViews);
      updatePaginationState(data);
      await tick();
      if (scrollContainer) {
        scrollContainer.scrollTop += scrollContainer.scrollHeight - previousScrollHeight;
      }
    } catch (e) {
      if (selectedSessionId === requestSessionId) {
        error = e instanceof Error ? e.message : 'Failed to load older messages';
      }
    } finally {
      if (selectedSessionId === requestSessionId) {
        loadingOlderMessages = false;
      }
    }
  }

  function handleMessagesScroll() {
    if (!messageScrollContainer || messageScrollContainer.scrollTop > 48) return;
    void loadOlderMessages();
  }

  // Turn identity lives on the message metadata envelope ({ turn: { turnId } }).
  // Malformed metadata simply yields no turn-detail affordance for that row.
  function extractTurnId(msg: SessionEntry): string | null {
    if (!msg.metadata) return null;
    try {
      const parsed = JSON.parse(msg.metadata) as { turn?: { turnId?: unknown } };
      const turnId = parsed?.turn?.turnId;
      return typeof turnId === 'string' && turnId.trim() ? turnId.trim() : null;
    } catch {
      return null;
    }
  }

  function resetTurnDetail() {
    expandedTurnId = null;
    turnDetail = null;
    turnDetailError = '';
    turnDetailLoading = false;
  }

  async function toggleTurnDetail(turnId: string) {
    if (expandedTurnId === turnId) {
      resetTurnDetail();
      return;
    }
    if (!selectedSessionId) return;
    const requestSessionId = selectedSessionId;
    expandedTurnId = turnId;
    turnDetail = null;
    turnDetailError = '';
    turnDetailLoading = true;
    try {
      const data = await getSessionTurnDetail(requestSessionId, turnId);
      if (selectedSessionId !== requestSessionId || expandedTurnId !== turnId) return;
      turnDetail = data;
    } catch (e) {
      if (selectedSessionId === requestSessionId && expandedTurnId === turnId) {
        turnDetailError = e instanceof Error ? e.message : 'Failed to load turn detail';
      }
    } finally {
      if (selectedSessionId === requestSessionId && expandedTurnId === turnId) {
        turnDetailLoading = false;
      }
    }
  }

  function roleColor(role: string): string {
    switch (role) {
      case 'user': return 'bg-moss-50 border-moss-300';
      case 'assistant': return 'bg-gold-50 border-gold-300';
      case 'system': return 'bg-bark-200 border-bark-400';
      default: return 'bg-bark-100 border-bark-300';
    }
  }

  function roleLabelColor(role: string): string {
    switch (role) {
      case 'user': return 'text-moss-700';
      case 'assistant': return 'text-gold-700';
      case 'system': return 'text-shadow-600';
      default: return 'text-shadow-700';
    }
  }

  function displayName(msg: SessionEntry): string {
    // Use authorName if available (from backend)
    if (msg.authorName) return msg.authorName;

    // For companion replies, use the live character-card name when authorName is unavailable.
    if (msg.role === 'assistant') return companionName;

    // For person turns, try to use the linked contact name from the selected channel.
    if (msg.role === 'user') {
      if (selectedChannel?.linkedContactName) return selectedChannel.linkedContactName;
    }

    // Fallback to role
    return msg.role;
  }

  function formatTimestamp(ts?: string | number): string {
    if (!ts) return '';
    const date = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function ontologyTone(ontology: SessionMessageOntologyView | undefined): string {
    if (!ontology) return 'bg-bark-200 text-shadow-700 border-bark-300';
    switch (ontology.semanticType) {
      case 'mirror':
        return 'bg-sky-100 text-sky-800 border-sky-300';
      case 'systemNote':
        return 'bg-shadow-100 text-shadow-800 border-shadow-300';
      case 'toolResult':
        return 'bg-moss-100 text-moss-800 border-moss-300';
      default:
        return 'bg-gold-100 text-gold-800 border-gold-300';
    }
  }

  function promptVisibilityLabel(ontology: SessionMessageOntologyView | undefined): string {
    if (!ontology) return '';
    return ontology.promptVisibility === 'operator_only' ? 'Operator-only' : 'Prompt-visible';
  }

  function channelLabel(ch: ChannelInfo): string {
    if (ch.displayLabel) return ch.displayLabel;
    return toReadableChannelLabel(ch.channelId);
  }

  function channelSubLabel(ch: ChannelInfo): string | null {
    if (ch.displayLabel && ch.displayLabel !== ch.channelId) {
      return ch.channelId;
    }
    return null;
  }

  function filterMessages(list: SessionEntry[], query: string): SessionEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((msg) => {
      const content = (msg.content ?? '').toLowerCase();
      const author = (msg.authorName ?? '').toLowerCase();
      const role = (msg.role ?? '').toLowerCase();
      const origin = (msg.originChannelId ?? '').toLowerCase();
      return content.includes(needle)
        || author.includes(needle)
        || role.includes(needle)
        || origin.includes(needle);
    });
  }

  const filteredChannels = $derived.by(() => {
    const needle = channelSearch.trim().toLowerCase();
    const list = channels.filter((ch) => {
      if (!needle) return true;
      return channelLabel(ch).toLowerCase().includes(needle)
        || ch.channelId.toLowerCase().includes(needle)
        || ch.sessionId.toLowerCase().includes(needle);
    });

    const sorted = [...list].sort((a, b) => {
      if (channelSort === 'messages_desc') {
        return b.messageCount - a.messageCount || channelLabel(a).localeCompare(channelLabel(b));
      }
      if (channelSort === 'messages_asc') {
        return a.messageCount - b.messageCount || channelLabel(a).localeCompare(channelLabel(b));
      }
      if (channelSort === 'name_asc') {
        return channelLabel(a).localeCompare(channelLabel(b));
      }
      if (channelSort === 'name_desc') {
        return channelLabel(b).localeCompare(channelLabel(a));
      }

      const aTs = channelLastActivity.get(a.sessionId) ?? 0;
      const bTs = channelLastActivity.get(b.sessionId) ?? 0;
      if (bTs !== aTs) return bTs - aTs;
      return b.messageCount - a.messageCount || channelLabel(a).localeCompare(channelLabel(b));
    });

    return sorted;
  });

  const messageOntologyById = $derived.by(() => {
    const views = new Map<number, SessionMessageOntologyView>();
    for (const view of messageOntologyViews) {
      views.set(view.sessionEntryId, view);
    }
    return views;
  });
  const icpTranscriptPresentation = $derived.by(() => (
    buildIcpTranscriptPresentation(messages, messageOntologyViews)
  ));
  const filteredMessages = $derived.by(() => (
    filterMessages(icpTranscriptPresentation.conversationMessages, messageSearch)
  ));

  onMount(() => {
    loadChannels();
  });
</script>

<div class="garden-page space-y-4">
  <GardenPageHeader
    eyebrow="Live Operations"
    title="The Branches"
    description="Search session channels, inspect message history, and audit content-free turn detail."
  />

  {#if error}
    <div class="garden-error card-garden border-l-4 border-l-wilt-400 p-4" role="alert">
      <p class="text-wilt-600 text-sm">{error}</p>
      <button onclick={() => error = ''} class="mt-2 min-h-11 rounded-lg px-3 text-sm font-medium text-shadow-600 hover:bg-bark-100 hover:text-shadow-900">Dismiss</button>
    </div>
  {/if}

  <div class="garden-split-view flex min-h-[36rem] flex-col gap-4 lg:h-[calc(100vh-12rem)] lg:flex-row">
    <!-- Channel list -->
    <section class="garden-section card-garden flex max-h-96 w-full shrink-0 flex-col overflow-hidden lg:max-h-none lg:w-80" aria-labelledby="session-channels-heading">
      <div class="border-b border-bark-300 bg-bark-100 p-3">
        <h2 id="session-channels-heading" class="font-serif text-base font-semibold text-shadow-900">Channels</h2>
        <p class="text-sm text-shadow-600">{filteredChannels.length} of {channels.length} sessions</p>
        <div class="mt-2 space-y-2">
          <input
            type="search"
            bind:value={channelSearch}
            placeholder="Search channels..."
            class="min-h-11 w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300"
          />
          <select
            bind:value={channelSort}
            class="min-h-11 w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300"
          >
            <option value="recent">Sort: Recent Activity</option>
            <option value="messages_desc">Sort: Most Messages</option>
            <option value="messages_asc">Sort: Fewest Messages</option>
            <option value="name_asc">Sort: Name (A-Z)</option>
            <option value="name_desc">Sort: Name (Z-A)</option>
          </select>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto">
        {#if loadingChannels}
          <div class="p-3 space-y-2">
            {#each Array(6) as _}
              <div class="h-12 bg-bark-300 rounded animate-pulse"></div>
            {/each}
          </div>
        {:else}
          {#each filteredChannels as ch (ch.sessionId)}
            {@const lastActivityTs = channelLastActivity.get(ch.sessionId)}
            <button
              onclick={() => selectChannel(ch.sessionId)}
              class="min-h-14 w-full border-b border-bark-200 px-3 py-2.5 text-left hover:bg-bark-100
                     transition-colors"
              class:bg-gold-50={selectedSessionId === ch.sessionId}
              class:border-l-3={selectedSessionId === ch.sessionId}
              class:border-l-gold-400={selectedSessionId === ch.sessionId}
            >
              <span class="text-sm text-shadow-800 block truncate font-medium" title={ch.channelId}>
                {channelLabel(ch)}
              </span>
              {#if channelSubLabel(ch)}
                <span class="text-sm text-shadow-600 block truncate font-mono">
                  {channelSubLabel(ch)}
                </span>
              {/if}
              {#if ch.sessionId !== ch.channelId}
                <span class="text-sm text-shadow-600 block truncate font-mono" title={ch.sessionId}>
                  session: {ch.sessionId}
                </span>
              {/if}
              <div class="flex items-center gap-1.5 mt-0.5">
                <span class="text-sm text-shadow-600">
                  {ch.messageCount} messages
                </span>
              </div>
              {#if lastActivityTs}
                <span class="text-sm text-shadow-600 block mt-0.5">
                  Last: {formatTimestamp(lastActivityTs)}
                </span>
              {/if}
            </button>
          {/each}
          {#if filteredChannels.length === 0}
            <p class="p-4 text-shadow-600 text-sm text-center">No sessions found.</p>
          {/if}
        {/if}
      </div>
    </section>

    <!-- Messages panel -->
    <section class="garden-section card-garden flex min-h-[32rem] min-w-0 flex-1 flex-col overflow-hidden" aria-label="Session messages">
      {#if !selectedSessionId}
        <div class="flex-1 flex items-center justify-center">
          <div class="max-w-sm px-6 text-center">
            <p class="font-serif text-lg text-shadow-900">Choose a session</p>
            <p class="mt-1 text-sm text-shadow-600">Select a channel to inspect its loaded messages and turn metadata.</p>
          </div>
        </div>
      {:else}
        <div class="p-3 border-b border-bark-300 bg-bark-100 flex items-center justify-between">
          <div>
            <h2 id="session-messages-heading" class="truncate font-serif text-base font-semibold text-shadow-900" title={selectedChannel?.channelId ?? selectedSessionId}>
              {channelLabel(selectedChannel ?? { sessionId: selectedSessionId, channelId: selectedSessionId, messageCount: 0 })}
            </h2>
            {#if selectedChannel?.channelId}
              <p class="text-sm text-shadow-600 font-mono truncate">{selectedChannel.channelId}</p>
            {/if}
            {#if selectedChannel && selectedChannel.sessionId !== selectedChannel.channelId}
              <p class="text-sm text-shadow-600 font-mono truncate">session: {selectedChannel.sessionId}</p>
            {/if}
            {#if selectedChannel?.linkedContactName}
              <p class="text-sm text-moss-700 truncate">Contact: {selectedChannel.linkedContactName}</p>
            {/if}
          </div>
          <span class="text-sm text-shadow-600">
            {filteredMessages.length} conversation messages
            {#if icpTranscriptPresentation.transportEvidence.length > 0}
              · {icpTranscriptPresentation.transportEvidence.reduce((count, group) => count + group.entryCount, 0)} transport nodes collapsed
            {/if}
            {#if selectedChannel?.messageCount}
              / {selectedChannel.messageCount} total
            {/if}
          </span>
        </div>

        <div class="p-3 border-b border-bark-300 bg-bark-100">
          <input
            type="search"
            bind:value={messageSearch}
            placeholder="Filter messages (content, role, author)..."
            class="min-h-11 w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300"
          />
        </div>

        <!-- Compaction audits -->
        {#if compactionAudits.length > 0}
          <div class="p-2 bg-bark-200 border-b border-bark-300">
            <details>
              <summary class="text-sm text-shadow-700 cursor-pointer hover:text-gold-700">
                {compactionAudits.length} compaction summary/summaries
              </summary>
              <div class="mt-2 space-y-1">
                {#each compactionAudits as audit}
                  <div class="text-sm text-shadow-700 bg-bark-100 p-2 rounded">
                    <span class="font-medium text-shadow-800">{audit.verification}</span>
                    &mdash; {audit.summary.slice(0, 160)}{audit.summary.length > 160 ? '...' : ''}
                  </div>
                {/each}
              </div>
            </details>
          </div>
        {/if}

        {#if icpTranscriptPresentation.transportEvidence.length > 0}
          <div class="space-y-2 border-b border-bark-300 bg-sky-50/50 p-2" aria-label="ICP transport evidence">
            {#each icpTranscriptPresentation.transportEvidence as evidence}
              <details class="rounded-lg border border-sky-200 bg-bark-50/80 px-3 py-2">
                <summary class="cursor-pointer text-sm font-medium text-sky-800 hover:text-sky-700">
                  ICP transport evidence · {evidence.entryCount} node{evidence.entryCount === 1 ? '' : 's'} across {evidence.turnCount} turn{evidence.turnCount === 1 ? '' : 's'}
                </summary>
                <div class="mt-2 space-y-2 text-xs text-shadow-700">
                  <div class="grid gap-1 sm:grid-cols-2">
                    <p>Conversation: <span class="font-mono">{evidence.conversationId}</span></p>
                    <p>Root initiation: <span class="font-mono">{evidence.rootInitiationId}</span></p>
                    <p>Observed: {formatTimestamp(evidence.firstTimestamp)} – {formatTimestamp(evidence.lastTimestamp)}</p>
                    {#if evidence.deliveryStatuses.length > 0}
                      <p>Delivery state: {evidence.deliveryStatuses.join(', ')}</p>
                    {/if}
                  </div>
                  {#each evidence.entries as entry}
                    <details class="rounded border border-bark-300 bg-bark-100 p-2">
                      <summary class="cursor-pointer font-medium text-shadow-800">
                        Exact operator evidence · entry {entry.id}
                      </summary>
                      <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bark-200 p-2 text-shadow-700">{entry.content}</pre>
                      {#if entry.metadata}
                        <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bark-200 p-2 text-shadow-700">{entry.metadata}</pre>
                      {/if}
                    </details>
                  {/each}
                </div>
              </details>
            {/each}
          </div>
        {/if}

        <div
          bind:this={messageScrollContainer}
          onscroll={handleMessagesScroll}
          class="flex-1 overflow-y-auto p-4 space-y-3"
        >
          {#if loadingMessages}
            <div class="space-y-3">
              {#each Array(5) as _}
                <div class="h-16 bg-bark-300 rounded animate-pulse"></div>
              {/each}
            </div>
          {:else}
            {#if hasMoreOlderMessages || loadingOlderMessages}
              <div class="flex justify-center">
                <button
                  type="button"
                  onclick={() => void loadOlderMessages()}
                  disabled={loadingOlderMessages}
                  class="min-h-11 rounded-lg px-3 text-sm font-medium text-shadow-600 hover:bg-gold-50 hover:text-gold-700 disabled:cursor-wait disabled:text-shadow-500"
                >
                  {loadingOlderMessages ? 'Loading older messages...' : 'Load older messages'}
                </button>
              </div>
            {/if}
            {#each filteredMessages as msg, i}
              {@const ontology = messageOntologyById.get(msg.id)}
              <div class="rounded-lg border p-3 {roleColor(msg.role)}">
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="text-sm font-semibold {roleLabelColor(msg.role)} truncate">{displayName(msg)}</span>
                    {#if ontology}
                      <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium {ontologyTone(ontology)}">
                        {ontology.displayLabel}
                      </span>
                      <span class="inline-flex items-center rounded-full border border-bark-300 bg-bark-50/75 px-2 py-0.5 text-xs text-shadow-700">
                        {promptVisibilityLabel(ontology)}
                      </span>
                    {/if}
                  </div>
                  {#if msg.timestamp}
                    <span class="text-sm text-shadow-600">{formatTimestamp(msg.timestamp)}</span>
                  {/if}
                </div>
                {#if ontology?.messageClass}
                  <p class="text-xs text-shadow-600 mb-1">
                    class: <span class="font-mono">{ontology.messageClass}</span>
                  </p>
                {/if}
                <p class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </p>

                {#if extractTurnId(msg)}
                  {@const turnId = extractTurnId(msg)}
                  <div class="mt-2">
                    <button
                      onclick={() => turnId && void toggleTurnDetail(turnId)}
                      class="min-h-11 rounded-lg px-2 text-sm font-medium text-gold-700 hover:bg-gold-50 hover:text-gold-600"
                    >
                      {expandedTurnId === turnId ? 'Hide turn detail' : 'Show turn detail'}
                    </button>
                    {#if expandedTurnId === turnId}
                      {#if turnDetailLoading}
                        <p class="mt-1 text-sm text-shadow-600">Loading turn detail...</p>
                      {:else if turnDetailError}
                        <p class="mt-1 text-sm text-wilt-600">{turnDetailError}</p>
                      {:else if turnDetail}
                        <pre class="mt-1 max-h-96 text-sm bg-bark-100 p-2 rounded overflow-auto text-shadow-700 border border-bark-300">{JSON.stringify(turnDetail.turn, null, 2)}</pre>
                      {/if}
                    {/if}
                  </div>
                {/if}

                {#if msg.originChannelId}
                  <p class="text-sm text-shadow-600 mt-1">
                    from: {msg.originChannelId}
                  </p>
                {/if}
              </div>
            {/each}

            {#if filteredMessages.length === 0}
              <p class="text-shadow-600 text-sm text-center py-8">No messages in this session.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>
