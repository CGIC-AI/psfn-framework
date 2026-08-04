<script lang="ts">
  import { onMount } from 'svelte';
  import { getSettings } from '$lib/api/endpoints/settings';
  import type { EffectiveModelSelectionView } from '$lib/types';
  import EffectiveChatModelView from './EffectiveChatModelView.svelte';

  let effectiveChat = $state<EffectiveModelSelectionView | null>(null);
  let fleetDefault = $state<EffectiveModelSelectionView | null>(null);
  let loading = $state(true);
  let loadError = $state('');

  async function loadRuntimeTruth(): Promise<void> {
    try {
      const settings = await getSettings();
      effectiveChat = settings.effectiveModelSelection.chat;
      fleetDefault = settings.effectiveModelSelection.fleetDefaultChat;
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Runtime model selection unavailable';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadRuntimeTruth();
  });
</script>

<EffectiveChatModelView {effectiveChat} {fleetDefault} {loading} {loadError} />
