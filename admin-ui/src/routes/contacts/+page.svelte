<script lang="ts">
  import { onMount } from 'svelte';
  import { listContacts, updateContact } from '$lib/api/endpoints/contacts';
  import type {
    Contact,
    AdminContactListData,
    ContactIdentityLinkVerification,
    ContactMutationAuditEntry,
    ContactConversationChannelView,
    ContactProfileArtifact,
    RelationshipType,
    TrustLevel,
  } from '$lib/types';

  let data = $state<AdminContactListData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let editingContact = $state<string | null>(null);
  let saving = $state(false);

  // Edit form fields
  let editDisplayName = $state('');
  let editNickname = $state('');
  let editTrust = $state<string>('');
  let editRelationship = $state<string>('');
  let editNotes = $state('');

  // Collapsible sections
  let showVerifications = $state(true);
  let showAuditTrail = $state(true);

  const TRUST_LEVELS: TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];
  const RELATIONSHIP_TYPES: RelationshipType[] = ['partner', 'family', 'friend', 'acquaintance', 'stranger', 'ai_companion'];

  const TRUST_BADGE: Record<string, { class: string; label: string }> = {
    primary:  { class: 'bg-gold-100 text-gold-800 border-gold-300 dark:bg-gold-900/30 dark:text-gold-300 dark:border-gold-700', label: 'Primary' },
    trusted:  { class: 'bg-moss-100 text-moss-800 border-moss-300 dark:bg-moss-900/30 dark:text-moss-300 dark:border-moss-700', label: 'Trusted' },
    regular:  { class: 'bg-bark-200 text-bark-700 border-bark-300 dark:bg-bark-800/30 dark:text-bark-300 dark:border-bark-700', label: 'Regular' },
    public:   { class: 'bg-shadow-100 text-shadow-600 border-shadow-300 dark:bg-shadow-800/30 dark:text-shadow-400 dark:border-shadow-700', label: 'Public' },
  };

  const VERIFICATION_STATUS: Record<string, { class: string; label: string }> = {
    pending:  { class: 'bg-bark-200 text-bark-700 dark:bg-bark-800/30 dark:text-bark-300', label: 'Pending' },
    verified: { class: 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300', label: 'Verified' },
    failed:   { class: 'bg-wilt-100 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300', label: 'Failed' },
    expired:  { class: 'bg-shadow-200 text-shadow-600 dark:bg-shadow-800/30 dark:text-shadow-400', label: 'Expired' },
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
    editDisplayName = contact.displayName;
    editNickname = contact.nickname ?? '';
    editTrust = contact.trustLevel;
    editRelationship = contact.relationshipType;
    editNotes = contact.notes ?? '';
  }

  function cancelEdit() {
    editingContact = null;
  }

  async function saveContact(contactId: string) {
    saving = true;
    error = '';
    try {
      const patch: Record<string, unknown> = {};
      const contact = data?.contacts.find(c => c.id === contactId);
      if (!contact) return;

      if (editDisplayName.trim() !== contact.displayName) patch.displayName = editDisplayName.trim();
      if (editTrust !== contact.trustLevel) patch.trustLevel = editTrust;
      if (editRelationship !== contact.relationshipType) patch.relationshipType = editRelationship;
      if (editNotes !== (contact.notes ?? '')) patch.notes = editNotes;

      if (Object.keys(patch).length > 0) {
        await updateContact(contactId, patch);
      }
      data = await listContacts();
      editingContact = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update contact';
    } finally {
      saving = false;
    }
  }

  function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDateTime(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function contactDisplayName(contact: Contact): string {
    const displayName = data?.profileMap[contact.id]?.displayName;
    if (displayName && displayName.trim().length > 0) return displayName;
    return contact.displayName;
  }

  function getChannels(contactId: string): ContactConversationChannelView[] {
    return data?.relatedChannelMap[contactId] ?? [];
  }

  function getProfile(contactId: string): ContactProfileArtifact | undefined {
    return data?.profileMap[contactId];
  }

  function contactNameForId(contactId: string): string {
    const contact = data?.contacts.find(c => c.id === contactId);
    return contact ? contactDisplayName(contact) : contactId;
  }
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-800 dark:text-bark-200">The Visitors</h1>
    <p class="text-sm text-shadow-400 dark:text-shadow-500 mt-1">Contacts and trust management</p>
  </div>

  {#if error}
    <div class="card-garden p-4 text-wilt-600 dark:text-wilt-400 text-sm">{error}</div>
  {/if}

  {#if loading}
    <div class="space-y-4">
      <div class="card-garden p-5 animate-pulse">
        <div class="h-5 bg-bark-200 dark:bg-shadow-700 rounded w-48 mb-3"></div>
        <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-full"></div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {#each Array(6) as _}
          <div class="card-garden p-5 animate-pulse">
            <div class="h-5 bg-bark-200 dark:bg-shadow-700 rounded w-32 mb-3"></div>
            <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded w-20"></div>
          </div>
        {/each}
      </div>
    </div>
  {:else if data}
    <!-- Identity Link Verifications -->
    {#if data.verifications.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          class="w-full flex items-center justify-between p-4 text-left hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors"
          onclick={() => showVerifications = !showVerifications}
        >
          <div>
            <h2 class="text-base font-serif font-semibold text-shadow-800 dark:text-bark-200">Identity Link Verifications</h2>
            <p class="text-xs text-shadow-400 dark:text-shadow-500 mt-0.5">Recent cross-channel identity verification challenges</p>
          </div>
          <span class="text-shadow-400 dark:text-shadow-500 text-sm transition-transform {showVerifications ? 'rotate-180' : ''}"
            >&#9660;</span>
        </button>
        {#if showVerifications}
          <div class="border-t border-bark-100 dark:border-shadow-800 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-bark-50 dark:bg-shadow-800/50">
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Status</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Source</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Target</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Contact</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Nonce</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Expiry</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-bark-100 dark:divide-shadow-800">
                {#each data.verifications.slice(0, 10) as v (v.id)}
                  {@const statusBadge = VERIFICATION_STATUS[v.status] || VERIFICATION_STATUS.expired}
                  <tr class="hover:bg-bark-50/50 dark:hover:bg-shadow-800/30">
                    <td class="px-4 py-2.5">
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium {statusBadge.class}">
                        {statusBadge.label}
                      </span>
                    </td>
                    <td class="px-4 py-2.5">
                      <span class="font-mono text-xs text-shadow-600 dark:text-shadow-400">{v.sourceChannel}:{v.sourceUserId}</span>
                    </td>
                    <td class="px-4 py-2.5">
                      <span class="font-mono text-xs text-shadow-600 dark:text-shadow-400">{v.targetChannel}:{v.targetUserId}</span>
                    </td>
                    <td class="px-4 py-2.5 text-xs text-shadow-600 dark:text-shadow-400">{contactNameForId(v.contactId)}</td>
                    <td class="px-4 py-2.5">
                      <span class="font-mono text-[11px] text-shadow-400 dark:text-shadow-500">{v.nonce ?? '-'}</span>
                    </td>
                    <td class="px-4 py-2.5 text-xs text-shadow-500 dark:text-shadow-400">{v.expiresAt ? formatDateTime(v.expiresAt) : '-'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Mutation Audit Trail -->
    {#if data.mutationAudits.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          class="w-full flex items-center justify-between p-4 text-left hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors"
          onclick={() => showAuditTrail = !showAuditTrail}
        >
          <div>
            <h2 class="text-base font-serif font-semibold text-shadow-800 dark:text-bark-200">Trust + Note Mutation Audit</h2>
            <p class="text-xs text-shadow-400 dark:text-shadow-500 mt-0.5">Persistent audit trail for trust level and contact note changes</p>
          </div>
          <span class="text-shadow-400 dark:text-shadow-500 text-sm transition-transform {showAuditTrail ? 'rotate-180' : ''}"
            >&#9660;</span>
        </button>
        {#if showAuditTrail}
          <div class="border-t border-bark-100 dark:border-shadow-800 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-bark-50 dark:bg-shadow-800/50">
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Contact</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Field</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Actor</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Old Value</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">New Value</th>
                  <th class="text-left px-4 py-2 text-xs font-medium text-shadow-500 dark:text-shadow-400 uppercase tracking-wider">Timestamp</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-bark-100 dark:divide-shadow-800">
                {#each data.mutationAudits as audit (audit.id)}
                  <tr class="hover:bg-bark-50/50 dark:hover:bg-shadow-800/30">
                    <td class="px-4 py-2.5">
                      <span class="font-mono text-xs text-shadow-600 dark:text-shadow-400">{contactNameForId(audit.contactId)}</span>
                    </td>
                    <td class="px-4 py-2.5 text-xs text-shadow-600 dark:text-shadow-400 capitalize">
                      {audit.field === 'trust_level' ? 'trust' : audit.field}
                    </td>
                    <td class="px-4 py-2.5">
                      <span class="font-mono text-xs text-shadow-500 dark:text-shadow-400">{audit.actor}</span>
                    </td>
                    <td class="px-4 py-2.5">
                      {#if audit.oldValue}
                        <code class="text-xs bg-bark-100 dark:bg-shadow-800 px-1.5 py-0.5 rounded text-shadow-600 dark:text-shadow-400">{audit.oldValue}</code>
                      {:else}
                        <span class="text-xs text-shadow-300 dark:text-shadow-600 italic">empty</span>
                      {/if}
                    </td>
                    <td class="px-4 py-2.5">
                      {#if audit.newValue}
                        <code class="text-xs bg-bark-100 dark:bg-shadow-800 px-1.5 py-0.5 rounded text-shadow-600 dark:text-shadow-400">{audit.newValue}</code>
                      {:else}
                        <span class="text-xs text-shadow-300 dark:text-shadow-600 italic">empty</span>
                      {/if}
                    </td>
                    <td class="px-4 py-2.5 text-xs text-shadow-500 dark:text-shadow-400">{formatDateTime(audit.timestamp)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Contact Cards -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each data.contacts as contact (contact.id)}
        {@const badge = TRUST_BADGE[contact.trustLevel] || TRUST_BADGE.public}
        {@const channels = getChannels(contact.id)}
        {@const profile = getProfile(contact.id)}

        {#if editingContact === contact.id}
          <!-- Inline Edit Form -->
          <div class="card-garden p-5 space-y-4 col-span-1 md:col-span-2 lg:col-span-3 filigree-border-strong ring-1 ring-gold-300">
            <div class="flex items-center justify-between">
              <h3 class="text-base font-serif font-semibold text-shadow-800 dark:text-bark-200">
                Editing: {contactDisplayName(contact)}
              </h3>
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border {badge.class}">
                {badge.label}
              </span>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label for="edit-display-name" class="block text-xs font-medium text-shadow-600 dark:text-shadow-400 mb-1">Display Name</label>
                <input
                  id="edit-display-name"
                  type="text"
                  bind:value={editDisplayName}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                    focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                />
              </div>
              <div>
                <label for="edit-nickname" class="block text-xs font-medium text-shadow-600 dark:text-shadow-400 mb-1">Nickname</label>
                <input
                  id="edit-nickname"
                  type="text"
                  bind:value={editNickname}
                  placeholder="Optional alias"
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                    placeholder:text-shadow-300 dark:placeholder:text-shadow-600
                    focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                />
              </div>
              <div>
                <label for="edit-trust" class="block text-xs font-medium text-shadow-600 dark:text-shadow-400 mb-1">Trust Level</label>
                <select
                  id="edit-trust"
                  bind:value={editTrust}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                    focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                >
                  {#each TRUST_LEVELS as level}
                    <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
                  {/each}
                </select>
              </div>
              <div>
                <label for="edit-relationship" class="block text-xs font-medium text-shadow-600 dark:text-shadow-400 mb-1">Relationship Type</label>
                <select
                  id="edit-relationship"
                  bind:value={editRelationship}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm
                    focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                >
                  {#each RELATIONSHIP_TYPES as rel}
                    <option value={rel}>{rel.replace('_', ' ')}</option>
                  {/each}
                </select>
              </div>
            </div>

            <div>
              <label for="edit-notes" class="block text-xs font-medium text-shadow-600 dark:text-shadow-400 mb-1">Notes</label>
              <textarea
                id="edit-notes"
                bind:value={editNotes}
                rows={3}
                class="w-full px-3 py-2 rounded-lg border border-bark-300 dark:border-shadow-600 bg-bark-50 dark:bg-shadow-800 text-shadow-900 dark:text-bark-200 text-sm resize-vertical
                  placeholder:text-shadow-300 dark:placeholder:text-shadow-600
                  focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                placeholder="Notes about this contact..."
              ></textarea>
            </div>

            <div class="flex gap-2 pt-1">
              <button
                onclick={() => saveContact(contact.id)}
                disabled={saving}
                class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium hover:bg-gold-700 disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onclick={cancelEdit}
                class="px-4 py-2 rounded-lg text-shadow-500 dark:text-shadow-400 text-sm hover:bg-bark-100 dark:hover:bg-shadow-800 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        {:else}
          <!-- Contact Card -->
          <div class="card-garden p-5 space-y-3">
            <!-- Header: Name + Trust Badge -->
            <div class="flex items-start justify-between">
              <div>
                <h3 class="text-base font-serif font-semibold text-shadow-800 dark:text-bark-200">{contactDisplayName(contact)}</h3>
                {#if contact.nickname && contact.nickname.toLowerCase() !== contact.displayName.toLowerCase()}
                  <p class="text-xs text-shadow-400 dark:text-shadow-500">aka {contact.nickname}</p>
                {/if}
                <p class="text-[10px] font-mono text-shadow-300 dark:text-shadow-600 mt-0.5">contact:{contact.id}</p>
              </div>
              <button onclick={() => startEdit(contact)} class="group shrink-0">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border {badge.class} group-hover:ring-1 group-hover:ring-gold-300 transition-all">
                  {badge.label}
                </span>
              </button>
            </div>

            <!-- Relationship + Activity -->
            <div class="text-xs text-shadow-500 dark:text-shadow-400 space-y-1">
              <p>Relationship: <span class="capitalize text-shadow-700 dark:text-bark-300">{contact.relationshipType.replace('_', ' ')}</span></p>
              <p>First seen: {formatDate(contact.firstSeen)}</p>
              <p>Last seen: {formatDate(contact.lastSeen)}</p>
            </div>

            <!-- Notes -->
            {#if contact.notes}
              <p class="text-xs text-shadow-600 dark:text-shadow-400 italic border-t border-bark-100 dark:border-shadow-800 pt-2">{contact.notes}</p>
            {/if}

            <!-- Related Channels -->
            {#if channels.length > 0}
              <div class="border-t border-bark-100 dark:border-shadow-800 pt-2">
                <p class="text-[11px] font-medium text-shadow-500 dark:text-shadow-400 mb-1.5">Related Channels</p>
                <div class="flex flex-wrap gap-1.5">
                  {#each channels as ch}
                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-bark-100 dark:bg-shadow-800 text-shadow-600 dark:text-shadow-400 font-mono">
                      {ch.channel}:{ch.channelId}
                    </span>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Profile Synthesis -->
            {#if profile}
              <div class="border-t border-bark-100 dark:border-shadow-800 pt-2">
                <p class="text-[11px] font-medium text-shadow-500 dark:text-shadow-400 mb-1">Profile</p>
                {#if profile.summary}
                  <p class="text-xs text-shadow-600 dark:text-shadow-400 leading-relaxed">{profile.summary}</p>
                {/if}
                <div class="flex flex-wrap items-center gap-3 mt-1.5 text-[10px] text-shadow-400 dark:text-shadow-500">
                  <span>{profile.memoryCount} linked memories</span>
                  {#if profile.updatedAt}
                    <span>Updated: {formatTimestamp(profile.updatedAt)}</span>
                  {/if}
                </div>
                {#if profile.sourceMemoryIds && profile.sourceMemoryIds.length > 0}
                  <details class="mt-1.5">
                    <summary class="text-[10px] text-shadow-400 dark:text-shadow-500 cursor-pointer hover:text-gold-600 transition-colors">
                      {profile.sourceMemoryIds.length} source memor{profile.sourceMemoryIds.length === 1 ? 'y' : 'ies'}
                    </summary>
                    <div class="mt-1 flex flex-wrap gap-1">
                      {#each profile.sourceMemoryIds as memId}
                        <code class="text-[9px] bg-bark-100 dark:bg-shadow-800 px-1.5 py-0.5 rounded text-shadow-500 dark:text-shadow-400 break-all">{memId}</code>
                      {/each}
                    </div>
                  </details>
                {/if}
              </div>
            {:else}
              <div class="text-[11px] text-shadow-300 dark:text-shadow-600 italic">No synthesized profile</div>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="col-span-full card-garden p-8 text-center text-shadow-400 dark:text-shadow-500 italic">
          No visitors have been seen in the garden yet
        </div>
      {/each}
    </div>
  {/if}
</div>
