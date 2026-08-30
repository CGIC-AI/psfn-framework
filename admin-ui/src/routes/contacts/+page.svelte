<script lang="ts">
  import { onMount } from 'svelte';
  import ContactSocialGraphPanel from './ContactSocialGraphPanel.svelte';
  import {
    listContacts,
    updateContact,
    createContact,
    deleteContact,
    mergeContacts,
    transferChannelIdentity,
    deleteConversationChannel,
    unlinkChannelIdentity,
  } from '$lib/api/endpoints/contacts';
  import type { ContactUpdatePayload, ContactCreatePayload } from '$lib/api/endpoints/contacts';
  import type {
    Contact,
    AdminContactListData,
    AdminContactSocialGraphConnectionView,
    AdminContactSocialGraphView,
    ContactIdentityLinkVerification,
    ContactMutationAuditEntry,
    ContactConversationChannelView,
    RecentContactShapeArtifact,
    AdminContactRelationshipScoreView,
    RelationshipType,
    TrustLevel,
    ChannelPrivacyLevel,
  } from '$lib/types';
  import { RELATIONSHIP_TYPES, CHANNEL_PRIVACY_LEVELS, TRUST_LEVELS } from '$lib/types';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';

  let data = $state<AdminContactListData | null>(null);
  let loading = $state(true);
  let error = $state('');
  let saving = $state(false);
  let saveMessage = $state('');
  let saveOk = $state(true);

  // bead psfn-framework-klbgi (adjudication R10.3): contacts are archived, never
  // deleted. Archived contacts persist as read-only history and must stay
  // visually distinct and filterable. Default to live-only; the operator opts in
  // to seeing archived history.
  let showArchived = $state(false);
  const visibleContacts = $derived(
    (data?.contacts ?? []).filter((c) => showArchived || !c.archivedAt),
  );
  const archivedCount = $derived((data?.contacts ?? []).filter((c) => c.archivedAt).length);
  let contactQuery = $state('');
  let selectedContactId = $state('');
  const filteredContacts = $derived.by(() => {
    const query = contactQuery.trim().toLocaleLowerCase();
    if (!query) return visibleContacts;
    return visibleContacts.filter((contact) =>
      [contact.displayName, contact.nickname, contact.id, contact.trustLevel, contact.relationshipType]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(query)),
    );
  });
  const selectedContact = $derived(
    filteredContacts.find((contact) => contact.id === selectedContactId) ?? filteredContacts[0],
  );

  // Expanded edit panel
  let editingContactId = $state<string | null>(null);
  let editDisplayName = $state('');
  let editNickname = $state('');
  let editTrustLevel = $state<TrustLevel>('regular');
  let editRelationshipType = $state<RelationshipType>('acquaintance');
  let editNotes = $state('');
  let editIsMachine = $state(false);
  let editGender = $state('');
  let editPronouns = $state('');
  let editAge = $state('');

  // Channel privacy edits (tracked per identity or conversation-channel key)
  let channelPrivacyEdits = $state<Record<string, ChannelPrivacyLevel>>({});
  // Channel-bonding opt-in per linked identity.
  let channelBondingEdits = $state<Record<string, boolean>>({});

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
  let transferIdentityKey = $state('');

  const KNOWN_CHANNEL_TYPES = [
    'discord',
    'telegram',
    'eidoverse',
    'api',
    'admin-chat',
    'twitter',
    'rss',
    'sillytavern',
    'multica',
  ];

  const TRUST_BADGE_STYLES: Record<string, { cls: string; label: string }> = {
    primary:  { cls: 'border border-gold-300 bg-gold-50 text-gold-800', label: 'Primary' },
    trusted:  { cls: 'border border-petal-300 bg-petal-50 text-petal-700', label: 'Trusted' },
    regular:  { cls: 'border border-moss-300 bg-moss-50 text-moss-800', label: 'Regular' },
    public:   { cls: 'border border-bark-300 bg-bark-100 text-shadow-700', label: 'Public' },
  };

  const PRIVACY_BADGE_STYLES: Record<string, { cls: string; label: string }> = {
    private:      { cls: 'border border-moss-300 bg-moss-50 text-moss-800', label: 'Private' },
    invite_only: { cls: 'border border-gold-300 bg-gold-50 text-gold-800', label: 'Invite-Only' },
    public:       { cls: 'border border-petal-300 bg-petal-50 text-petal-700', label: 'Public' },
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
    return contact.displayName;
  }

  function getChannels(contactId: string): ContactConversationChannelView[] {
    return data?.relatedChannelMap[contactId] ?? [];
  }

  function getRecentContactShape(contactId: string): RecentContactShapeArtifact | undefined {
    return data?.recentContactShapeMap[contactId];
  }

  function getSocialGraph(contactId: string): AdminContactSocialGraphView | undefined {
    return data?.socialGraphMap[contactId];
  }

  function getRelationshipScore(contactId: string): AdminContactRelationshipScoreView | undefined {
    return data?.relationshipScoreMap?.[contactId];
  }

  function contactNameForId(contactId: string): string {
    const contact = data?.contacts.find(c => c.id === contactId);
    return contact ? contactDisplayName(contact) : contactId;
  }

  function multicaMemberIdentityOptions(targetId: string) {
    return (data?.contacts ?? []).flatMap(source => {
      if (source.id === targetId || source.archivedAt || source.isMachineIntelligence === true) return [];
      return (source.channels ?? [])
        .filter(identity => (
          identity.channel === 'multica' && identity.userId.startsWith('multica:member:')
        ))
        .map(identity => ({
          key: `${source.id}\n${identity.userId}`,
          sourceContactId: source.id,
          sourceName: contactDisplayName(source),
          userId: identity.userId,
        }));
    });
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

  function finiteNumber(value: number | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function formatRelationshipScore(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2).replace(/\.?0+$/, '');
  }

  function relationshipScoreProgress(score: AdminContactRelationshipScoreView): number {
    const providedProgress = finiteNumber(score.progressToNextTier);
    if (providedProgress !== null) {
      const percent = providedProgress <= 1 ? providedProgress * 100 : providedProgress;
      return Math.max(0, Math.min(100, percent));
    }

    const nextThreshold = finiteNumber(score.nextTierThreshold);
    if (nextThreshold === null) return 100;

    const previousThreshold = finiteNumber(score.previousTierThreshold) ?? 0;
    const span = nextThreshold - previousThreshold;
    if (span <= 0) return score.score >= nextThreshold ? 100 : 0;

    return Math.max(0, Math.min(100, ((score.score - previousThreshold) / span) * 100));
  }

  function relationshipProgressLabel(score: AdminContactRelationshipScoreView): string {
    const nextThreshold = finiteNumber(score.nextTierThreshold);
    if (score.nextTier && nextThreshold !== null) {
      const remaining = Math.max(0, nextThreshold - score.score);
      return `${formatRelationshipScore(score.score)} / ${formatRelationshipScore(nextThreshold)} · ${formatRelationshipScore(remaining)} to ${formatRelType(score.nextTier)}`;
    }
    return 'Highest tracked tier';
  }

  function formatConfidence(value: number): string {
    return `${Math.round(value * 100)}%`;
  }

  function formatGraphDirection(connection: AdminContactSocialGraphConnectionView): string {
    if (!connection.directional) return 'mutual';
    if (connection.direction === 'outgoing') return 'from this contact';
    return 'toward this contact';
  }

  function graphSourceLabel(source: string): string {
    switch (source) {
      case 'contact':
        return 'Contact';
      case 'memory':
        return 'Memory';
      case 'manual':
        return 'Manual';
      case 'system':
        return 'System';
      default:
        return formatRelType(source);
    }
  }

  function formatAuditField(field: string): string {
    switch (field) {
      case 'trust_level':
        return 'Trust';
      case 'display_name':
        return 'Display Name';
      case 'relationship_type':
        return 'Relationship';
      case 'channel_privacy':
        return 'Channel Privacy';
      case 'channel_link':
        return 'Channel Link';
      case 'conversation_channel':
        return 'Conversation Channel';
      case 'notes':
      case 'nickname':
        return field.charAt(0).toUpperCase() + field.slice(1);
      default:
        return formatRelType(field);
    }
  }

  function contactChannelKey(ch: { channel: string; userId: string }): string {
    return `identity:${ch.channel}:${ch.userId}`;
  }

  function conversationChannelKey(ch: { channel: string; channelId: string }): string {
    return `conversation:${ch.channel}:${ch.channelId}`;
  }

  function hasPersistedConversationChannel(contact: Contact, channel: { channel: string; channelId: string }): boolean {
    return contact.conversationChannels?.some(entry => (
      entry.channel === channel.channel && entry.channelId === channel.channelId
    )) ?? false;
  }

  type ChannelPrivacyChangeCandidate =
    | {
      key: string;
      target: 'identity';
      channel: string;
      userId: string;
      privacyLevel: ChannelPrivacyLevel;
    }
    | {
      key: string;
      target: 'conversation';
      channel: string;
      channelId: string;
      privacyLevel: ChannelPrivacyLevel;
    };

  function buildPrivacyChangeCandidates(
    contact: Contact,
    relatedChannels: ContactConversationChannelView[],
  ): ChannelPrivacyChangeCandidate[] {
    const candidates = new Map<string, ChannelPrivacyChangeCandidate>();

    for (const ch of contact.channels ?? []) {
      const key = contactChannelKey(ch);
      candidates.set(key, {
        key,
        target: 'identity',
        channel: ch.channel,
        userId: ch.userId,
        privacyLevel: ch.privacyLevel as ChannelPrivacyLevel,
      });
    }

    for (const ch of relatedChannels) {
      if (!ch.privacyLevel) continue;
      const key = conversationChannelKey(ch);
      candidates.set(key, {
        key,
        target: 'conversation',
        channel: ch.channel,
        channelId: ch.channelId,
        privacyLevel: ch.privacyLevel,
      });
    }

    return [...candidates.values()];
  }

  function startEdit(contact: Contact) {
    editingContactId = contact.id;
    editDisplayName = contact.displayName;
    editNickname = contact.nickname ?? '';
    editTrustLevel = contact.trustLevel as TrustLevel;
    editRelationshipType = contact.relationshipType as RelationshipType;
    editNotes = contact.notes ?? '';
    editIsMachine = contact.isMachineIntelligence === true;
    editGender = contact.gender ?? '';
    editPronouns = contact.pronouns ?? '';
    editAge = typeof contact.age === 'number' ? String(contact.age) : '';
    showAddChannel = false;
    transferIdentityKey = '';
    newChannelName = '';
    newChannelUserId = '';
    newChannelPrivacy = 'private';
    // Initialize channel privacy edits from contact.channels
    channelPrivacyEdits = {};
    channelBondingEdits = {};
    for (const ch of contact.channels ?? []) {
      channelPrivacyEdits[contactChannelKey(ch)] = ch.privacyLevel as ChannelPrivacyLevel;
      channelBondingEdits[contactChannelKey(ch)] = ch.bonded === true;
    }
    for (const ch of getChannels(contact.id)) {
      const key = conversationChannelKey(ch);
      if (!ch.privacyLevel) continue;
      channelPrivacyEdits[key] = ch.privacyLevel;
    }
  }

  function cancelEdit() {
    editingContactId = null;
    channelPrivacyEdits = {};
    channelBondingEdits = {};
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
      if (editIsMachine !== (contact.isMachineIntelligence === true)) {
        patch.isMachineIntelligence = editIsMachine;
      }
      if (editGender.trim() !== (contact.gender ?? '')) {
        patch.gender = editGender.trim() === '' ? null : editGender.trim();
      }
      if (editPronouns.trim() !== (contact.pronouns ?? '')) {
        patch.pronouns = editPronouns.trim() === '' ? null : editPronouns.trim();
      }
      {
        const currentAge = typeof contact.age === 'number' ? String(contact.age) : '';
        if (editAge.trim() !== currentAge) {
          const parsed = Number.parseInt(editAge.trim(), 10);
          patch.age = editAge.trim() === '' || Number.isNaN(parsed) ? null : parsed;
        }
      }

      // Collect channel privacy changes from both linked identities and observed channels.
      const privacyChanges: Array<{
        channel: string;
        userId?: string;
        channelId?: string;
        privacyLevel: ChannelPrivacyLevel;
      }> = [];
      for (const ch of buildPrivacyChangeCandidates(contact, getChannels(contactId))) {
        const newPrivacy = channelPrivacyEdits[ch.key];
        if (newPrivacy && newPrivacy !== ch.privacyLevel) {
          if (ch.target === 'identity') {
            privacyChanges.push({ channel: ch.channel, userId: ch.userId, privacyLevel: newPrivacy });
          } else {
            privacyChanges.push({ channel: ch.channel, channelId: ch.channelId, privacyLevel: newPrivacy });
          }
        }
      }
      if (privacyChanges.length > 0) {
        patch.channelPrivacy = privacyChanges;
      }

      // Collect channel-bonding opt-in changes on linked identities.
      const bondingChanges: Array<{ channel: string; userId: string; bonded: boolean }> = [];
      for (const ch of contact.channels ?? []) {
        const next = channelBondingEdits[contactChannelKey(ch)];
        if (next !== undefined && next !== (ch.bonded === true)) {
          bondingChanges.push({ channel: ch.channel, userId: ch.userId, bonded: next });
        }
      }
      if (bondingChanges.length > 0) {
        patch.channelBonding = bondingChanges;
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
        channelBondingEdits = {};
        return;
      }

      const result = await updateContact(contactId, patch);
      if (result.ok) {
        data = await listContacts();
        editingContactId = null;
        channelPrivacyEdits = {};
        channelBondingEdits = {};
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

  // bead psfn-framework-klbgi (adjudication R10.3): the DELETE route archives the
  // contact, it does not destroy it. Memories, audit trail, and identity history
  // are kept as read-only history; only the live channel identities are released,
  // so a recreated/reused platform id resolves to a NEW person. Archiving is not
  // reversible from this UI today (no unarchive path exists).
  async function handleArchive(contactId: string) {
    if (!confirm(
      'Archive this contact? Their memories, mutation audit trail, and identity '
      + 'history are kept as read-only history. Their live channel identities are '
      + 'released, so a recreated or reused platform id will resolve to a NEW '
      + 'person, not this one. This is not a hard delete, but it cannot be undone '
      + 'from here.',
    )) return;
    saving = true;
    try {
      const result = await deleteContact(contactId);
      if (result.ok) {
        data = await listContacts();
        editingContactId = null;
        flash(true, result.message || 'Contact archived');
      } else {
        flash(false, result.message || 'Archive failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to archive contact');
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

  async function handleTransferIdentity(targetId: string) {
    const selected = multicaMemberIdentityOptions(targetId)
      .find(option => option.key === transferIdentityKey);
    if (!selected) {
      flash(false, 'Select a Multica member channel to move');
      return;
    }
    if (!confirm(`Move ${selected.userId} from ${selected.sourceName} onto this contact?`)) return;
    saving = true;
    try {
      const result = await transferChannelIdentity(
        targetId,
        selected.sourceContactId,
        'multica',
        selected.userId,
      );
      if (result.ok) {
        data = await listContacts();
        transferIdentityKey = '';
        flash(true, result.message || 'Multica member channel moved');
      } else {
        flash(false, result.message || 'Channel move failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to move Multica member channel');
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

  async function handleDeleteConversationChannel(contactId: string, channel: string, channelId: string) {
    if (!confirm(`Delete observed channel ${channel}:${channelId} from this contact? If it returns later, it will show up as new.`)) return;
    saving = true;
    try {
      const result = await deleteConversationChannel(contactId, channel, channelId);
      if (result.ok) {
        data = await listContacts();
        const refreshed = data?.contacts.find(c => c.id === contactId);
        if (refreshed && editingContactId === contactId) startEdit(refreshed);
        flash(true, result.message || 'Conversation channel deleted');
      } else {
        flash(false, result.message || 'Delete failed');
      }
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'Failed to delete conversation channel');
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

<div class="garden-page space-y-5 pb-8">
  <GardenPageHeader
    eyebrow="Memory & Identity"
    title="The Visitors"
    description={`${visibleContacts.length} contact${visibleContacts.length === 1 ? '' : 's'} in view · manage trust, channels, profiles, and social context.`}
  >
    {#snippet actions()}
      <button
        type="button"
        onclick={() => showCreateForm = true}
        class="garden-action garden-action--primary rounded-xl border border-gold-500 bg-gold-600 px-3 py-2 text-sm font-semibold text-bark-50 transition-colors hover:bg-gold-700"
      >
        New contact
      </button>
    {/snippet}
  </GardenPageHeader>

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
    <div class="garden-error card-garden p-5 text-center text-wilt-600 text-sm">{error}</div>
  {/if}

  <!-- Loading -->
  {#if loading}
    <div class="garden-loading grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
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
          <div class="garden-table-shell border-t border-bark-300">
            <div class="garden-table-scroll">
            <table class="garden-table w-full text-sm">
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
            <h2 class="text-sm font-serif font-semibold text-shadow-800">Contact Mutation Audit</h2>
            <p class="text-sm text-shadow-600 mt-0.5">
              {data.mutationAudits.length} mutation{data.mutationAudits.length !== 1 ? 's' : ''} recorded
            </p>
          </div>
          <span class="text-shadow-600 text-sm transition-transform {showAuditTrail ? 'rotate-180' : ''}">
            &#9660;
          </span>
        </button>
        {#if showAuditTrail}
          <div class="garden-table-shell border-t border-bark-300">
            <div class="garden-table-scroll">
            <table class="garden-table w-full text-sm">
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
                    <td class="px-4 py-2.5 text-sm text-shadow-700">{formatAuditField(audit.field)}</td>
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
              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                     focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
              placeholder="Required" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="create-trust" class="block text-sm font-medium text-shadow-800 mb-1">Trust Level</label>
              <select id="create-trust" bind:value={createTrustLevel}
                class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                       focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                {#each TRUST_LEVELS.filter(l => l !== 'primary') as level}
                  <option value={level}>{level.charAt(0).toUpperCase() + level.slice(1)}</option>
                {/each}
              </select>
            </div>
            <div>
              <label for="create-rel" class="block text-sm font-medium text-shadow-800 mb-1">Relationship</label>
              <select id="create-rel" bind:value={createRelationshipType}
                class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
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
              class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm resize-y
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
              data-esc-close
              class="px-4 py-2 text-sm font-medium rounded-lg text-shadow-700
                     hover:bg-bark-200 transition-colors border border-bark-300">
              Cancel
            </button>
          </div>
        </div>
      {/if}
    </div>

    <div class="garden-split-view">
      <aside class="garden-section flex min-h-0 flex-col gap-3 p-3 sm:p-4">
        <div class="garden-section-header">
          <div>
            <h2 class="garden-section-title">Contact directory</h2>
            <p class="garden-section-description">Choose a visitor to inspect and edit.</p>
          </div>
          <span class="garden-status">{filteredContacts.length}</span>
        </div>
        <div class="garden-toolbar flex-col items-stretch">
          <label class="garden-field">
            <span>Search contacts</span>
            <input
              type="search"
              bind:value={contactQuery}
              placeholder="Name, trust, relationship…"
              class="w-full rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900"
            />
          </label>
          <label class="inline-flex min-h-10 items-center gap-2 text-sm text-shadow-700">
            <input type="checkbox" bind:checked={showArchived}
              class="rounded border-bark-300 text-gold-600 focus:ring-gold-300" />
            Show archived
            {#if archivedCount > 0}
              <span class="garden-status">{archivedCount}</span>
            {/if}
          </label>
        </div>
        <div class="max-h-[68vh] space-y-1 overflow-y-auto pr-1" aria-label="Contacts">
          {#each filteredContacts as contact (contact.id)}
            {@const listBadge = trustBadge(contact.trustLevel)}
            <button
              type="button"
              onclick={() => {
                selectedContactId = contact.id;
                cancelEdit();
                cancelQuickTrust();
                showAddChannel = false;
              }}
              class="w-full rounded-xl border px-3 py-3 text-left transition-colors {selectedContact?.id === contact.id ? 'border-gold-300 bg-gold-50' : 'border-transparent hover:border-bark-200 hover:bg-bark-50'} {contact.archivedAt ? 'opacity-60' : ''}"
            >
              <span class="flex items-start justify-between gap-3">
                <span class="min-w-0">
                  <span class="block truncate text-sm font-semibold text-shadow-900">{contactDisplayName(contact)}</span>
                  <span class="mt-0.5 block truncate text-xs text-shadow-600">{formatRelType(contact.relationshipType)}</span>
                </span>
                <span class="shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold {listBadge.cls}">{listBadge.label}</span>
              </span>
            </button>
          {:else}
            <div class="garden-empty p-5 text-center text-sm text-shadow-600">No contacts match the current filters.</div>
          {/each}
        </div>
      </aside>

      <section class="min-w-0">
      {#each selectedContact ? [selectedContact] : [] as contact (contact.id)}
        {@const channels = getChannels(contact.id)}
        {@const recentContactShape = getRecentContactShape(contact.id)}
        {@const graph = getSocialGraph(contact.id)}
        {@const relationshipScore = getRelationshipScore(contact.id)}
        {@const badge = trustBadge(contact.trustLevel)}

        <div class="garden-section card-garden p-4 sm:p-5 flex flex-col gap-3 {editingContactId === contact.id ? 'ring-2 ring-gold-400' : ''} {contact.archivedAt ? 'opacity-60 grayscale' : ''}">
          <!-- Header: Name + Trust Badge -->
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="text-base font-serif font-semibold text-shadow-900 truncate">
                {contactDisplayName(contact)}
              </h3>
              {#if contact.archivedAt}
                <span class="inline-flex items-center gap-1 px-2 py-0.5 mt-0.5 rounded-full text-xs font-medium bg-bark-200 text-shadow-600"
                  title="Archived on {contact.archivedAt}. Read-only history; live identities released.">
                  Archived
                </span>
              {/if}
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
                         bg-bark-50 text-shadow-800
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
                  group-hover:ring-2 group-hover:ring-gold-300 transition-all {badge.cls}">
                  {badge.label}
                </span>
              </button>
            {/if}
          </div>

          <!-- Relationship + Activity -->
          <div class="text-sm space-y-1">
            <p class="text-shadow-700 flex flex-wrap items-center gap-2">
              <span class="font-medium text-shadow-800">{formatRelType(contact.relationshipType)}</span>
              <span
                class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold {contact.isMachineIntelligence ? 'border-moss-300 bg-moss-50 text-moss-800' : 'border-bark-300 bg-bark-100 text-shadow-700'}"
                title={contact.isMachineIntelligence
                  ? 'Machine intelligence (auto-detected from channel provenance or set by operator)'
                  : 'Human contact'}
              >
                {contact.isMachineIntelligence ? 'Companion' : 'Human'}
              </span>
            </p>
            <div class="flex items-center gap-4 text-shadow-600">
              <span>First: {formatDate(contact.firstSeen)}</span>
              <span>Last: {formatDate(contact.lastSeen)}</span>
            </div>
          </div>

          {#if relationshipScore}
            <div class="border-t border-moss-200 pt-3 space-y-2">
              <div class="flex items-baseline justify-between gap-3">
                <span class="text-xs font-medium uppercase tracking-wider text-shadow-600">Dynamic Relationship</span>
                <span class="text-sm font-semibold text-shadow-900">{formatRelType(relationshipScore.resolvedTier)}</span>
              </div>
              <div class="flex items-baseline justify-between gap-3 text-sm">
                <span class="text-shadow-700">Score</span>
                <span class="font-mono font-semibold text-shadow-900">{formatRelationshipScore(relationshipScore.score)}</span>
              </div>
              <div class="h-2 w-full overflow-hidden rounded-full bg-bark-200" aria-label="Relationship progress toward next tier">
                <div class="h-full rounded-full bg-moss-600 transition-all" style="width: {relationshipScoreProgress(relationshipScore)}%"></div>
              </div>
              <p class="text-xs text-shadow-600">{relationshipProgressLabel(relationshipScore)}</p>
              {#if relationshipScore.updatedAt}
                <p class="text-xs text-shadow-500">Updated {formatDateTime(relationshipScore.updatedAt)}</p>
              {/if}
            </div>
          {/if}

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
              <div class="garden-table-shell">
                <div class="garden-table-scroll">
                <table class="garden-table w-full text-sm">
                  <thead>
                    <tr class="border-b border-bark-300">
                      <th class="text-left py-1.5 pr-2 text-shadow-700 font-medium text-sm">Channel</th>
                      <th class="text-left py-1.5 pr-2 text-shadow-700 font-medium text-sm">Account ID</th>
                      <th class="text-left py-1.5 pr-2 text-shadow-700 font-medium text-sm">Privacy</th>
                      <th class="text-left py-1.5 text-shadow-700 font-medium text-sm">Seen</th>
                      <th class="text-right py-1.5 text-shadow-700 font-medium text-sm">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each contact.channels as ch}
                      {@const pb = privacyBadge(ch.privacyLevel)}
                      <tr class="border-b border-bark-100">
                        <td class="py-1.5 pr-2 text-shadow-800 font-medium">{ch.channel}</td>
                        <td class="py-1.5 pr-2 font-mono text-shadow-800 text-sm break-all">{ch.userId}</td>
                        <td class="py-1.5 pr-2">
                          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium {pb.cls}">
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
                        <td class="py-1.5 text-right">
                          <button
                            onclick={() => handleUnlink(contact.id, ch.channel, ch.userId)}
                            disabled={saving}
                            class="px-2.5 py-1 text-xs font-medium rounded border border-wilt-300 text-wilt-700 hover:bg-wilt-50 disabled:opacity-50 transition-colors"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                </div>
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
                    <span class="font-mono text-sm text-shadow-700 break-all">{ch.channelId}</span>
                    {#if ch.privacyLevel}
                      {@const pb = privacyBadge(ch.privacyLevel)}
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium {pb.cls}">
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

          <!-- Observed Conversation Channels -->
          <div class="border-t border-bark-200 pt-2">
            <p class="text-sm font-medium text-shadow-700 mb-1.5 uppercase tracking-wider">Conversation Channels</p>
            {#if channels.length > 0}
              <div class="space-y-1.5">
                {#each channels as ch}
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm text-shadow-800 font-medium">{ch.channel}</span>
                    <span class="font-mono text-sm text-shadow-700 break-all">{ch.channelId}</span>
                    {#if ch.privacyLevel}
                      {@const pb = privacyBadge(ch.privacyLevel)}
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-sm font-medium {pb.cls}">
                        {pb.label}
                      </span>
                    {/if}
                    {#if ch.lastSeen}
                      <span class="text-xs text-shadow-600">Last seen {formatDateTime(ch.lastSeen)}</span>
                    {/if}
                    {#if hasPersistedConversationChannel(contact, ch)}
                      <button
                        onclick={() => handleDeleteConversationChannel(contact.id, ch.channel, ch.channelId)}
                        disabled={saving}
                        class="px-2.5 py-1 text-xs font-medium rounded border border-wilt-300 text-wilt-700 hover:bg-wilt-50 disabled:opacity-50 transition-colors"
                      >
                        Delete
                      </button>
                    {/if}
                  </div>
                {/each}
              </div>
            {:else}
              <p class="text-sm text-shadow-500 italic">No observed conversation channels yet</p>
            {/if}
          </div>

          <!-- Profile + Memory count -->
          {#if recentContactShape}
            <div class="border-t border-bark-200 pt-2">
              {#if recentContactShape.summary}
                <p class="text-sm text-shadow-600 italic mb-1">Freshness-bound recent contact shape</p>
                <p class="text-sm text-shadow-700 leading-relaxed mb-1.5">{recentContactShape.summary}</p>
              {/if}
              <div class="flex items-center gap-3 text-sm text-shadow-600">
                <span class="inline-flex items-center gap-1">
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-gold-400"></span>
                  {recentContactShape.sourceMemoryIds.length} memories
                </span>
                {#if recentContactShape.updatedAt}
                  <span>Updated {formatTimestamp(recentContactShape.updatedAt)}</span>
                {/if}
              </div>
              {#if recentContactShape.sourceMemoryIds && recentContactShape.sourceMemoryIds.length > 0}
                <details class="mt-1.5">
                  <summary class="text-sm text-shadow-600 cursor-pointer
                                  hover:text-gold-600 transition-colors">
                    {recentContactShape.sourceMemoryIds.length} source memor{recentContactShape.sourceMemoryIds.length === 1 ? 'y' : 'ies'}
                  </summary>
                  <div class="mt-1 flex flex-wrap gap-1">
                    {#each recentContactShape.sourceMemoryIds as memId}
                      <a
                        href={scopeGardenPath(`/memory?id=${encodeURIComponent(memId)}`)}
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
              <span class="text-sm text-shadow-600 italic">No current recent contact shape</span>
            </div>
          {/if}

          <ContactSocialGraphPanel
            {graph}
            {formatConfidence}
            {formatGraphDirection}
            {formatRelType}
            {formatTimestamp}
            {graphSourceLabel}
            {trustBadge}
          />

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
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                  placeholder="Display name (required)" />
              </div>

              <!-- Nickname -->
              <div>
                <label for="edit-nick-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Nickname</label>
                <input id="edit-nick-{contact.id}" type="text" bind:value={editNickname}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                  placeholder="Optional nickname" />
              </div>

              <!-- Trust Level -->
              <div>
                <label for="edit-trust-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Trust Level</label>
                <select id="edit-trust-{contact.id}" bind:value={editTrustLevel}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
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
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                  {#each RELATIONSHIP_TYPES as rt}
                    <option value={rt}>{formatRelType(rt)}</option>
                  {/each}
                </select>
              </div>

              <!-- Demographics (bead fnyb) -->
              <div class="grid grid-cols-3 gap-3">
                <div>
                  <label for="edit-gender-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Gender</label>
                  <input id="edit-gender-{contact.id}" type="text" bind:value={editGender}
                    class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                           focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                    placeholder="e.g. woman" />
                </div>
                <div>
                  <label for="edit-pronouns-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Pronouns</label>
                  <input id="edit-pronouns-{contact.id}" type="text" bind:value={editPronouns}
                    class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                           focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                    placeholder="e.g. she/her" />
                </div>
                <div>
                  <label for="edit-age-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Age</label>
                  <input id="edit-age-{contact.id}" type="number" min="0" bind:value={editAge}
                    class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm
                           focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                    placeholder="—" />
                </div>
              </div>

              <!-- Notes -->
              <div>
                <label for="edit-notes-{contact.id}" class="block text-sm font-medium text-shadow-800 mb-1">Notes</label>
                <textarea id="edit-notes-{contact.id}" bind:value={editNotes} rows={3}
                  class="w-full px-3 py-2 rounded-lg border border-bark-300 bg-bark-50 text-shadow-900 text-sm resize-y
                         focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400"
                  placeholder="Notes about this contact..."
                ></textarea>
              </div>

              <!-- Human / Companion marker -->
              <div class="flex items-center justify-between gap-3 rounded-lg border border-bark-300 bg-bark-50 px-3 py-2.5">
                <div>
                  <p class="text-sm font-medium text-shadow-800">Machine intelligence</p>
                  <p class="text-xs text-shadow-600">
                    Marks this contact as a companion/agent rather than a human. Channel-detected values are preserved unless changed here.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={editIsMachine}
                  aria-label="Machine intelligence"
                  onclick={() => (editIsMachine = !editIsMachine)}
                  class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors {editIsMachine ? 'bg-moss-500' : 'bg-bark-300'}"
                >
                  <span
                    class="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform {editIsMachine ? 'translate-x-6' : 'translate-x-1'}"
                  ></span>
                </button>
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
                          class="text-sm px-2 py-1 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                                 focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                          {#each CHANNEL_PRIVACY_LEVELS as pl}
                            <option value={pl}>{pl.replace('_', ' ')}</option>
                          {/each}
                        </select>
                        <label class="flex items-center gap-1 text-xs text-shadow-700"
                          title="Cross-channel capable: bonded identities operate as one logical conversation at the lowest-common privacy of the bonded set">
                          <input
                            type="checkbox"
                            checked={channelBondingEdits[key] ?? ch.bonded === true}
                            onchange={(e) => {
                              channelBondingEdits[key] = (e.target as HTMLInputElement).checked;
                            }}
                            class="rounded border-bark-300 text-moss-500 focus:ring-gold-300"
                          />
                          Bonded
                        </label>
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
                      {@const key = conversationChannelKey(ch)}
                      <div class="flex items-center gap-2 flex-wrap">
                        <div class="min-w-0">
                          <span class="font-mono text-sm text-shadow-800 min-w-0 truncate">{ch.channel}:{ch.channelId}</span>
                          {#if ch.userId}
                            <p class="text-xs text-shadow-600">Linked identity {ch.userId}</p>
                          {/if}
                        </div>
                        {#if ch.privacyLevel}
                          <select
                            value={channelPrivacyEdits[key] ?? ch.privacyLevel}
                            onchange={(e) => {
                              channelPrivacyEdits[key] = (e.target as HTMLSelectElement).value as ChannelPrivacyLevel;
                            }}
                            class="text-sm px-2 py-1 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                            {#each CHANNEL_PRIVACY_LEVELS as pl}
                              <option value={pl}>{pl.replace('_', ' ')}</option>
                            {/each}
                          </select>
                        {/if}
                        {#if ch.lastSeen}
                          <span class="text-xs text-shadow-600">Last seen {formatDateTime(ch.lastSeen)}</span>
                        {/if}
                      </div>
                    {/each}
                  </div>
                </div>
              {/if}

              {#if channels.length > 0 && contact.channels && contact.channels.length > 0}
                <div>
                  <p class="text-sm font-medium text-shadow-800 mb-2">Observed Conversation Channels</p>
                  <div class="space-y-2">
                    {#each channels as ch}
                      {@const key = conversationChannelKey(ch)}
                      <div class="flex items-center gap-2 flex-wrap">
                        <div class="min-w-0">
                          <span class="font-mono text-sm text-shadow-800 min-w-0 truncate">{ch.channel}:{ch.channelId}</span>
                          {#if ch.userId}
                            <p class="text-xs text-shadow-600">Linked identity {ch.userId}</p>
                          {/if}
                        </div>
                        {#if ch.privacyLevel}
                          <select
                            value={channelPrivacyEdits[key] ?? ch.privacyLevel}
                            onchange={(e) => {
                              channelPrivacyEdits[key] = (e.target as HTMLSelectElement).value as ChannelPrivacyLevel;
                            }}
                            class="text-sm px-2 py-1 rounded-lg border border-bark-300 bg-bark-50 text-shadow-800
                                   focus:outline-none focus:ring-2 focus:ring-gold-300 focus:border-gold-400">
                            {#each CHANNEL_PRIVACY_LEVELS as pl}
                              <option value={pl}>{pl.replace('_', ' ')}</option>
                            {/each}
                          </select>
                        {/if}
                        {#if ch.lastSeen}
                          <span class="text-xs text-shadow-600">Last seen {formatDateTime(ch.lastSeen)}</span>
                        {/if}
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
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label for="new-ch-name" class="text-sm text-shadow-700">Channel</label>
                        <select id="new-ch-name"
                          value={newChannelName}
                          onchange={(e) => {
                            const val = (e.target as HTMLSelectElement).value;
                            newChannelName = val === '__custom__' ? '' : val;
                          }}
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-bark-50 text-shadow-900
                                 focus:outline-none focus:ring-1 focus:ring-gold-300">
                          <option value="">Select...</option>
                          {#each KNOWN_CHANNEL_TYPES as ct}
                            <option value={ct}>{ct}</option>
                          {/each}
                          <option value="__custom__">Other (custom)</option>
                        </select>
                        {#if newChannelName === '' || !KNOWN_CHANNEL_TYPES.includes(newChannelName)}
                          <input type="text" bind:value={newChannelName} placeholder="custom channel"
                            class="w-full px-2 py-1 mt-1 text-sm rounded border border-bark-300 bg-bark-50 text-shadow-900
                                   focus:outline-none focus:ring-1 focus:ring-gold-300" />
                        {/if}
                      </div>
                      <div>
                        <label for="new-ch-userid" class="text-sm text-shadow-700">Account ID</label>
                        <input id="new-ch-userid" type="text" bind:value={newChannelUserId} placeholder="123456789"
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-bark-50 text-shadow-900
                                 focus:outline-none focus:ring-1 focus:ring-gold-300" />
                      </div>
                      <div>
                        <label for="new-ch-privacy" class="text-sm text-shadow-700">Privacy</label>
                        <select id="new-ch-privacy" bind:value={newChannelPrivacy}
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-bark-50 text-shadow-900
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

              <!-- Move one Multica member identity without merging contacts. -->
              {#if contact.isMachineIntelligence !== true && multicaMemberIdentityOptions(contact.id).length > 0}
                <div>
                  <details class="group">
                    <summary class="text-sm font-medium text-gold-700 hover:text-gold-600 transition-colors cursor-pointer">
                      Move a Multica Member Channel Into This Contact
                    </summary>
                    <div class="mt-2 p-3 border border-bark-300 rounded-lg bg-bark-50 space-y-2">
                      <p class="text-sm text-shadow-600">
                        Future Multica sessions from this member will use this contact's memories, trust, and permissions. The source contact and Multica system identity stay separate.
                      </p>
                      <div>
                        <label for="transfer-identity-{contact.id}" class="text-sm text-shadow-700">Multica member channel</label>
                        <select id="transfer-identity-{contact.id}" bind:value={transferIdentityKey}
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-bark-50 text-shadow-900
                                 focus:outline-none focus:ring-1 focus:ring-gold-300">
                          <option value="">Select...</option>
                          {#each multicaMemberIdentityOptions(contact.id) as option}
                            <option value={option.key}>{option.sourceName} — {option.userId}</option>
                          {/each}
                        </select>
                      </div>
                      <button onclick={() => handleTransferIdentity(contact.id)}
                        disabled={saving || !transferIdentityKey}
                        class="px-3 py-1.5 text-sm font-medium rounded-lg bg-gold-600 text-white
                               hover:bg-gold-700 disabled:opacity-50 transition-colors">
                        {saving ? 'Moving...' : 'Move Channel'}
                      </button>
                    </div>
                  </details>
                </div>
              {/if}

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
                        class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-bark-50 text-shadow-900
                               focus:outline-none focus:ring-1 focus:ring-gold-300 font-mono"
                        placeholder="UUID of contact to absorb" />
                    </div>
                    {#if data?.contacts}
                      <div>
                        <label for="merge-source-select-{contact.id}" class="text-sm text-shadow-700">Or pick from list</label>
                        <select id="merge-source-select-{contact.id}"
                          value={mergeSourceId}
                          onchange={(e) => mergeSourceId = (e.target as HTMLSelectElement).value}
                          class="w-full px-2 py-1 text-sm rounded border border-bark-300 bg-bark-50 text-shadow-900
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
                  data-esc-close
                  class="px-4 py-2 text-sm font-medium rounded-lg text-shadow-700
                         hover:bg-bark-200 transition-colors border border-bark-300">
                  Cancel
                </button>
                {#if contact.trustLevel !== 'primary' && !contact.archivedAt}
                  <button onclick={() => handleArchive(contact.id)} disabled={saving}
                    title="Archive this contact (keeps history, releases live identities). Not a hard delete."
                    class="ml-auto px-4 py-2 text-sm font-medium rounded-lg border border-wilt-300 text-wilt-600
                           hover:bg-wilt-50 disabled:opacity-50 transition-colors">
                    Archive Contact
                  </button>
                {:else if contact.archivedAt}
                  <span class="ml-auto px-4 py-2 text-sm font-medium text-shadow-500 italic">
                    Archived (read-only history)
                  </span>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {:else}
        <div class="garden-empty card-garden p-10 text-center">
          <p class="text-shadow-600 italic text-sm">No visitors have been seen in the garden yet</p>
        </div>
      {/each}
      </section>
    </div>
  {/if}
</div>
