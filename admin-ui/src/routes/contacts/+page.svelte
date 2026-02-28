<script lang="ts">
  import { onMount } from 'svelte';
  import {
    listContacts,
    updateContact,
    createContact,
    deleteContact,
    mergeContacts,
    unlinkChannelIdentity,
  } from '$lib/api/endpoints/contacts';
  import type { ContactUpdatePayload, ContactCreatePayload } from '$lib/api/endpoints/contacts';
  import type {
    Contact,
    AdminContactListData,
    ContactIdentityLinkVerification,
    ContactMutationAuditEntry,
    ContactConversationChannelView,
    ContactProfileArtifact,
    RelationshipType,
    TrustLevel,
    ChannelPrivacyLevel,
  } from '$lib/types';
  import { RELATIONSHIP_TYPES, CHANNEL_PRIVACY_LEVELS } from '$lib/types';

  let data = $state<AdminContactListData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let saveMessage = $state('');
  let saveOk = $state(true);

  // Expanded edit panel
  let editingContactId = $state<string | null>(null);
  let editDisplayName = $state('');
  let editNickname = $state('');
  let editTrustLevel = $state<TrustLevel>('regular');
  let editRelationshipType = $state<RelationshipType>('acquaintance');
  let editNotes = $state('');

  // Channel privacy edits (tracked per channel:userId key)
  let channelPrivacyEdits = $state<Record<string, ChannelPrivacyLevel>>({});

  // Add channel form
  let showAddChannel = $state(false);
  let newChannelName = $state('');
  let newChannelUserId = $state('');
  let newChannelPrivacy = $state<ChannelPrivacyLevel>('private');

  // Collapsible panels
  let showVerifications = $state(false);
  let showAuditTrail = $state(false);

  // Create contact form
  let showCreateForm = $state(false);
  let createDisplayName = $state('');
  let createTrustLevel = $state<TrustLevel>('regular');
  let createRelationshipType = $state<RelationshipType>('acquaintance');
  let createNotes = $state('');

  // Merge contact
  let mergeSourceId = $state('');

  const TRUST_LEVELS: TrustLevel[] = ['primary', 'trusted', 'regular', 'public'];

  const KNOWN_CHANNEL_TYPES = [
    'discord',
    'telegram',
    'api',
    'admin-chat',
    'twitter',
    'rss',
    'sillytavern',
  ];

  const TRUST_BADGE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
    primary:  { bg: 'background-color: #e8b931', text: 'color: #3a2e0a', label: '👑 Primary' },
    trusted:  { bg: 'background-color: #c0c0c0', text: 'color: #2b2b2b', label: '🗝 Trusted' },
    regular:  { bg: 'background-color: #4caf50', text: 'color: white', label: '🍃 Regular' },
    public:   { bg: 'background-color: #9e9e9e', text: 'color: white', label: '🪨 Public' },
  };

  const PRIVACY_BADGE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
    private:      { bg: 'background-color: #4A7C59', text: 'color: white', label: 'Private' },
    semi_private: { bg: 'background-color: #8B7355', text: 'color: white', label: 'Semi-Private' },
    public:       { bg: 'background-color: #4A5C8B', text: 'color: white', label: 'Public' },
    broadcast:    { bg: 'background-color: #C44569', text: 'color: white', label: 'Broadcast' },
  };

  const VERIFICATION_STATUS: Record<string, { cls: string; label: string }> = {
    pending:  { cls: 'bg-bark-200 text-shadow-800', label: 'Pending' },
    verified: { cls: 'bg-moss-100 text-moss-700', label: 'Verified' },
    failed:   { cls: 'bg-wilt-100 text-wilt-600', label: 'Failed' },
    expired:  { cls: 'bg-shadow-100 text-shadow-600', label: 'Expired' },
  };

  // Helpers

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

  function trustBadge(trust: string) {
    return TRUST_BADGE_STYLES[trust] ?? TRUST_BADGE_STYLES.public;
  }

  function privacyBadge(level: string) {
    return PRIVACY_BADGE_STYLES[level] ?? PRIVACY_BADGE_STYLES.public;
  }

  function formatRelType(rt: string): string {
    return rt.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function channelKey(ch: ContactConversationChannelView): string {
    return `${ch.channel}:${ch.userId}`;
  }

  // Edit panel

  function contactChannelKey(ch: { channel: string; userId: string }): string {
    return `${ch.channel}:${ch.userId}`;
  }

  function startEdit(contact: Contact) {
    editingContactId = contact.id;
    editDisplayName = contact.displayName;
    editNickname = contact.nickname ?? '';
    editTrustLevel = contact.trustLevel as TrustLevel;
    editRelationshipType = contact.relationshipType as RelationshipType;
    editNotes = contact.notes ?? '';
    showAddChannel = false;
    newChannelName = '';
    newChannelUserId = '';
    newChannelPrivacy = 'private';
    // Initialize channel privacy edits from contact.channels
    channelPrivacyEdits = {};
    if (contact.channels) {
      for (const ch of contact.channels) {
        channelPrivacyEdits[contactChannelKey(ch)] = ch.privacyLevel as ChannelPrivacyLevel;
      }
    } else {
      // Fallback to relatedChannelMap
      const channels = getChannels(contact.id);
      for (const ch of channels) {
        channelPrivacyEdits[channelKey(ch)] = ch.privacyLevel as ChannelPrivacyLevel;
      }
    }
  }

  function cancelEdit() {
    editingContactId = null;
    channelPrivacyEdits = {};
  }

  async function saveEdit(contactId: string) {
    saving = true;
    try {
      const patch: ContactUpdatePayload = {};
      const contact = data?.contacts.find(c => c.id === contactId);
      if (!contact) throw new Error('Contact not found');

      if (editDisplayName.trim() !== contact.displayName) {
        patch.displayName = editDisplayName.trim();
      }
      if (editNickname.trim() !== (contact.nickname ?? '')) {
        patch.nickname = editNickname.trim();
      }
      if (editTrustLevel !== contact.trustLevel) {
        patch.trustLevel = editTrustLevel;
      }
      if (editRelationshipType !== contact.relationshipType) {
        patch.relationshipType = editRelationshipType;
      }
      if (editNotes !== (contact.notes ?? '')) {
        patch.notes = editNotes;
      }

      // Collect channel privacy changes from contact.channels or relatedChannelMap
      const privacyChanges: Array<{ channel: string; userId: string; privacyLevel: ChannelPrivacyLevel }> = [];
      if (contact.channels && contact.channels.length > 0) {
        for (const ch of contact.channels) {
          const key = contactChannelKey(ch);
          const newPrivacy = channelPrivacyEdits[key];
          if (newPrivacy && newPrivacy !== ch.privacyLevel) {
            privacyChanges.push({ channel: ch.channel, userId: ch.userId, privacyLevel: newPrivacy });
          }
        }
      } else {
        const channels = getChannels(contactId);
        for (const ch of channels) {
          const key = channelKey(ch);
          const newPrivacy = channelPrivacyEdits[key];
          if (newPrivacy && newPrivacy !== ch.privacyLevel) {
            privacyChanges.push({ channel: ch.channel, userId: ch.userId, privacyLevel: newPrivacy });
          }
        }
      }
      if (privacyChanges.length > 0) {
        patch.channelPrivacy = privacyChanges;
      }

      // Add new channel link if filled in
      if (showAddChannel && newChannelName.trim() && newChannelUserId.trim()) {
        patch.addChannel = {
          channel: newChannelName.trim(),
          userId: newChannelUserId.trim(),
          privacyLevel: newChannelPrivacy,
        };
      }

      if (Object.keys(patch).length === 0) {
        flash(true, 'No changes to save');
        editingContactId = null;
        channelPrivacyEdits = {};
        return;
      }

      const result = await updateContact(contactId, patch);
      if (result.ok) {
        data = await listContacts();
        editingContactId = null;
        channelPrivacyEdits = {};
        flash(true, result.message || 'Contact updated');
      } else {
        flash(false, result.message || 'Update failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to update contact');
    } finally {
      saving = false;
    }
  }

  // Quick trust change (from badge click without full edit)
  let quickTrustId = $state<string | null>(null);
  let quickTrustValue = $state<TrustLevel>('regular');

  function startQuickTrust(contact: Contact) {
    if (editingContactId === contact.id) return; // use full edit instead
    quickTrustId = contact.id;
    quickTrustValue = contact.trustLevel as TrustLevel;
  }

  function cancelQuickTrust() {
    quickTrustId = null;
  }

  async function saveQuickTrust(contactId: string) {
    saving = true;
    try {
      const result = await updateContact(contactId, { trustLevel: quickTrustValue });
      if (result.ok) {
        data = await listContacts();
        quickTrustId = null;
        flash(true, 'Trust level updated');
      } else {
        flash(false, result.message || 'Update failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to update trust');
    } finally {
      saving = false;
    }
  }

  // CRUD handlers

  async function handleCreate() {
    if (!createDisplayName.trim()) return;
    saving = true;
    try {
      const payload: ContactCreatePayload = {
        displayName: createDisplayName.trim(),
        trustLevel: createTrustLevel,
        relationshipType: createRelationshipType,
      };
      if (createNotes.trim()) payload.notes = createNotes.trim();
      const result = await createContact(payload);
      if (result.ok) {
        data = await listContacts();
        showCreateForm = false;
        createDisplayName = '';
        createTrustLevel = 'regular';
        createRelationshipType = 'acquaintance';
        createNotes = '';
        flash(true, result.message || 'Contact created');
      } else {
        flash(false, result.message || 'Create failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to create contact');
    } finally {
      saving = false;
    }
  }

  async function handleDelete(contactId: string) {
    if (!confirm('Delete this contact? L2 memories will be orphaned (kept but unlinked). This cannot be undone.')) return;
    saving = true;
    try {
      const result = await deleteContact(contactId);
      if (result.ok) {
        data = await listContacts();
        editingContactId = null;
        flash(true, result.message || 'Contact deleted');
      } else {
        flash(false, result.message || 'Delete failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to delete contact');
    } finally {
      saving = false;
    }
  }

  async function handleMerge(targetId: string) {
    const sourceId = mergeSourceId.trim();
    if (!sourceId) {
      flash(false, 'Enter a source contact ID to merge');
      return;
    }
    if (!confirm(`Merge source ${sourceId} into this contact? The source contact will be deleted and all its data transferred here.`)) return;
    saving = true;
    try {
      const result = await mergeContacts(targetId, sourceId);
      if (result.ok) {
        data = await listContacts();
        mergeSourceId = '';
        flash(true, result.message || 'Contacts merged');
      } else {
        flash(false, result.message || 'Merge failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to merge contacts');
    } finally {
      saving = false;
    }
  }

  async function handleUnlink(contactId: string, channel: string, userId: string) {
    if (!confirm(`Unlink ${channel}:${userId} from this contact?`)) return;
    saving = true;
    try {
      const result = await unlinkChannelIdentity(contactId, channel, userId);
      if (result.ok) {
        data = await listContacts();
        // Re-open edit with refreshed data
        const refreshed = data?.contacts.find(c => c.id === contactId);
        if (refreshed && editingContactId === contactId) startEdit(refreshed);
        flash(true, result.message || 'Channel identity unlinked');
      } else {
        flash(false, result.message || 'Unlink failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to unlink channel identity');
    } finally {
      saving = false;
    }
  }

  // Init
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
  <!-- Header -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-900">The Visitors</h1>
    <p class="text-sm text-shadow-600 mt-1">Contacts and trust management</p>
  </div>

  <!-- Flash message -->
  {#if saveMessage}
    <div class="px-4 py-2.5 rounded-lg text-sm font-medium
      {saveOk
        ? 'bg-moss-50 text-moss-700 border border-moss-200'
        : 'bg-wilt-50 text-wilt-600 border border-wilt-200'}">
      {saveMessage}
    </div>
  {/if}

  <!-- Error -->
  {#if error}
    <div class="card-garden p-5 text-center text-wilt-600 text-sm">{error}</div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each Array(6) as _}
        <div class="card-garden p-5 animate-pulse space-y-3">
          <div class="h-5 bg-bark-200 rounded w-32"></div>
          <div class="h-3 bg-bark-200 rounded w-20"></div>
          <div class="h-3 bg-bark-200 rounded w-full"></div>
        </div>
      {/each}
    </div>

  {:else if data}
    <!-- Identity Link Verifications (collapsible) -->
    {#if data.verifications.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          class="w-full flex items-center justify-between px-5 py-3.5 text-left
                 hover:bg-bark-50 transition-colors"
          onclick={() => showVerifications = !showVerifications}
        >
          <div>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Identity Link Verifications</h2>
            <p class="text-sm text-shadow-600 mt-0.5">
              {data.verifications.length} cross-channel verification{data.verifications.length !== 1 ? 's' : ''}
            </p>
          </div>
          <span class="text-shadow-600 text-sm transition-transform {showVerifications ? 'rotate-180' : ''}">
            &#9660;
          </span>
        </button>
        {#if showVerifications}
          <div class="border-t border-bark-300 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-bark-100">
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Status</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Source</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Target</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Contact</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Nonce</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Expiry</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-bark-200">
                {#each data.verifications.slice(0, 10) as v (v.id)}
                  {@const vs = VERIFICATION_STATUS[v.status] ?? VERIFICATION_STATUS.expired}
                  <tr class="hover:bg-bark-50">
                    <td class="px-4 py-2.5">
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium {vs.cls}">
                        {vs.label}
                      </span>
                    </td>
                    <td class="px-4 py-2.5 font-mono text-sm text-shadow-800">{v.sourceChannel}:{v.sourceUserId}</td>
                    <td class="px-4 py-2.5 font-mono text-sm text-shadow-800">{v.targetChannel}:{v.targetUserId}</td>
                    <td class="px-4 py-2.5 text-sm text-shadow-700">{contactNameForId(v.contactId)}</td>
                    <td class="px-4 py-2.5 font-mono text-sm text-shadow-600">{v.nonce ?? '-'}</td>
                    <td class="px-4 py-2.5 text-sm text-shadow-700">{v.expiresAt ? formatDateTime(v.expiresAt) : '-'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Mutation Audit Trail (collapsible) -->
    {#if data.mutationAudits.length > 0}
      <div class="card-garden overflow-hidden">
        <button
          class="w-full flex items-center justify-between px-5 py-3.5 text-left
                 hover:bg-bark-50 transition-colors"
          onclick={() => showAuditTrail = !showAuditTrail}
        >
          <div>
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Trust & Note Mutation Audit</h2>
            <p class="text-sm text-shadow-600 mt-0.5">
              {data.mutationAudits.length} mutation{data.mutationAudits.length !== 1 ? 's' : ''} recorded
            </p>
          </div>
          <span class="text-shadow-600 text-sm transition-transform {showAuditTrail ? 'rotate-180' : ''}">
            &#9660;
          </span>
        </button>
        {#if showAuditTrail}
          <div class="border-t border-bark-300 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="bg-bark-100">
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Contact</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Field</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Actor</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Old Value</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">New Value</th>
                  <th class="text-left px-4 py-2.5 text-sm font-medium text-shadow-700 uppercase tracking-wider">Timestamp</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-bark-200">
                {#each data.mutationAudits as audit (audit.id)}
                  <tr class="hover:bg-bark-50">
                    <td class="px-4 py-2.5 text-sm text-shadow-800">{contactNameForId(audit.contactId)}</td>
                    <td class="px-4 py-2.5 text-sm text-shadow-700 capitalize">
                      {audit.field === 'trust_level' ? 'trust' : audit.field}
                    </td>
                    <td class="px-4 py-2.5 font-mono text-sm text-shadow-700">{audit.actor}</td>
                    <td class="px-4 py-2.5">
                      {#if audit.oldValue}
                        <code class="text-sm bg-bark-200 px-1.5 py-0.5 rounded text-shadow-800">{audit.oldValue}</code>
                      {:else}
                        <span class="text-sm text-shadow-600 italic">empty</span>
                      {/if}
                    </td>
                    <td class="px-4 py-2.5">
                      {#if audit.newValue}
                        <code class="text-sm bg-bark-200 px-1.5 py-0.5 rounded text-shadow-800">{audit.newValue}</code>
                      {:else}
                        <span class="text-sm text-shadow-600 italic">empty</span>
                      {/if}
                    </td>
                    <td class="px-4 py-2.5 text-sm text-shadow-700">{formatDateTime(audit.timestamp)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Create Contact -->
    <div>
      <button onclick={() => showCreateForm = !showCreateForm}
        class="px-4 py-2 text-sm font-medium rounded-lg bg-gold-600 text-white
               hover:bg-gold-700 transition-colors">
        {showCreateForm ? 'Hide Create Form' : '+ New Contact'}
      </button>
      {#if showCreateForm}
        <div class="card-garden p-5 mt-3 space-y-3">
          <h4 class="text-sm font-serif font-semibold text-shadow-800">Create Contact</h4>
          <div>
            <label for="create-name" class="block text-sm font-medium text-shadow-800 mb-1">Display Name</label>
            <input id="create-name" type="text" bind:value={createDisplayName}
              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm
                     focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
              placeholder="Required" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="create-trust" class="block text-sm font-medium text-shadow-800 mb-1">Trust Level</label>
              <select id="create-trust" bind:value={createTrustLevel}
                class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm
                       focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                {#each TRUST_LEVELS.filter(l => l !== 'primary') as level}
                  <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
                {/each}
              </select>
            </div>
            <div>
              <label for="create-rel" class="block text-sm font-medium text-shadow-800 mb-1">Relationship</label>
              <select id="create-rel" bind:value={createRelationshipType}
                class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm
                       focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                {#each RELATIONSHIP_TYPES as rt}
                  <option value={rt}>{formatRelType(rt)}</option>
                {/each}
              </select>
            </div>
          </div>
          <div>
            <label for="create-notes" class="block text-sm font-medium text-shadow-800 mb-1">Notes</label>
            <textarea id="create-notes" bind:value={createNotes} rows={2}
              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm resize-y
                     focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
              placeholder="Optional notes..."
            ></textarea>
          </div>
          <div class="flex gap-2">
            <button onclick={handleCreate} disabled={saving || !createDisplayName.trim()}
              class="px-4 py-2 text-sm font-medium rounded-lg bg-gold-600 text-white
                     hover:bg-gold-700 disabled:opacity-50 transition-colors">
              {saving ? 'Creating...' : 'Create'}
            </button>
            <button onclick={() => showCreateForm = false}
              class="px-4 py-2 text-sm font-medium rounded-lg text-shadow-700
                     hover:bg-bark-200 transition-colors border border-bark-300">
              Cancel
            </button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Contact Cards Grid -->
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {#each data.contacts as contact (contact.id)}
        {@const channels = getChannels(contact.id)}
        {@const profile = getProfile(contact.id)}
        {@const badge = trustBadge(contact.trustLevel)}

        <div class="card-garden p-5 flex flex-col gap-3 {editingContactId === contact.id ? 'ring-2 ring-gold-400' : ''}">
          <!-- Header: Name + Trust Badge -->
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="text-base font-serif font-semibold text-shadow-900 truncate">
                {contactDisplayName(contact)}
              </h3>
              {#if contact.nickname && contact.nickname.toLowerCase() !== contact.displayName.toLowerCase()}
                <p class="text-sm text-shadow-600 truncate">aka {contact.nickname}</p>
              {/if}
              <code class="font-mono text-xs text-shadow-500 select-all">{contact.id}</code>
            </div>

            <!-- Trust badge (clickable to quick-edit) -->
            {#if quickTrustId === contact.id && editingContactId !== contact.id}
              <div class="flex items-center gap-1.5 shrink-0">
                <select bind:value={quickTrustValue}
                  class="text-sm px-2 py-1 rounded-lg border border-gold-300
                         bg-white text-shadow-800
                         focus:outline-none focus:ring-2 focus:ring-gold-300">
                  {#each TRUST_LEVELS as level}
                    <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
                  {/each}
                </select>
                <button onclick={() => saveQuickTrust(contact.id)} disabled={saving}
                  class="px-2 py-1 text-sm font-medium rounded bg-gold-600 text-white
                         hover:bg-gold-700 disabled:opacity-50 transition-colors">
                  Save
                </button>
                <button onclick={cancelQuickTrust}
                  class="px-2 py-1 text-sm font-medium rounded text-shadow-700
                         hover:bg-bark-200 transition-colors">
                  Cancel
                </button>
              </div>
            {:else}
              <button onclick={() => startQuickTrust(contact)} class="group shrink-0" title="Click to change trust level">
                <span class="inline-flex items-center px-2.5 py-1 rounded-full text-sm font-semibold
                  group-hover:ring-2 group-hover:ring-gold-300 transition-all"
                  style="{badge.bg}; {badge.text}">
                  {badge.label}
                </span>
              </button>
            {/if}
          </div>

          <!-- Relationship + Activity -->
          <div class="text-sm space-y-1">
            <p class="text-shadow-700">
              <span class="font-medium text-shadow-800">{formatRelType(contact.relationshipType)}</span>
            </p>
            <div class="flex items-center gap-4 text-shadow-600">
              <span>First: {formatDate(contact.firstSeen)}</span>
              <span>Last: {formatDate(contact.lastSeen)}</span>
            </div>
          </div>

          <!-- Notes (click to open full edit) -->
          <div class="border-t border-bark-200 pt-2">
            {#if contact.notes}
              <p class="text-sm text-shadow-700 italic leading-relaxed">{contact.notes}</p>
            {:else}
              <p class="text-sm text-shadow-600 italic">No notes</p>
            {/if}
          </div>

          <!-- Channel Identity Links -->
          <div class="border-t border-bark-200 pt-2">
            <p class="text-sm font-medium text-shadow-700 mb-1.5 uppercase tracking-wider">Channel Identities</p>
            {#if contact.channels && contact.channels.length > 0}
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-bark-300">
                      <th class="text-left py-1.5 pr-2 text-shadow-700 font-medium text-sm">Channel</th>
                      <th class="text-left py-1.5 pr-2 text-shadow-700 font-medium text-sm">User ID</th>
                      <th class="text-left py-1.5 pr-2 text-shadow-700 font-medium text-sm">Privacy</th>
                      <th class="text-left py-1.5 text-shadow-700 font-medium text-sm">Seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each contact.channels as ch}
                      {@const pb = privacyBadge(ch.privacyLevel)}
                      <tr class="border-b border-bark-100">
                        <td class="py-1.5 pr-2 text-shadow-800 font-medium">{ch.channel}</td>
                        <td class="py-1.5 pr-2 font-mono text-shadow-800 text-sm break-all">{ch.userId}</td>
                        <td class="py-1.5 pr-2">
                          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium"
                            style="{pb.bg}; {pb.text}">
                            {pb.label}
                          </span>
                        </td>
                        <td class="py-1.5 text-shadow-600 text-sm">
                          {#if ch.firstSeen || ch.lastSeen}
                            {#if ch.firstSeen}
                              <span title="First seen">{formatDate(ch.firstSeen)}</span>
                            {/if}
                            {#if ch.firstSeen && ch.lastSeen}
                              <span class="text-shadow-400 mx-0.5">-</span>
                            {/if}
                            {#if ch.lastSeen}
                              <span title="Last seen">{formatDate(ch.lastSeen)}</span>
                            {/if}
                          {:else}
                            <span class="text-shadow-400 italic">-</span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else if contact.channelIdentities && contact.channelIdentities.length > 0}
              <!-- Fallback: show channelIdentities without privacy/dates -->
              <div class="space-y-1">
                {#each contact.channelIdentities as ci}
                  <div class="flex items-center gap-2">
                    <span class="text-sm text-shadow-800 font-medium">{ci.channel}</span>
                    <span class="font-mono text-sm text-shadow-700 break-all">{ci.userId}</span>
                  </div>
                {/each}
              </div>
            {:else if channels.length > 0}
              <!-- Fallback: show related conversation channels -->
              <div class="space-y-1">
                {#each channels as ch}
                  <div class="flex items-center gap-2">
                    <span class="text-sm text-shadow-800 font-medium">{ch.channel}</span>
                    <span class="font-mono text-sm text-shadow-700 break-all">{ch.userId}</span>
                    {#if ch.privacyLevel}
                      {@const pb = privacyBadge(ch.privacyLevel)}
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium"
                        style="{pb.bg}; {pb.text}">
                        {pb.label}
                      </span>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <p class="text-sm text-shadow-500 italic">No channel identities linked</p>
            {/if}
          </div>

          <!-- Profile + Memory count -->
          {#if profile}
            <div class="border-t border-bark-200 pt-2">
              {#if profile.summary}
                <p class="text-sm text-shadow-600 italic mb-1">AI-synthesized profile</p>
                <p class="text-sm text-shadow-700 leading-relaxed mb-1.5">{profile.summary}</p>
              {/if}
              <div class="flex items-center gap-3 text-sm text-shadow-600">
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
                  <summary class="text-sm text-shadow-600 cursor-pointer
                                  hover:text-gold-600 transition-colors">
                    {profile.sourceMemoryIds.length} source memor{profile.sourceMemoryIds.length === 1 ? 'y' : 'ies'}
                  </summary>
                  <div class="mt-1 flex flex-wrap gap-1">
                    {#each profile.sourceMemoryIds as memId}
                      <a
                        href="/garden/memory?id={encodeURIComponent(memId)}"
                        class="text-sm bg-bark-200 px-1.5 py-0.5 rounded text-gold-700
                               hover:bg-gold-100 hover:text-gold-800 transition-colors font-mono break-all"
                        title="View memory {memId}"
                      >{memId}</a>
                    {/each}
                  </div>
                </details>
              {/if}
            </div>
          {:else}
            <div class="border-t border-bark-200 pt-2">
              <span class="text-sm text-shadow-600 italic">No synthesized profile</span>
            </div>
          {/if}

          <!-- Edit / Expand button -->
          <div class="border-t border-bark-200 pt-2 flex">
            {#if editingContactId === contact.id}
              <button onclick={cancelEdit}
                class="text-sm font-medium text-shadow-700 hover:text-gold-600 transition-colors">
                Close Editor
              </button>
            {:else}
              <button onclick={() => startEdit(contact)}
                class="text-sm font-medium text-gold-700 hover:text-gold-600 transition-colors">
                Edit Contact
              </button>
            {/if}
          </div>

          <!-- Inline Edit Form (expanded) -->
          {#if editingContactId === contact.id}
            <div class="border-t border-gold-300 pt-4 space-y-4 bg-gold-50/30 -mx-5 -mb-5 px-5 pb-5 rounded-b-xl">
              <h4 class="text-sm font-serif font-semibold text-shadow-800">Edit Contact</h4>

              <!-- Display Name -->
              <div>
                <label for="edit-name-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Display Name</label>
                <input id="edit-name-{contact.id}" type="text" bind:value={editDisplayName}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                  placeholder="Display name (required)" />
              </div>

              <!-- Nickname -->
              <div>
                <label for="edit-nick-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Nickname</label>
                <input id="edit-nick-{contact.id}" type="text" bind:value={editNickname}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                  placeholder="Optional nickname" />
              </div>

              <!-- Trust Level -->
              <div>
                <label for="edit-trust-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Trust Level</label>
                <select id="edit-trust-{contact.id}" bind:value={editTrustLevel}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                  {#each TRUST_LEVELS as level}
                    <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
                  {/each}
                </select>
              </div>

              <!-- Relationship Type -->
              <div>
                <label for="edit-rel-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Relationship Type</label>
                <select id="edit-rel-{contact.id}" bind:value={editRelationshipType}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                  {#each RELATIONSHIP_TYPES as rt}
                    <option value={rt}>{formatRelType(rt)}</option>
                  {/each}
                </select>
              </div>

              <!-- Notes -->
              <div>
                <label for="edit-notes-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Notes</label>
                <textarea id="edit-notes-{contact.id}" bind:value={editNotes} rows={3}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm resize-y
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                  placeholder="Notes about this contact..."
                ></textarea>
              </div>

              <!-- Channel Privacy Editing -->
              {#if contact.channels && contact.channels.length > 0}
                <div>
                  <p class="text-sm font-medium text-shadow-800 mb-2">Channel Privacy Levels</p>
                  <div class="space-y-2">
                    {#each contact.channels as ch}
                      {@const key = contactChannelKey(ch)}
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-mono text-sm text-shadow-800 min-w-0 truncate">{ch.channel}:{ch.userId}</span>
                        <select
                          value={channelPrivacyEdits[key] ?? ch.privacyLevel}
                          onchange={(e) => {
                            channelPrivacyEdits[key] = (e.target as HTMLSelectElement).value as ChannelPrivacyLevel;
                          }}
                          class="text-sm px-2 py-1 rounded-lg border border-bark-300 bg-white text-shadow-800
                                 focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                          {#each CHANNEL_PRIVACY_LEVELS as pl}
                            <option value={pl}>{pl.replace('_', ' ')}</option>
                          {/each}
                        </select>
                        <button onclick={() => handleUnlink(contact.id, ch.channel, ch.userId)}
                          disabled={saving}
                          class="text-xs px-2 py-0.5 rounded border border-wilt-300 text-wilt-600
                                 hover:bg-wilt-50 disabled:opacity-50 transition-colors"
                          title="Unlink this channel identity">
                          Unlink
                        </button>
                      </div>
                    {/each}
                  </div>
                </div>
              {:else if channels.length > 0}
                <div>
                  <p class="text-sm font-medium text-shadow-800 mb-2">Channel Privacy Levels</p>
                  <div class="space-y-2">
                    {#each channels as ch}
                      {@const key = channelKey(ch)}
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-mono text-sm text-shadow-800 min-w-0 truncate">{ch.channel}:{ch.userId}</span>
                        <select
                          value={channelPrivacyEdits[key] ?? ch.privacyLevel}
                          onchange={(e) => {
                            channelPrivacyEdits[key] = (e.target as HTMLSelectElement).value as ChannelPrivacyLevel;
                          }}
                          class="text-sm px-2 py-1 rounded-lg border border-bark-300 bg-white text-shadow-800
                                 focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                          {#each CHANNEL_PRIVACY_LEVELS as pl}
                            <option value={pl}>{pl.replace('_', ' ')}</option>
                          {/each}
                        </select>
                        <button onclick={() => handleUnlink(contact.id, ch.channel, ch.userId)}
                          disabled={saving}
                          class="text-xs px-2 py-0.5 rounded border border-wilt-300 text-wilt-600
                                 hover:bg-wilt-50 disabled:opacity-50 transition-colors"
                          title="Unlink this channel identity">
                          Unlink
                        </button>
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}

              <!-- Add Channel Link section -->
              <div>
                <button onclick={() => showAddChannel = !showAddChannel}
                  class="text-sm font-medium text-gold-700 hover:text-gold-600 transition-colors">
                  {showAddChannel ? 'Hide Add Channel' : '+ Add Channel Link'}
                </button>
                {#if showAddChannel}
                  <div class="mt-2 p-3 border border-bark-300 rounded-lg bg-bark-50 space-y-2">
                    <div class="grid grid-cols-3 gap-2">
                      <div>
                        <label for="new-ch-name" class="text-sm text-shadow-700">Channel</label>
                        <select id="new-ch-name"
                          value={newChannelName}
                          onchange={(e) => {
                            const val = (e.target as HTMLSelectElement).value;
                            newChannelName = val === '__custom__' ? '' : val;
                          }}
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-900
                                 focus:outline-none focus:ring-1 focus:ring-gold-300">
                          <option value="">Select...</option>
                          {#each KNOWN_CHANNEL_TYPES as ct}
                            <option value={ct}>{ct}</option>
                          {/each}
                          <option value="__custom__">Other (custom)</option>
                        </select>
                        {#if newChannelName === '' || !KNOWN_CHANNEL_TYPES.includes(newChannelName)}
                          <input type="text" bind:value={newChannelName} placeholder="custom channel"
                            class="w-full px-2 py-1 mt-1 text-sm rounded border border-bark-300 bg-white text-shadow-900
                                   focus:outline-none focus:ring-1 focus:ring-gold-300" />
                        {/if}
                      </div>
                      <div>
                        <label for="new-ch-userid" class="text-sm text-shadow-700">User ID</label>
                        <input id="new-ch-userid" type="text" bind:value={newChannelUserId} placeholder="123456789"
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-900
                                 focus:outline-none focus:ring-1 focus:ring-gold-300" />
                      </div>
                      <div>
                        <label for="new-ch-privacy" class="text-sm text-shadow-700">Privacy</label>
                        <select id="new-ch-privacy" bind:value={newChannelPrivacy}
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-900
                                 focus:outline-none focus:ring-1 focus:ring-gold-300">
                          {#each CHANNEL_PRIVACY_LEVELS as pl}
                            <option value={pl}>{pl.replace('_', ' ')}</option>
                          {/each}
                        </select>
                      </div>
                    </div>
                    <p class="text-sm text-shadow-600">New channel link will be saved when you click Save Changes below.</p>
                  </div>
                {/if}
              </div>

              <!-- Merge Contacts -->
              <div>
                <details class="group">
                  <summary class="text-sm font-medium text-gold-700 hover:text-gold-600 transition-colors cursor-pointer">
                    Merge Another Contact Into This One
                  </summary>
                  <div class="mt-2 p-3 border border-bark-300 rounded-lg bg-bark-50 space-y-2">
                    <p class="text-sm text-shadow-600">
                      The source contact will be deleted. All its channel links, memories, and activity will transfer here.
                    </p>
                    <div>
                      <label for="merge-source-{contact.id}" class="text-sm text-shadow-700">Source Contact ID</label>
                      <input id="merge-source-{contact.id}" type="text" bind:value={mergeSourceId}
                        class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-900
                               focus:outline-none focus:ring-1 focus:ring-gold-300 font-mono"
                        placeholder="UUID of contact to absorb" />
                    </div>
                    {#if data?.contacts}
                      <div>
                        <label for="merge-source-select-{contact.id}" class="text-sm text-shadow-700">Or pick from list</label>
                        <select id="merge-source-select-{contact.id}"
                          value={mergeSourceId}
                          onchange={(e) => mergeSourceId = (e.target as HTMLSelectElement).value}
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-white text-shadow-900
                                 focus:outline-none focus:ring-1 focus:ring-gold-300">
                          <option value="">Select...</option>
                          {#each data.contacts.filter(c => c.id !== contact.id) as other}
                            <option value={other.id}>{contactDisplayName(other)} ({other.id.slice(0, 8)}...)</option>
                          {/each}
                        </select>
                      </div>
                    {/if}
                    <button onclick={() => handleMerge(contact.id)}
                      disabled={saving || !mergeSourceId.trim()}
                      class="px-3 py-1.5 text-sm font-medium rounded-lg bg-gold-600 text-white
                             hover:bg-gold-700 disabled:opacity-50 transition-colors">
                      {saving ? 'Merging...' : 'Merge'}
                    </button>
                  </div>
                </details>
              </div>

              <!-- Save / Cancel / Delete buttons -->
              <div class="flex items-center gap-2 pt-2">
                <button onclick={() => saveEdit(contact.id)} disabled={saving || !editDisplayName.trim()}
                  class="px-4 py-2 text-sm font-medium rounded-lg bg-gold-600 text-white
                         hover:bg-gold-700 disabled:opacity-50 transition-colors">
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button onclick={cancelEdit}
                  class="px-4 py-2 text-sm font-medium rounded-lg text-shadow-700
                         hover:bg-bark-200 transition-colors border border-bark-300">
                  Cancel
                </button>
                {#if contact.trustLevel !== 'primary'}
                  <button onclick={() => handleDelete(contact.id)} disabled={saving}
                    class="ml-auto px-4 py-2 text-sm font-medium rounded-lg border border-wilt-300 text-wilt-600
                           hover:bg-wilt-50 disabled:opacity-50 transition-colors">
                    Delete Contact
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="col-span-full card-garden p-10 text-center">
          <p class="text-shadow-600 italic text-sm">No visitors have been seen in the garden yet</p>
        </div>
      {/each}
    </div>
  {/if}
</div>
