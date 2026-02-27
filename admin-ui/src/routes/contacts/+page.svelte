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
  let saving = $state(false);
  let saveMessage = $state('');
  let saveOk = $state(true);

  // Inline trust editing
  let editingTrustId = $state<string | null>(null);
  let editTrustValue = $state<TrustLevel>('regular');

  // Inline notes editing
  let editingNotesId = $state<string | null>(null);
  let editNotesValue = $state('');

  // Collapsible panels
  let showVerifications = $state(false);
  let showAuditTrail = $state(false);

  const TRUST_LEVELS: TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];

  const TRUST_BADGE: Record<string, { bg: string; text: string; border: string; label: string }> = {
    primary:  { bg: 'bg-gold-50 dark:bg-gold-900/20', text: 'text-gold-700 dark:text-gold-300', border: 'border-gold-300 dark:border-gold-700', label: 'Primary' },
    trusted:  { bg: 'bg-moss-50 dark:bg-moss-900/20', text: 'text-moss-700 dark:text-moss-300', border: 'border-moss-300 dark:border-moss-700', label: 'Trusted' },
    regular:  { bg: 'bg-bark-100 dark:bg-shadow-800', text: 'text-shadow-500 dark:text-bark-400', border: 'border-bark-300 dark:border-shadow-600', label: 'Regular' },
    public:   { bg: 'bg-shadow-50 dark:bg-shadow-800', text: 'text-shadow-400 dark:text-bark-500', border: 'border-shadow-200 dark:border-shadow-700', label: 'Public' },
  };

  const VERIFICATION_STATUS: Record<string, { cls: string; label: string }> = {
    pending:  { cls: 'bg-bark-200 text-shadow-500 dark:bg-shadow-700 dark:text-bark-400', label: 'Pending' },
    verified: { cls: 'bg-moss-100 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300', label: 'Verified' },
    failed:   { cls: 'bg-wilt-100 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300', label: 'Failed' },
    expired:  { cls: 'bg-shadow-100 text-shadow-500 dark:bg-shadow-800 dark:text-bark-500', label: 'Expired' },
  };

  // ── Helpers ──

  function flash(ok: boolean, msg: string) {
    saveOk = ok;
    saveMessage = msg;
    setTimeout(() => { saveMessage = ''; }, 4000);
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
    const profile = data?.profileMap[contact.id];
    if (profile?.displayName && profile.displayName.trim().length > 0) return profile.displayName;
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

  function badgeFor(trust: string) {
    return TRUST_BADGE[trust] ?? TRUST_BADGE.public;
  }

  // ── Trust editing ──

  function startTrustEdit(contact: Contact) {
    editingTrustId = contact.id;
    editTrustValue = contact.trustLevel as TrustLevel;
  }

  function cancelTrustEdit() {
    editingTrustId = null;
  }

  async function saveTrust(contactId: string) {
    saving = true;
    try {
      await updateContact(contactId, { trustLevel: editTrustValue });
      data = await listContacts();
      editingTrustId = null;
      flash(true, 'Trust level updated');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to update trust');
    } finally {
      saving = false;
    }
  }

  // ── Notes editing ──

  function startNotesEdit(contact: Contact) {
    editingNotesId = contact.id;
    editNotesValue = contact.notes ?? '';
  }

  function cancelNotesEdit() {
    editingNotesId = null;
  }

  async function saveNotes(contactId: string) {
    saving = true;
    try {
      await updateContact(contactId, { notes: editNotesValue });
      data = await listContacts();
      editingNotesId = null;
      flash(true, 'Notes updated');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to update notes');
    } finally {
      saving = false;
    }
  }

  // ── Init ──

  onMount(async () => {
    try {
      data = await listContacts();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load contacts';
    } finally {
      loading = false;
    }
  });
</script>

<div class="space-y-5">
  <!-- ── Header ── -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-900 dark:text-bark-200">The Visitors</h1>
    <p class="text-sm text-shadow-400 dark:text-bark-500 mt-1">Contacts and trust management</p>
  </div>

  <!-- Flash message -->
  {#if saveMessage}
    <div class="px-4 py-2.5 rounded-lg text-sm font-medium
      {saveOk
        ? 'bg-moss-50 text-moss-700 dark:bg-moss-900/30 dark:text-moss-300 border border-moss-200 dark:border-moss-800'
        : 'bg-wilt-50 text-wilt-700 dark:bg-wilt-900/30 dark:text-wilt-300 border border-wilt-200 dark:border-wilt-800'}">
      {saveMessage}
    </div>
  {/if}

  <!-- Error -->
  {#if error}
    <div class="card-garden p-5 text-center text-wilt-600 dark:text-wilt-400 text-sm">{error}</div>
  {/if}

  <!-- ── Loading ── -->
  {#if loading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each Array(6) as _}
        <div class="card-garden p-5 animate-pulse space-y-3">
          <div class="h-5 bg-bark-200 dark:bg-shadow-700 rounded w-32"></div>
          <div class="h-3 bg-bark-200 dark:bg-shadow-700 rounded w-20"></div>
          <div class="h-3 bg-bark-200 dark:bg-shadow-700 rounded w-full"></div>
        </div>
      {/each}
    </div>

  {:else if data}
    <!-- ── Identity Link Verifications (collapsible) ── -->
    {#if data.verifications.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          class="w-full flex items-center justify-between px-5 py-3.5 text-left
                 hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors"
          onclick={() => showVerifications = !showVerifications}
        >
          <div>
            <h2 class="text-sm font-serif font-semibold text-shadow-800 dark:text-bark-200">Identity Link Verifications</h2>
            <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-0.5">
              {data.verifications.length} cross-channel verification{data.verifications.length !== 1 ? 's' : ''}
            </p>
          </div>
          <span class="text-shadow-400 dark:text-bark-500 text-sm transition-transform {showVerifications ? 'rotate-180' : ''}">
            &#9660;
          </span>
        </button>
        {#if showVerifications}
          <div class="border-t border-bark-100 dark:border-shadow-800 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-bark-50 dark:bg-shadow-800/50">
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Status</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Source</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Target</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Contact</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Nonce</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Expiry</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-bark-100 dark:divide-shadow-800">
                {#each data.verifications.slice(0, 10) as v (v.id)}
                  {@const vs = VERIFICATION_STATUS[v.status] ?? VERIFICATION_STATUS.expired}
                  <tr class="hover:bg-bark-50/50 dark:hover:bg-shadow-800/30">
                    <td class="px-4 py-2.5">
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium {vs.cls}">
                        {vs.label}
                      </span>
                    </td>
                    <td class="px-4 py-2.5 font-mono text-xs text-shadow-800 dark:text-bark-300">{v.sourceChannel}:{v.sourceUserId}</td>
                    <td class="px-4 py-2.5 font-mono text-xs text-shadow-800 dark:text-bark-300">{v.targetChannel}:{v.targetUserId}</td>
                    <td class="px-4 py-2.5 text-xs text-shadow-500 dark:text-bark-400">{contactNameForId(v.contactId)}</td>
                    <td class="px-4 py-2.5 font-mono text-[10px] text-shadow-400 dark:text-bark-500">{v.nonce ?? '-'}</td>
                    <td class="px-4 py-2.5 text-xs text-shadow-500 dark:text-bark-400">{v.expiresAt ? formatDateTime(v.expiresAt) : '-'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Mutation Audit Trail (collapsible) ── -->
    {#if data.mutationAudits.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          class="w-full flex items-center justify-between px-5 py-3.5 text-left
                 hover:bg-bark-50 dark:hover:bg-shadow-800/50 transition-colors"
          onclick={() => showAuditTrail = !showAuditTrail}
        >
          <div>
            <h2 class="text-sm font-serif font-semibold text-shadow-800 dark:text-bark-200">Trust & Note Mutation Audit</h2>
            <p class="text-[11px] text-shadow-400 dark:text-bark-500 mt-0.5">
              {data.mutationAudits.length} mutation{data.mutationAudits.length !== 1 ? 's' : ''} recorded
            </p>
          </div>
          <span class="text-shadow-400 dark:text-bark-500 text-sm transition-transform {showAuditTrail ? 'rotate-180' : ''}">
            &#9660;
          </span>
        </button>
        {#if showAuditTrail}
          <div class="border-t border-bark-100 dark:border-shadow-800 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-bark-50 dark:bg-shadow-800/50">
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Contact</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Field</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Actor</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Old Value</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">New Value</th>
                  <th class="text-left px-4 py-2.5 text-[10px] font-medium text-shadow-400 dark:text-bark-500 uppercase tracking-wider">Timestamp</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-bark-100 dark:divide-shadow-800">
                {#each data.mutationAudits as audit (audit.id)}
                  <tr class="hover:bg-bark-50/50 dark:hover:bg-shadow-800/30">
                    <td class="px-4 py-2.5 text-xs text-shadow-800 dark:text-bark-300">{contactNameForId(audit.contactId)}</td>
                    <td class="px-4 py-2.5 text-xs text-shadow-500 dark:text-bark-400 capitalize">
                      {audit.field === 'trust_level' ? 'trust' : audit.field}
                    </td>
                    <td class="px-4 py-2.5 font-mono text-xs text-shadow-500 dark:text-bark-400">{audit.actor}</td>
                    <td class="px-4 py-2.5">
                      {#if audit.oldValue}
                        <code class="text-xs bg-bark-100 dark:bg-shadow-800 px-1.5 py-0.5 rounded text-shadow-800 dark:text-bark-300">{audit.oldValue}</code>
                      {:else}
                        <span class="text-xs text-shadow-400 dark:text-bark-500 italic">empty</span>
                      {/if}
                    </td>
                    <td class="px-4 py-2.5">
                      {#if audit.newValue}
                        <code class="text-xs bg-bark-100 dark:bg-shadow-800 px-1.5 py-0.5 rounded text-shadow-800 dark:text-bark-300">{audit.newValue}</code>
                      {:else}
                        <span class="text-xs text-shadow-400 dark:text-bark-500 italic">empty</span>
                      {/if}
                    </td>
                    <td class="px-4 py-2.5 text-xs text-shadow-500 dark:text-bark-400">{formatDateTime(audit.timestamp)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Contact Cards Grid ── -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each data.contacts as contact (contact.id)}
        {@const badge = badgeFor(contact.trustLevel)}
        {@const channels = getChannels(contact.id)}
        {@const profile = getProfile(contact.id)}

        <div class="card-garden p-5 flex flex-col gap-3">
          <!-- Header: Name + Trust Badge -->
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="text-base font-serif font-semibold text-shadow-900 dark:text-bark-200 truncate">
                {contactDisplayName(contact)}
              </h3>
              {#if contact.nickname && contact.nickname.toLowerCase() !== contact.displayName.toLowerCase()}
                <p class="text-xs text-shadow-400 dark:text-bark-500 truncate">aka {contact.nickname}</p>
              {/if}
            </div>

            <!-- Trust badge (clickable to edit) -->
            {#if editingTrustId === contact.id}
              <div class="flex items-center gap-1.5 shrink-0">
                <select bind:value={editTrustValue}
                  class="text-xs px-2 py-1 rounded-lg border border-gold-300 dark:border-gold-700
                         bg-white dark:bg-shadow-800 text-shadow-800 dark:text-bark-200
                         focus:outline-none focus:ring-2 focus:ring-gold-300">
                  {#each TRUST_LEVELS as level}
                    <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
                  {/each}
                </select>
                <button onclick={() => saveTrust(contact.id)} disabled={saving}
                  class="px-2 py-1 text-[10px] font-medium rounded bg-gold-600 text-white
                         hover:bg-gold-700 disabled:opacity-50 transition-colors">
                  Save
                </button>
                <button onclick={cancelTrustEdit}
                  class="px-2 py-1 text-[10px] font-medium rounded text-shadow-500 dark:text-bark-400
                         hover:bg-bark-100 dark:hover:bg-shadow-700 transition-colors">
                  Cancel
                </button>
              </div>
            {:else}
              <button onclick={() => startTrustEdit(contact)} class="group shrink-0" title="Click to change trust level">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium border
                  {badge.bg} {badge.text} {badge.border}
                  group-hover:ring-1 group-hover:ring-gold-300 transition-all">
                  {badge.label}
                </span>
              </button>
            {/if}
          </div>

          <!-- Relationship + Activity -->
          <div class="text-xs space-y-1">
            <p class="text-shadow-500 dark:text-bark-400">
              <span class="capitalize text-shadow-800 dark:text-bark-300">{contact.relationshipType.replace('_', ' ')}</span>
            </p>
            <div class="flex items-center gap-4 text-shadow-400 dark:text-bark-500">
              <span>First: {formatDate(contact.firstSeen)}</span>
              <span>Last: {formatDate(contact.lastSeen)}</span>
            </div>
          </div>

          <!-- Notes (inline editable) -->
          <div class="border-t border-bark-100 dark:border-shadow-800 pt-2">
            {#if editingNotesId === contact.id}
              <div class="space-y-2">
                <textarea bind:value={editNotesValue} rows={3}
                  class="w-full px-3 py-2 rounded-lg border border-gold-300 dark:border-gold-700
                         bg-white dark:bg-shadow-800 text-shadow-800 dark:text-bark-200 text-xs resize-y
                         focus:outline-none focus:ring-2 focus:ring-gold-300"
                  placeholder="Notes about this contact..."
                ></textarea>
                <div class="flex gap-1.5">
                  <button onclick={() => saveNotes(contact.id)} disabled={saving}
                    class="px-2.5 py-1 text-[10px] font-medium rounded bg-gold-600 text-white
                           hover:bg-gold-700 disabled:opacity-50 transition-colors">
                    Save
                  </button>
                  <button onclick={cancelNotesEdit}
                    class="px-2.5 py-1 text-[10px] font-medium rounded text-shadow-500 dark:text-bark-400
                           hover:bg-bark-100 dark:hover:bg-shadow-700 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            {:else}
              <button onclick={() => startNotesEdit(contact)}
                class="w-full text-left group">
                {#if contact.notes}
                  <p class="text-xs text-shadow-500 dark:text-bark-400 italic leading-relaxed
                            group-hover:text-shadow-800 dark:group-hover:text-bark-200 transition-colors">
                    {contact.notes}
                  </p>
                {:else}
                  <p class="text-[11px] text-shadow-400 dark:text-bark-500 italic
                            group-hover:text-gold-600 dark:group-hover:text-gold-400 transition-colors">
                    Add notes...
                  </p>
                {/if}
              </button>
            {/if}
          </div>

          <!-- Profile + Memory count -->
          {#if profile}
            <div class="border-t border-bark-100 dark:border-shadow-800 pt-2">
              {#if profile.summary}
                <p class="text-xs text-shadow-500 dark:text-bark-400 leading-relaxed mb-1.5">{profile.summary}</p>
              {/if}
              <div class="flex items-center gap-3 text-[10px] text-shadow-400 dark:text-bark-500">
                <span class="inline-flex items-center gap-1">
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-gold-400"></span>
                  {profile.memoryCount} memories
                </span>
                {#if profile.updatedAt}
                  <span>Updated {formatTimestamp(profile.updatedAt)}</span>
                {/if}
              </div>
              {#if profile.sourceMemoryIds && profile.sourceMemoryIds.length > 0}
                <details class="mt-1.5">
                  <summary class="text-[10px] text-shadow-400 dark:text-bark-500 cursor-pointer
                                  hover:text-gold-600 dark:hover:text-gold-400 transition-colors">
                    {profile.sourceMemoryIds.length} source memor{profile.sourceMemoryIds.length === 1 ? 'y' : 'ies'}
                  </summary>
                  <div class="mt-1 flex flex-wrap gap-1">
                    {#each profile.sourceMemoryIds as memId}
                      <code class="text-[9px] bg-bark-100 dark:bg-shadow-800 px-1.5 py-0.5 rounded
                                   text-shadow-500 dark:text-bark-400 break-all">{memId}</code>
                    {/each}
                  </div>
                </details>
              {/if}
            </div>
          {:else}
            <div class="border-t border-bark-100 dark:border-shadow-800 pt-2">
              <span class="text-[10px] text-shadow-400 dark:text-bark-500 italic">No synthesized profile</span>
            </div>
          {/if}

          <!-- Related Channels -->
          {#if channels.length > 0}
            <div class="border-t border-bark-100 dark:border-shadow-800 pt-2">
              <p class="text-[10px] font-medium text-shadow-400 dark:text-bark-500 mb-1.5 uppercase tracking-wider">Channels</p>
              <div class="flex flex-wrap gap-1.5">
                {#each channels as ch}
                  <span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono
                               bg-bark-100 dark:bg-shadow-800 text-shadow-500 dark:text-bark-400">
                    {ch.channel}:{ch.userId}
                  </span>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="col-span-full card-garden p-10 text-center">
          <p class="text-shadow-400 dark:text-bark-500 italic text-sm">No visitors have been seen in the garden yet</p>
        </div>
      {/each}
    </div>
  {/if}
</div>
