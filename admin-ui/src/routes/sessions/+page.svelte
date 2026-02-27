<script lang="ts">
  import { onMount } from 'svelte';
  import { listSessions, getSessionMessages } from '$lib/api/endpoints/sessions';
  import type { ChannelInfo, SessionEntry } from '$lib/types';

  let channels = $state<ChannelInfo[]>([]);
  let loading = $state(true);
  let error = $state('');
  let selectedChannel = $state<string | null>(null);
  let messages = $state<SessionEntry[]>([]);
  let loadingMessages = $state(false);

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
    try {
      const data = await getSessionMessages(channelId);
      messages = data.messages;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load messages';
    } finally {
      loadingMessages = false;
    }
  }

  function channelLabel(ch: ChannelInfo): string {
    return ch.displayLabel || ch.channelId;
  }
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Branches</h1>
    <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Conversation sessions across all channels</p>
  </div>

  <div class="flex gap-4 h-[calc(100vh-12rem)]">
    <!-- Channel list -->
    <div class="w-72 shrink-0 card-garden overflow-y-auto">
      {#if loading}
        <div class="p-4 space-y-3">
          {#each Array(5) as _}
            <div class="animate-pulse h-12 bg-bark-200 dark:bg-shadow-700 rounded"></div>
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
              <p class="text-sm font-medium text-shadow-700 dark:text-bark-300 truncate">{channelLabel(ch)}</p>
              <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-0.5">
                {ch.messageCount} messages
                {#if ch.linkedContactName}
                  &middot; {ch.linkedContactName}
                {/if}
              </p>
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
        <div class="space-y-4">
          {#each messages as msg, i (i)}
            <div class="flex gap-3 {msg.role === 'assistant' ? '' : ''}">
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
      {/if}
    </div>
  </div>
</div>
