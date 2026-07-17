<script lang="ts">
  import type { SettingsSimpleSectionId } from './navigation';
  import {
    filterSettingsSearchEntries,
    settingsSearchResultKey,
    type SettingsSearchEntry,
    type SettingsSearchResult,
  } from './settings-search';

  let {
    onJump,
    entries,
  } = $props<{
    onJump: (
      sectionId: SettingsSimpleSectionId,
      advancedGroupId?: string,
    ) => void;
    entries?: readonly SettingsSearchEntry[];
  }>();

  const uid = $props.id();
  const listboxId = `${uid}-listbox`;
  const optionId = (result: SettingsSearchResult) =>
    `${uid}-${settingsSearchResultKey(result)}`;

  let query = $state('');
  let open = $state(false);
  let activeIndex = $state(-1);

  let results = $derived(
    query.trim()
      ? filterSettingsSearchEntries(query, entries ?? undefined)
      : [],
  );
  let expanded = $derived(open && results.length > 0);
  let activeResult = $derived(
    activeIndex >= 0 && activeIndex < results.length
      ? results[activeIndex]
      : null,
  );

  // Keep the highlighted row valid as the result set changes under typing.
  $effect(() => {
    if (results.length === 0) {
      activeIndex = -1;
    } else if (activeIndex >= results.length) {
      activeIndex = results.length - 1;
    }
  });

  function openIfResults(): void {
    if (results.length > 0) open = true;
  }

  function selectResult(result: SettingsSearchResult | null): void {
    if (!result) return;
    onJump(
      result.sectionId,
      result.kind === 'field' ? result.advancedGroupId : undefined,
    );
    query = '';
    open = false;
    activeIndex = -1;
  }

  function moveActive(delta: number): void {
    if (results.length === 0) return;
    open = true;
    const count = results.length;
    const base = activeIndex < 0 ? (delta > 0 ? -1 : 0) : activeIndex;
    activeIndex = (base + delta + count) % count;
  }

  function onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        if (results.length > 0) {
          event.preventDefault();
          open = true;
          activeIndex = 0;
        }
        break;
      case 'End':
        if (results.length > 0) {
          event.preventDefault();
          open = true;
          activeIndex = results.length - 1;
        }
        break;
      case 'Enter':
        if (expanded && activeResult) {
          event.preventDefault();
          selectResult(activeResult);
        }
        break;
      case 'Escape':
        // Handle locally so the page-level Escape handler does not also fire.
        if (open || query) {
          event.preventDefault();
          event.stopPropagation();
          if (open && results.length > 0) {
            open = false;
          } else {
            query = '';
          }
        }
        break;
      default:
        break;
    }
  }

  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget instanceof HTMLElement && event.currentTarget.contains(next)) {
      return;
    }
    open = false;
  }
</script>

<div class="relative" onfocusout={onFocusOut}>
  <label class="block" for={`${uid}-input`}>
    <span class="text-xs font-semibold uppercase tracking-[0.16em] text-shadow-500">
      Search settings
    </span>
    <div class="relative mt-2">
      <input
        id={`${uid}-input`}
        data-search-shortcut
        type="search"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listboxId}
        aria-activedescendant={activeResult ? optionId(activeResult) : undefined}
        bind:value={query}
        oninput={openIfResults}
        onfocus={openIfResults}
        onkeydown={onKeydown}
        placeholder="Jump to a setting or section — press / to focus"
        class="w-full rounded-xl border border-bark-300 bg-bark-50 px-3 py-2 text-sm text-shadow-900 outline-none transition-colors placeholder:text-shadow-400 focus:border-gold-400 focus:ring-2 focus:ring-gold-300"
      />
    </div>
  </label>

  {#if expanded}
    <ul
      id={listboxId}
      role="listbox"
      aria-label="Settings search results"
      class="absolute z-30 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-bark-300 bg-bark-50 py-1 shadow-lg"
    >
      {#each results as result, index (settingsSearchResultKey(result))}
        <li
          id={optionId(result)}
          role="option"
          aria-selected={index === activeIndex}
          onmousedown={(event) => {
            // Keep focus on the input; select on the same gesture.
            event.preventDefault();
            selectResult(result);
          }}
          onmouseenter={() => (activeIndex = index)}
          class="cursor-pointer px-3 py-2 text-sm transition-colors
            {index === activeIndex ? 'bg-gold-50' : 'hover:bg-bark-100'}"
        >
          {#if result.kind === 'section'}
            <div class="flex items-baseline justify-between gap-2">
              <span class="font-medium text-shadow-900">{result.title}</span>
              <span class="shrink-0 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-shadow-400">
                Section
              </span>
            </div>
            {#if result.description}
              <p class="mt-0.5 text-xs text-shadow-500">{result.description}</p>
            {/if}
          {:else}
            <div class="flex items-baseline justify-between gap-2">
              <span class="font-medium text-shadow-900">{result.fieldLabel}</span>
              <span class="shrink-0 font-mono text-[0.7rem] text-shadow-400">{result.fieldKey}</span>
            </div>
            <p class="mt-0.5 text-xs text-shadow-500">in {result.sectionTitle}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
