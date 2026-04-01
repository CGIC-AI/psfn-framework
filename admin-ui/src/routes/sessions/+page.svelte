<script lang="ts">
  import { onMount } from 'svelte';
  import { listSessions, getSessionMessages } from '$lib/api/endpoints/sessions';
  import type { ChannelInfo, AdminSessionMessagesData, SessionEntry } from '$lib/types';

  let channels = $state<ChannelInfo[]>([]);
  let selectedSessionId = $state<string | null>(null);
  let messages = $state<SessionEntry[]>([]);
  let continuityArtifacts = $state<AdminSessionMessagesData['continuityArtifacts']>([]);
  let compactionAudits = $state<AdminSessionMessagesData['compactionAuditViews']>([]);
  let error = $state('');
  let loadingChannels = $state(true);
  let loadingMessages = $state(false);

  let expandedToolCall = $state<number | null>(null);
  let channelLastActivity = $state<Map<string, number>>(new Map());
  let channelSearch = $state('');
  let channelSort = $state<'recent' | 'messages_desc' | 'messages_asc' | 'name_asc' | 'name_desc'>('recent');
  let messageSearch = $state('');
  const selectedChannel = $derived(channels.find(channel => channel.sessionId === selectedSessionId) ?? null);

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

  async function loadChannels() {
    loadingChannels = true;
    error = '';
    try {
      const data = await listSessions();
      channels = data.channels;
      const seeded = new Map<string, number>();
      for (const channel of data.channels) {
        const ts = toTimestampMs(channel.lastActivityAt);
        if (ts !== null) {
          seeded.set(channel.sessionId, ts);
        }
      }
      channelLastActivity = seeded;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load sessions';
    } finally {
      loadingChannels = false;
    }
  }

  async function selectChannel(sessionId: string) {
    selectedSessionId = sessionId;
    loadingMessages = true;
    messages = [];
    continuityArtifacts = [];
    compactionAudits = [];
    expandedToolCall = null;
    try {
      const data = await getSessionMessages(sessionId);
      messages = data.messages;
      continuityArtifacts = data.continuityArtifacts ?? [];
      compactionAudits = data.compactionAuditViews ?? [];

      // Track last activity from the most recent message timestamp.
      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.timestamp) {
          const ts = typeof lastMsg.timestamp === 'number'
            ? lastMsg.timestamp
            : Date.parse(lastMsg.timestamp);
          if (Number.isFinite(ts)) {
            const next = new Map(channelLastActivity);
            next.set(data.sessionId, ts);
            channelLastActivity = next;
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load messages';
    } finally {
      loadingMessages = false;
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

    // For assistant role, use a neutral fallback when authorName is unavailable.
    if (msg.role === 'assistant') return 'Assistant';

    // For user role, try to use the linked contact name from the selected channel
    if (msg.role === 'user') {
      const channel = channels.find(c => c.sessionId === selectedSessionId);
      if (channel?.linkedContactName) return channel.linkedContactName;
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

  function continuityArtifactLabel(
    artifact: AdminSessionMessagesData['continuityArtifacts'][number],
  ): string {
    if (artifact.kind === 'wake_return') {
      return artifact.occasion === 'wake' ? 'Wake Summary' : 'Return Summary';
    }
    return 'Checkpoint';
  }

  function continuityFacetLabel(facet: AdminSessionMessagesData['continuityArtifacts'][number]['facets'][number]): string {
    switch (facet) {
      case 'task':
        return 'Task';
      case 'relational':
        return 'Relational';
      case 'life':
        return 'Life';
      default:
        return facet;
    }
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
        || ch.sessionId.toLowerCase().includes(needle)
        || (ch.linkedContactName ?? '').toLowerCase().includes(needle);
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

  const filteredMessages = $derived.by(() => filterMessages(messages, messageSearch));

  onMount(() => {
    loadChannels();
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Branches</h1>
    <p class="text-shadow-600 text-sm mt-1">Session Browser</p>
  </div>

  {#if error}
    <div class="card-garden p-4 border-wilt-400">
      <p class="text-wilt-600 text-sm">{error}</p>
      <button onclick={() => error = ''} class="text-sm text-shadow-600 hover:text-shadow-900 mt-1">Dismiss</button>
    </div>
  {/if}

  <div class="flex gap-4 h-[calc(100vh-12rem)]">
    <!-- Channel list -->
    <div class="w-72 shrink-0 card-garden overflow-hidden flex flex-col">
      <div class="p-3 border-b border-bark-300 bg-bark-100">
        <h2 class="text-sm font-medium text-shadow-800">Channels</h2>
        <p class="text-sm text-shadow-600">{filteredChannels.length} of {channels.length} sessions</p>
        <div class="mt-2 space-y-2">
          <input
            type="search"
            bind:value={channelSearch}
            placeholder="Search channels..."
            class="w-full px-2.5 py-1.5 rounded-lg border border-bark-300 bg-white text-sm text-shadow-800
                   focus:outline-none focus:ring-2 focus:ring-gold-300"
          />
          <select
            bind:value={channelSort}
            class="w-full px-2.5 py-1.5 rounded-lg border border-bark-300 bg-white text-sm text-shadow-800
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
              class="w-full text-left px-3 py-2.5 border-b border-bark-200 hover:bg-bark-100
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
                {#if ch.linkedContactName}
                  <span class="text-sm text-shadow-600">&middot;</span>
                  <span class="text-sm text-moss-700">{ch.linkedContactName}</span>
                {/if}
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
    </div>

    <!-- Messages panel -->
    <div class="flex-1 card-garden overflow-hidden flex flex-col">
      {#if !selectedSessionId}
        <div class="flex-1 flex items-center justify-center">
          <p class="text-shadow-600 text-sm">Select a channel to view messages</p>
        </div>
      {:else}
        <div class="p-3 border-b border-bark-300 bg-bark-100 flex items-center justify-between">
          <div>
            <h2 class="text-sm font-medium text-shadow-800 truncate" title={selectedChannel?.channelId ?? selectedSessionId}>
              {channelLabel(selectedChannel ?? { sessionId: selectedSessionId, channelId: selectedSessionId, messageCount: 0 })}
            </h2>
            {#if selectedChannel?.channelId}
              <p class="text-sm text-shadow-600 font-mono truncate">{selectedChannel.channelId}</p>
            {/if}
            {#if selectedChannel && selectedChannel.sessionId !== selectedChannel.channelId}
              <p class="text-sm text-shadow-600 font-mono truncate">session: {selectedChannel.sessionId}</p>
            {/if}
          </div>
          <span class="text-sm text-shadow-600">{filteredMessages.length} of {messages.length} messages</span>
        </div>

        <div class="p-3 border-b border-bark-300 bg-bark-100">
          <input
            type="search"
            bind:value={messageSearch}
            placeholder="Filter messages (content, role, author)..."
            class="w-full px-2.5 py-1.5 rounded-lg border border-bark-300 bg-white text-sm text-shadow-800
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

        {#if continuityArtifacts.length > 0}
          <div class="p-3 bg-moss-50 border-b border-moss-200">
            <details>
              <summary class="text-sm text-shadow-700 cursor-pointer hover:text-moss-700">
                {continuityArtifacts.length} continuity artifact(s)
              </summary>
              <div class="mt-3 space-y-2">
                {#each continuityArtifacts as artifact}
                  <div class="rounded-lg border border-moss-200 bg-white p-3">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-sm font-medium text-shadow-800">{continuityArtifactLabel(artifact)}</span>
                      <span class="text-sm text-shadow-600">{formatTimestamp(artifact.createdAt)}</span>
                    </div>
                    {#if artifact.facets.length > 0}
                      <div class="flex flex-wrap gap-1.5 mt-2">
                        {#each artifact.facets as facet}
                          <span class="rounded-full bg-moss-100 px-2 py-0.5 text-sm text-moss-700">
                            {continuityFacetLabel(facet)}
                          </span>
                        {/each}
                      </div>
                    {/if}
                    <p class="mt-2 text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed">{artifact.summary}</p>
                    {#if artifact.nextAnchor}
                      <p class="mt-2 text-sm text-shadow-600">
                        Next anchor: {artifact.nextAnchor}
                      </p>
                    {/if}
                  </div>
                {/each}
              </div>
            </details>
          </div>
        {/if}

        <div class="flex-1 overflow-y-auto p-4 space-y-3">
          {#if loadingMessages}
            <div class="space-y-3">
              {#each Array(5) as _}
                <div class="h-16 bg-bark-300 rounded animate-pulse"></div>
              {/each}
            </div>
          {:else}
            {#each filteredMessages as msg, i}
              <div class="rounded-lg border p-3 {roleColor(msg.role)}">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-semibold {roleLabelColor(msg.role)}">{displayName(msg)}</span>
                  {#if msg.timestamp}
                    <span class="text-sm text-shadow-600">{formatTimestamp(msg.timestamp)}</span>
                  {/if}
                </div>
                <p class="text-sm text-shadow-800 whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </p>

                {#if msg.toolCalls && msg.toolCalls.length > 0}
                  <div class="mt-2">
                    <button
                      onclick={() => expandedToolCall = expandedToolCall === i ? null : i}
                      class="text-sm text-gold-700 hover:text-gold-600"
                    >
                      {expandedToolCall === i ? 'Hide' : 'Show'} {msg.toolCalls.length} tool call(s)
                    </button>
                    {#if expandedToolCall === i}
                      <pre class="mt-1 text-sm bg-bark-100 p-2 rounded overflow-x-auto text-shadow-700 border border-bark-300">{JSON.stringify(msg.toolCalls, null, 2)}</pre>
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
    </div>
  </div>
</div>
