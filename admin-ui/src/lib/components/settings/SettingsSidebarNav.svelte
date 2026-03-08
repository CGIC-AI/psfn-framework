<script lang="ts">
  import {
    settingsSimpleSectionHref,
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

  function handleNavigate(event: MouseEvent, sectionId: SettingsSimpleSectionId): void {
    event.preventDefault();
    onNavigate(sectionId);
  }
</script>

<nav class="card-garden p-4 space-y-4" aria-label="Settings sections" data-settings-sidebar-nav>
  <div class="space-y-1 border-b border-bark-200 pb-3">
    <p class="text-xs uppercase tracking-[0.16em] text-shadow-500">Settings Map</p>
    <p class="text-sm text-shadow-700">Quick jumps by domain</p>
  </div>

  {#each groups as group}
    <section class="space-y-2">
      <h2 class="text-xs uppercase tracking-[0.16em] text-shadow-500">{group.label}</h2>
      <div class="space-y-1.5">
        {#each group.sections as section}
          <a
            href={settingsSimpleSectionHref(section.id)}
            onclick={(event) => handleNavigate(event, section.id)}
            aria-current={activeSectionId === section.id ? 'true' : undefined}
            data-settings-sidebar-target={section.id}
            class="block rounded-lg border px-3 py-2 transition-colors
              {activeSectionId === section.id
                ? 'border-gold-400 bg-gold-50 shadow-sm'
                : 'border-bark-200 bg-white hover:bg-bark-100'}"
          >
            <span class="block text-sm font-medium text-shadow-800">{section.title}</span>
            <span class="block text-xs text-shadow-600 mt-0.5">{section.description}</span>
          </a>
        {/each}
      </div>
    </section>
  {/each}
</nav>
