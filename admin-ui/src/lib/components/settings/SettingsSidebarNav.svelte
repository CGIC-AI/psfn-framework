<script lang="ts">
  import GardenSectionNav, {
    type GardenSectionNavGroup,
  } from '$lib/components/garden/GardenSectionNav.svelte';
  import {
    isSettingsSimpleSectionId,
    type SettingsSimpleSectionGroup,
    type SettingsSimpleSectionId,
  } from './navigation';

  let {
    groups,
    activeSectionId,
    onNavigate,
  } = $props<{
    groups: SettingsSimpleSectionGroup[];
    activeSectionId: SettingsSimpleSectionId;
    onNavigate: (sectionId: SettingsSimpleSectionId) => void;
  }>();

  let navGroups = $derived<GardenSectionNavGroup[]>(groups.map(group => ({
    id: group.id,
    label: group.label,
    items: group.sections.map(section => ({
      id: section.id,
      title: section.title,
      description: section.description,
    })),
  })));

  function handleNavigate(sectionId: string): void {
    if (isSettingsSimpleSectionId(sectionId)) {
      onNavigate(sectionId);
    }
  }
</script>

<div class="space-y-3" data-settings-sidebar-nav>
  <div class="card-garden space-y-1 p-4">
    <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Settings Map</p>
    <p class="text-sm text-shadow-700">Quick jumps by domain</p>
  </div>

  <GardenSectionNav
    groups={navGroups}
    activeId={activeSectionId}
    onNavigate={handleNavigate}
    label="Settings sections"
  />
</div>
