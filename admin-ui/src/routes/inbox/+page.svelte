<script lang="ts">
  import { onDestroy, onMount, type Component } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import GardenPageHeader from '$lib/components/garden/GardenPageHeader.svelte';
  import GardenTabBar, { type GardenTabItem } from '$lib/components/garden/GardenTabBar.svelte';
  import LazyGardenPage from '$lib/components/garden/LazyGardenPage.svelte';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';
  import {
    emptyInboxTabCounts,
    notifyInboxAttentionChanged,
    subscribeInboxTabCounts,
    type InboxTabCounts,
  } from '$lib/nav/attention';
  import {
    canonicalInboxPath,
    INBOX_TABS,
    resolveInboxTab,
    type InboxTabId,
  } from '$lib/nav/canonical-routes';

  const activeTab = $derived(resolveInboxTab($page.url.searchParams));
  let tabCounts = $state<InboxTabCounts>(emptyInboxTabCounts());
  let unsubscribeCounts: (() => void) | null = null;

  const totalPending = $derived(
    Object.values(tabCounts).reduce((sum, count) => sum + count, 0),
  );

  const inboxTabs = $derived<GardenTabItem[]>(
    INBOX_TABS.map(tab => ({
      id: tab.id,
      label: tab.label,
      ...(tabCounts[tab.id] > 0 ? { count: tabCounts[tab.id] } : {}),
    })),
  );

  const TAB_LOADERS: Record<InboxTabId, {
    loader: () => Promise<{ default: Component<{ embedded?: boolean }> }>;
    loadingLabel: string;
    errorLabel: string;
  }> = {
    confirmations: {
      loader: () => import('../confirmations/+page.svelte'),
      loadingLabel: 'Loading action confirmations...',
      errorLabel: 'Failed to load action confirmations.',
    },
    escalations: {
      loader: () => import('../escalations/+page.svelte'),
      loadingLabel: 'Loading human escalations...',
      errorLabel: 'Failed to load human escalations.',
    },
    contacts: {
      loader: () => import('../contact-approvals/+page.svelte'),
      loadingLabel: 'Loading contact approvals...',
      errorLabel: 'Failed to load contact approvals.',
    },
    graph: {
      loader: () => import('../graph-proposals/+page.svelte'),
      loadingLabel: 'Loading graph proposals...',
      errorLabel: 'Failed to load graph proposals.',
    },
    cogsec: {
      loader: () => import('../cognitive-security/approvals/+page.svelte'),
      loadingLabel: 'Loading CogSec quarantine queue...',
      errorLabel: 'Failed to load CogSec quarantine queue.',
    },
    remediation: {
      loader: () => import('../cognitive-security/remediation/+page.svelte'),
      loadingLabel: 'Loading session integrity remediation...',
      errorLabel: 'Failed to load session integrity remediation.',
    },
  };

  function selectInboxTab(id: string): void {
    const tab = INBOX_TABS.find(candidate => candidate.id === id)?.id;
    if (!tab || tab === activeTab) return;
    void goto(scopeGardenPath(canonicalInboxPath(tab)), {
      keepFocus: true,
      noScroll: true,
    });
  }

  onMount(() => {
    unsubscribeCounts = subscribeInboxTabCounts((counts) => {
      tabCounts = counts;
    });
  });

  onDestroy(() => {
    unsubscribeCounts?.();
    unsubscribeCounts = null;
  });
</script>

<div class="garden-page space-y-5 pb-8">
  <GardenPageHeader
    eyebrow="Live Operations · Operator queue"
    title="Inbox"
    description="Review confirmations, human escalations, contact and graph approvals, quarantined content, and session integrity incidents in one place."
  >
    {#snippet actions()}
      <span class="rounded-full border border-bark-300 bg-bark-50 px-3 py-1 text-xs font-semibold tabular-nums text-shadow-700">
        {totalPending} pending
      </span>
      <button
        type="button"
        onclick={notifyInboxAttentionChanged}
        class="garden-action min-h-11 rounded-lg border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100"
      >
        Refresh counts
      </button>
    {/snippet}
  </GardenPageHeader>

  <GardenTabBar
    tabs={inboxTabs}
    activeId={activeTab}
    onSelect={selectInboxTab}
    label="Inbox queues"
  />

  {#key activeTab}
    {@const view = TAB_LOADERS[activeTab]}
    <LazyGardenPage
      loader={view.loader}
      componentProps={{ embedded: true }}
      loadingLabel={view.loadingLabel}
      errorLabel={view.errorLabel}
    />
  {/key}
</div>
