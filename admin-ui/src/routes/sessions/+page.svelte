<script lang="ts">
  import { onMount } from 'svelte';
  import { listSessions, getSessionMessages } from '$lib/api/endpoints/sessions';
  import type { ChannelInfo, SessionEntry, CompactionAuditView } from '$lib/types';

  let channels = $state<ChannelInfo[]>([]);
  let loading = $state(true);
  let error = $state('');
  let selectedChannel = $state<string | null>(null);
  let messages = $state<SessionEntry[]>([]);
  let compactionAuditViews = $state<CompactionAuditView[]>([]);
  let loadingMessages = $state(false);

  const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

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

  function toChannelTypeLabel(channelType: string): string {
    const normalized = channelType.trim().toLowerCase();
    if (!normalized) return 'Session';
    const mapped = CHANNEL_TYPE_LABELS[normalized];
    if (mapped) return mapped;
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function toReadableChannelLabel(channelId: string): string {
    if (DISCORD_CHANNEL_ID_PATTERN.test(channelId)) {
      return `Discord \u00b7 channel ${channelId}`;
    }
    const separatorIndex = channelId.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex >= channelId.length - 1) return channelId;
    const channelType = channelId.slice(0, separatorIndex);
    const channelName = channelId.slice(separatorIndex + 1);
    const typeLabel = toChannelTypeLabel(channelType);
    return `${typeLabel} \u00b7 ${channelName}`;
  }

  function channelTypeTag(channelId: string): string {
    if (DISCORD_CHANNEL_ID_PATTERN.test(channelId)) return 'Discord';
    const separatorIndex = channelId.indexOf(':');
    if (separatorIndex <= 0) return '';
    return toChannelTypeLabel(channelId.slice(0, separatorIndex));
  }

  function channelLabel(ch: ChannelInfo): string {
    return ch.displayLabel || toReadableChannelLabel(ch.channelId);
  }

  function verificationLabel(verification: string): string {
    switch (verification) {
      case 'verified': return 'Verified';
      case 'mismatch': return 'Mismatch';
      case 'missing_source': return 'Source Missing';
      case 'missing_hash':
      default: return 'Hash Missing';
    }
  }

  function verificationBadgeClass(verification: string): string {
    switch (verification) {
      case 'verified':
        return 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300 border-moss-300 dark:border-moss-700';
      case 'mismatch':
        return 'bg-wilt-100 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300 border-wilt-300 dark:border-wilt-700';
      case 'missing_source':
        return 'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-300 border-gold-300 dark:border-gold-700';
      case 'missing_hash':
      default:
        return 'bg-shadow-100 text-shadow-500 dark:bg-shadow-800 dark:text-bark-400 border-shadow-300 dark:border-shadow-600';
    }
  }

  onMount(async () => {
    try {
      const data = await listSessions();
      channels = data.channels;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load sessions';
    } finally {
      loading = false;
    }
  });

  async function selectChannel(channelId: string) {
    selectedChannel = channelId;
    loadingMessages = true;
    error = '';
    try {
      const data = await getSessionMessages(channelId);
      messages = data.messages;
      compactionAuditViews = data.compactionAuditViews ?? [];
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load messages';
    } finally {
      loadingMessages = false;
    }
  }
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Branches</h1>
    <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Conversation sessions across all channels</p>
  </div>

  {#if error}
    <div class="card-garden p-4 text-wilt-600 dark:text-wilt-400 text-sm">{error}</div>
  {/if}

  <div class="flex gap-4 h-[calc(100vh-12rem)]">
    <!-- Channel list -->
    <div class="w-80 shrink-0 card-garden overflow-y-auto">
      {#if loading}
        <div class="p-4 space-y-3">
          {#each Array(5) as _}
            <div class="animate-pulse h-14 bg-bark-200 dark:bg-shadow-700 rounded"></div>
          {/each}
        </div>
      {:else}
        <div class="divide-y divide-bark-100 dark:divide-shadow-800">
          {#each channels as ch (ch.channelId)}
            <button
              class="w-full text-left px-4 py-3 hover:bg-bark-50 dark:hover:bg-shadow-800 transition-colors
                {selectedChannel === ch.channelId ? 'bg-gold-50 dark:bg-gold-900/20 border-l-2 border-gold-400' : ''}"
              onclick={() => selectChannel(ch.channelId)}
            >
              <div class="flex items-center gap-2">
                <p class="text-sm font-medium text-shadow-700 dark:text-bark-300 truncate flex-1">{channelLabel(ch)}</p>
                {#if channelTypeTag(ch.channelId)}
                  <span class="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-bark-100 dark:bg-shadow-800 text-shadow-500 dark:text-bark-400 border border-bark-200 dark:border-shadow-700">
                    {channelTypeTag(ch.channelId)}
                  </span>
                {/if}
              </div>
              {#if ch.displayLabel && ch.displayLabel !== ch.channelId}
                <p class="text-[10px] text-shadow-300 dark:text-bark-500 mt-0.5 font-mono truncate">id: {ch.channelId}</p>
              {/if}
              <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-0.5">
                {ch.messageCount} messages
              </p>
              {#if ch.linkedContactName}
                <p class="text-[11px] text-moss-600 dark:text-moss-400 mt-0.5">
                  <a href="/contacts#{`contact-row-${ch.linkedContactId}`}" class="hover:underline">
                    {ch.linkedContactName}
                  </a>
                </p>
              {/if}
            </button>
          {:else}
            <p class="p-4 text-sm text-shadow-400 dark:text-bark-500 italic">No sessions found</p>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Message view -->
    <div class="flex-1 card-garden overflow-y-auto p-4">
      {#if !selectedChannel}
        <div class="flex items-center justify-center h-full text-shadow-300 dark:text-bark-500 italic">
          Select a channel to view messages
        </div>
      {:else if loadingMessages}
        <div class="space-y-4 animate-pulse">
          {#each Array(6) as _}
            <div class="flex gap-3">
              <div class="w-8 h-8 rounded-full bg-bark-200 dark:bg-shadow-700 shrink-0"></div>
              <div class="flex-1 space-y-1">
                <div class="h-3 bg-bark-200 dark:bg-shadow-700 rounded w-24"></div>
                <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-3/4"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="space-y-6">
          <!-- Channel header -->
          <div class="pb-3 border-b border-bark-100 dark:border-shadow-800">
            <p class="text-sm text-shadow-500 dark:text-bark-400">
              Channel: <span class="font-mono text-shadow-700 dark:text-bark-300">{selectedChannel}</span>
              <span class="text-shadow-300 dark:text-bark-500 ml-2">({messages.length} messages)</span>
            </p>
          </div>

          <!-- Compaction audit section -->
          {#if compactionAuditViews.length > 0 || selectedChannel}
            <div class="space-y-2">
              <h3 class="text-sm font-serif font-semibold text-shadow-600 dark:text-bark-400">Compaction Audit</h3>
              <p class="text-[11px] text-shadow-400 dark:text-bark-500">
                Click a summary to inspect source material hash metadata and JSONL verification.
              </p>

              {#if compactionAuditViews.length === 0}
                <p class="text-xs text-shadow-300 dark:text-bark-500 italic py-2">
                  No compaction summaries for this channel yet.
                </p>
              {:else}
                <div class="space-y-2">
                  {#each compactionAuditViews as entry (entry.id)}
                    <details class="group rounded-lg border border-bark-200 dark:border-shadow-700 overflow-hidden">
                      <summary class="flex items-center justify-between gap-3 px-4 py-2.5 cursor-pointer
                        bg-bark-50 dark:bg-shadow-800/50 hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors">
                        <span class="text-sm text-shadow-700 dark:text-bark-300 font-medium">Summary #{entry.id}</span>
                        <span class="text-[11px] px-2 py-0.5 rounded-full border {verificationBadgeClass(entry.verification)}">
                          {verificationLabel(entry.verification)}
                        </span>
                      </summary>
                      <div class="px-4 py-3 space-y-2 bg-white dark:bg-shadow-900 border-t border-bark-100 dark:border-shadow-800">
                        <p class="text-[11px] text-shadow-400 dark:text-bark-500">
                          Created {new Date(entry.createdAt).toLocaleString()} &middot; coveredUpTo={entry.coveredUpTo}
                        </p>
                        {#if entry.sourceFirstMessageId !== null && entry.sourceLastMessageId !== null}
                          <p class="text-[11px] text-shadow-400 dark:text-bark-500">
                            Source ids {entry.sourceFirstMessageId}-{entry.sourceLastMessageId}
                            &middot; source message count {entry.sourceMessageCount ?? 'unknown'}
                          </p>
                        {:else}
                          <p class="text-[11px] text-shadow-400 dark:text-bark-500">
                            Source ids unknown &middot; source message count unknown
                          </p>
                        {/if}
                        <p class="text-[11px] text-shadow-400 dark:text-bark-500">
                          Source SHA-256:
                          {#if entry.sourceHash}
                            <code class="font-mono text-[10px] bg-bark-100 dark:bg-shadow-800 px-1 py-0.5 rounded">{entry.sourceHash}</code>
                          {:else}
                            <span class="italic text-shadow-300 dark:text-bark-500">not recorded</span>
                          {/if}
                        </p>
                        <p class="text-[11px] text-shadow-400 dark:text-bark-500">
                          JSONL verification: {entry.verificationDetail}
                        </p>
                        <pre class="mt-2 text-xs font-mono bg-bark-50 dark:bg-shadow-900 border border-bark-200 dark:border-shadow-700 p-3 rounded overflow-x-auto text-shadow-700 dark:text-bark-300 whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">{entry.summary}</pre>
                      </div>
                    </details>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- Divider between audit and messages -->
            <div class="border-t border-bark-100 dark:border-shadow-800"></div>
          {/if}

          <!-- Messages -->
          <div class="space-y-4">
            {#each messages as msg, i (i)}
              <div class="flex gap-3">
                <!-- Avatar -->
                <div class="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold
                  {msg.role === 'user' ? 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300' :
                   msg.role === 'assistant' ? 'bg-gold-100 text-gold-700 dark:bg-gold-900/30 dark:text-gold-300' :
                   'bg-shadow-100 text-shadow-500 dark:bg-shadow-800 dark:text-bark-400'}">
                  {msg.role === 'user' ? 'U' : msg.role === 'assistant' ? 'P' : 'S'}
                </div>

                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs font-medium text-shadow-600 dark:text-bark-400 capitalize">{msg.role}</span>
                    {#if msg.timestamp}
                      <span class="text-[11px] text-shadow-300 dark:text-bark-500">{new Date(msg.timestamp).toLocaleString()}</span>
                    {/if}
                    {#if msg.originChannelId}
                      <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-bark-100 dark:bg-shadow-800 text-shadow-400 dark:text-bark-500 border border-bark-200 dark:border-shadow-700">
                        from {toReadableChannelLabel(msg.originChannelId)}
                      </span>
                    {/if}
                  </div>
                  <div class="text-sm text-shadow-800 dark:text-bark-200 whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                  {#if msg.toolCalls && msg.toolCalls.length > 0}
                    <details class="mt-2">
                      <summary class="text-xs text-shadow-400 dark:text-bark-500 cursor-pointer hover:text-gold-600">
                        {msg.toolCalls.length} tool call{msg.toolCalls.length > 1 ? 's' : ''}
                      </summary>
                      <pre class="mt-1 text-[11px] font-mono bg-bark-50 dark:bg-shadow-900 p-2 rounded overflow-x-auto text-shadow-600 dark:text-bark-400">{JSON.stringify(msg.toolCalls, null, 2)}</pre>
                    </details>
                  {/if}
                </div>
              </div>
            {:else}
              <p class="text-sm text-shadow-400 dark:text-bark-500 italic text-center py-8">No messages in this session</p>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>
