<script lang="ts">
  import { onMount } from 'svelte';
  import { listContacts } from '$lib/api/endpoints/contacts';
  import type { AdminContactListData } from '$lib/types';

  let data = $state<AdminContactListData | null>(null);
  let error = $state('');
  let loading = $state(true);

  onMount(async () => {
    try {
      data = await listContacts();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load contacts';
    } finally {
      loading = false;
    }
  });

  function trustBadgeColor(level: string): string {
    const colors: Record<string, string> = {
      primary: 'bg-gold-100 text-gold-700 border-gold-300',
      trusted: 'bg-moss-50 text-moss-600 border-moss-200',
      regular: 'bg-bark-200 text-shadow-600 border-bark-300',
      public: 'bg-bark-100 text-shadow-400 border-bark-300',
    };
    return colors[level] ?? 'bg-bark-200 text-shadow-500 border-bark-300';
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Visitors</h1>
    <p class="text-shadow-400 text-sm mt-1">Contact Management</p>
  </div>

  {#if loading}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="card p-4 animate-pulse">
          <div class="h-4 bg-bark-200 rounded w-32 mb-2"></div>
          <div class="h-3 bg-bark-200 rounded w-48"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="card p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium">Failed to load contacts</p>
      <p class="text-shadow-400 text-sm mt-1">{error}</p>
    </div>
  {:else if data}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each data.contacts as contact (contact.id)}
        <div class="card p-4">
          <div class="flex items-start justify-between">
            <div>
              <h3 class="text-shadow-800 font-medium">{contact.displayName}</h3>
              {#if contact.nickname}
                <p class="text-shadow-400 text-sm">{contact.nickname}</p>
              {/if}
            </div>
            <span class="px-2 py-0.5 text-xs rounded border {trustBadgeColor(contact.trustLevel)}">
              {contact.trustLevel}
            </span>
          </div>

          <div class="mt-3 text-xs text-shadow-400 space-y-1">
            <p>Relationship: <span class="text-shadow-600">{contact.relationshipType}</span></p>
            <p>First seen: <span class="text-shadow-600">{new Date(contact.firstSeen).toLocaleDateString()}</span></p>
            <p>Last seen: <span class="text-shadow-600">{new Date(contact.lastSeen).toLocaleDateString()}</span></p>
            {#if data.profileMap[contact.id]}
              <p>Memories: <span class="text-shadow-600">{data.profileMap[contact.id].memoryCount}</span></p>
            {/if}
          </div>

          {#if contact.notes}
            <p class="mt-3 text-sm text-shadow-500 border-t border-bark-200 pt-2">
              {contact.notes}
            </p>
          {/if}

          {#if data.relatedChannelMap[contact.id]?.length}
            <div class="mt-3 border-t border-bark-200 pt-2">
              <p class="text-xs text-shadow-400 mb-1">Channels:</p>
              {#each data.relatedChannelMap[contact.id] as ch}
                <span class="inline-block px-2 py-0.5 text-xs rounded bg-bark-200 text-shadow-500 mr-1 mb-1">
                  {ch.channel}
                </span>
              {/each}
            </div>
          {/if}
        </div>
      {/each}

      {#if data.contacts.length === 0}
        <div class="card p-6 text-center col-span-full">
          <p class="text-shadow-400">No contacts found.</p>
        </div>
      {/if}
    </div>
  {/if}
</div>
