<script lang="ts">
  import { onMount } from 'svelte';
  import { listSessions, getSessionMessages } from '$lib/api/endpoints/sessions';
  import type { ChannelInfo, AdminSessionMessagesData, SessionEntry } from '$lib/types';

  let channels = $state<ChannelInfo[]>([]);
  let selectedChannel = $state<string | null>(null);
  let messages = $state<SessionEntry[]>([]);
  let compactionAudits = $state<AdminSessionMessagesData['compactionAuditViews']>([]);
  let error = $state('');
  let loadingChannels = $state(true);
  let loadingMessages = $state(false);

  let expandedToolCall = $state<number | null>(null);

  async function loadChannels() {
    loadingChannels = true;
    error = '';
    try {
      const data = await listSessions();
      channels = data.channels;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load sessions';
    } finally {
      loadingChannels = false;
    }
  }

  async function selectChannel(channelId: string) {
    selectedChannel = channelId;
    loadingMessages = true;
    messages = [];
    compactionAudits = [];
    try {
      const data = await getSessionMessages(channelId);
      messages = data.messages;
      compactionAudits = data.compactionAuditViews ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load messages';
    } finally {
      loadingMessages = false;
    }
  }

  function roleColor(role: string): string {
    switch (role) {
      case 'user': return 'bg-moss-50 border-moss-200';
      case 'assistant': return 'bg-gold-50 border-gold-200';
      case 'system': return 'bg-bark-200 border-bark-300';
      default: return 'bg-bark-100 border-bark-300';
    }
  }

  function roleLabelColor(role: string): string {
    switch (role) {
      case 'user': return 'text-moss-600';
      case 'assistant': return 'text-gold-700';
      case 'system': return 'text-shadow-700';
      default: return 'text-shadow-700';
    }
  }

  function formatTimestamp(ts?: string): string {
    if (!ts) return '';
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function channelLabel(ch: ChannelInfo): string {
    if (ch.displayLabel) return ch.displayLabel;
    // Shorten long channel IDs
    const id = ch.channelId;
    if (id.length > 30) return id.slice(0, 15) + '...' + id.slice(-10);
    return id;
  }

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
    <div class="card p-4 border-wilt-200">
      <p class="text-wilt-600 text-sm">{error}</p>
    </div>
  {/if}

  <div class="flex gap-4 h-[calc(100vh-12rem)]">
    <!-- Channel list -->
    <div class="w-72 shrink-0 card overflow-hidden flex flex-col">
      <div class="p-3 border-b border-bark-300 bg-bark-100">
        <h2 class="text-sm font-medium text-shadow-600">Channels</h2>
      </div>
      <div class="flex-1 overflow-y-auto">
        {#if loadingChannels}
          <div class="p-3 space-y-2">
            {#each Array(6) as _}
              <div class="h-10 bg-bark-200 rounded animate-pulse"></div>
            {/each}
          </div>
        {:else}
          {#each channels as ch (ch.channelId)}
            <button
              onclick={() => selectChannel(ch.channelId)}
              class="w-full text-left px-3 py-2.5 border-b border-bark-200 hover:bg-bark-100
                     transition-colors"
              class:bg-gold-50={selectedChannel === ch.channelId}
              class:border-l-3={selectedChannel === ch.channelId}
              class:border-l-gold-400={selectedChannel === ch.channelId}
            >
              <span class="text-sm text-shadow-700 block truncate" title={ch.channelId}>
                {channelLabel(ch)}
              </span>
              <span class="text-sm text-shadow-600">
                {ch.messageCount} messages
                {#if ch.linkedContactName}
                  &middot; {ch.linkedContactName}
                {/if}
              </span>
            </button>
          {/each}
          {#if channels.length === 0}
            <p class="p-4 text-shadow-700 text-sm text-center">No sessions found.</p>
          {/if}
        {/if}
      </div>
    </div>

    <!-- Messages panel -->
    <div class="flex-1 card overflow-hidden flex flex-col">
      {#if !selectedChannel}
        <div class="flex-1 flex items-center justify-center">
          <p class="text-shadow-700">Select a channel to view messages</p>
        </div>
      {:else}
        <div class="p-3 border-b border-bark-300 bg-bark-100 flex items-center justify-between">
          <h2 class="text-sm font-medium text-shadow-600 truncate" title={selectedChannel}>
            {selectedChannel}
          </h2>
          <span class="text-sm text-shadow-600">{messages.length} messages</span>
        </div>

        <!-- Compaction audits -->
        {#if compactionAudits.length > 0}
          <div class="p-2 bg-bark-200 border-b border-bark-300">
            <details>
              <summary class="text-sm text-shadow-700 cursor-pointer hover:text-gold-600">
                {compactionAudits.length} compaction(s)
              </summary>
              <div class="mt-2 space-y-1">
                {#each compactionAudits as audit}
                  <div class="text-sm text-shadow-600 bg-bark-50 p-2 rounded">
                    <span class="font-medium">{audit.verification}</span>
                    &mdash; {audit.summary.slice(0, 120)}{audit.summary.length > 120 ? '...' : ''}
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
                <div class="h-16 bg-bark-200 rounded animate-pulse"></div>
              {/each}
            </div>
          {:else}
            {#each messages as msg, i}
              <div class="rounded-lg border p-3 {roleColor(msg.role)}">
                <div class="flex items-center justify-between mb-1">
                  <span class="text-sm font-medium uppercase {roleLabelColor(msg.role)}">{msg.role}</span>
                  {#if msg.timestamp}
                    <span class="text-sm text-shadow-600">{formatTimestamp(msg.timestamp)}</span>
                  {/if}
                </div>
                <p class="text-sm text-shadow-700 whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </p>

                {#if msg.toolCalls && msg.toolCalls.length > 0}
                  <div class="mt-2">
                    <button
                      onclick={() => expandedToolCall = expandedToolCall === i ? null : i}
                      class="text-xs text-gold-600 hover:text-gold-700"
                    >
                      {expandedToolCall === i ? 'Hide' : 'Show'} {msg.toolCalls.length} tool call(s)
                    </button>
                    {#if expandedToolCall === i}
                      <pre class="mt-1 text-sm bg-bark-50 p-2 rounded overflow-x-auto text-shadow-800 border border-bark-300">{JSON.stringify(msg.toolCalls, null, 2)}</pre>
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

            {#if messages.length === 0}
              <p class="text-shadow-700 text-sm text-center py-8">No messages in this session.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
