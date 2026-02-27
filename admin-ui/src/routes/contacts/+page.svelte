<script lang="ts">
  import { onMount } from 'svelte';
  import { listContacts, updateContact } from '$lib/api/endpoints/contacts';
  import type { Contact, AdminContactListData } from '$lib/types';

  let data = $state<AdminContactListData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let editingContact = $state<string | null>(null);
  let editTrust = $state<string>('');
  let saving = $state(false);

  const TRUST_BADGE: Record<string, { class: string; label: string }> = {
    primary:  { class: 'bg-gold-100 text-gold-800 border-gold-300', label: 'Primary' },
    trusted:  { class: 'bg-moss-100 text-moss-800 border-moss-300', label: 'Trusted' },
    regular:  { class: 'bg-bark-200 text-bark-700 border-bark-300', label: 'Regular' },
    public:   { class: 'bg-shadow-100 text-shadow-600 border-shadow-300', label: 'Public' },
  };

  onMount(async () => {
    try {
      data = await listContacts();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load contacts';
    } finally {
      loading = false;
    }
  });

  function startEdit(contact: Contact) {
    editingContact = contact.id;
    editTrust = contact.trustLevel;
  }

  async function saveTrust(contactId: string) {
    saving = true;
    try {
      await updateContact(contactId, { trustLevel: editTrust });
      data = await listContacts();
      editingContact = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update contact';
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Visitors</h1>
    <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Contacts and trust management</p>
  </div>

  {#if loading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each Array(6) as _}
        <div class="card-garden p-5 animate-pulse">
          <div class="h-5 bg-bark-200 dark:bg-shadow-700 rounded w-32 mb-3"></div>
          <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-20"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="card-garden p-6 text-center text-wilt-600">{error}</div>
  {:else if data}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each data.contacts as contact (contact.id)}
        {@const badge = TRUST_BADGE[contact.trustLevel] || TRUST_BADGE.public}
        <div class="card-garden p-5 space-y-3">
          <div class="flex items-start justify-between">
            <div>
              <h3 class="text-base font-serif font-semibold text-shadow-800 dark:text-bark-200">{contact.displayName}</h3>
              {#if contact.nickname}
                <p class="text-xs text-shadow-400 dark:text-bark-500">aka {contact.nickname}</p>
              {/if}
            </div>
            {#if editingContact === contact.id}
              <div class="flex items-center gap-2">
                <select
                  bind:value={editTrust}
                  class="text-xs px-2 py-1 rounded border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800"
                >
                  <option value="primary">Primary</option>
                  <option value="trusted">Trusted</option>
                  <option value="regular">Regular</option>
                  <option value="public">Public</option>
                </select>
                <button
                  onclick={() => saveTrust(contact.id)}
                  disabled={saving}
                  class="text-xs px-2 py-1 bg-gold-600 text-white rounded hover:bg-gold-700 disabled:opacity-50"
                >Save</button>
                <button
                  onclick={() => editingContact = null}
                  class="text-xs px-2 py-1 text-shadow-400 hover:text-shadow-600"
                >Cancel</button>
              </div>
            {:else}
              <button onclick={() => startEdit(contact)} class="group">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border {badge.class} group-hover:ring-1 group-hover:ring-gold-300 transition-all">
                  {badge.label}
                </span>
              </button>
            {/if}
          </div>

          <div class="text-xs text-shadow-500 dark:text-bark-400 space-y-1">
            <p>Relationship: <span class="capitalize">{contact.relationshipType.replace('_', ' ')}</span></p>
            <p>First seen: {new Date(contact.firstSeen).toLocaleDateString()}</p>
            <p>Last seen: {new Date(contact.lastSeen).toLocaleDateString()}</p>
          </div>

          {#if contact.notes}
            <p class="text-xs text-shadow-600 dark:text-bark-400 italic border-t border-bark-100 dark:border-shadow-800 pt-2">{contact.notes}</p>
          {/if}

          {#if data.profileMap[contact.id]}
            <div class="text-[11px] text-shadow-400 dark:text-bark-500">
              {data.profileMap[contact.id].memoryCount} linked memories
            </div>
          {/if}
        </div>
      {:else}
        <div class="col-span-full card-garden p-8 text-center text-shadow-400 dark:text-bark-500 italic">
          No contacts found
        </div>
      {/each}
    </div>
  {/if}
</div>
