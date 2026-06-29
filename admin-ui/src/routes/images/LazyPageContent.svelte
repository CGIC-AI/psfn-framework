<script lang="ts">
  import { onMount } from 'svelte';
  import { listGeneratedImages, updateGeneratedImage } from '$lib/api/endpoints/images';
  import type { GeneratedImageView, GeneratedImagesResponse } from '$lib/api/endpoints/images';

  let data = $state<GeneratedImagesResponse | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');
  let filterTags = $state('');
  let filterSearch = $state('');
  let favoriteOnly = $state(false);
  let meaningfulOnly = $state(false);
  let tagDrafts = $state<Record<string, string>>({});
  let momentDrafts = $state<Record<string, string>>({});
  let savingIds = $state<Set<string>>(new Set());

  let images = $derived(data?.images ?? []);

  function splitTags(value: string): string[] {
    return value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function applyDrafts(nextImages: GeneratedImageView[]): void {
    const nextTagDrafts = { ...tagDrafts };
    const nextMomentDrafts = { ...momentDrafts };
    for (const image of nextImages) {
      if (nextTagDrafts[image.id] === undefined) nextTagDrafts[image.id] = image.tags.join(', ');
      if (nextMomentDrafts[image.id] === undefined) nextMomentDrafts[image.id] = image.meaningfulMoment?.note ?? '';
    }
    tagDrafts = nextTagDrafts;
    momentDrafts = nextMomentDrafts;
  }

  async function loadImages() {
    error = '';
    try {
      const response = await listGeneratedImages({
        tags: splitTags(filterTags),
        favorite: favoriteOnly ? true : undefined,
        meaningful: meaningfulOnly ? true : undefined,
        q: filterSearch,
      });
      data = response;
      applyDrafts(response.images);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load generated images';
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function refreshImages() {
    refreshing = true;
    await loadImages();
  }

  function setSaving(id: string, saving: boolean): void {
    const next = new Set(savingIds);
    if (saving) next.add(id);
    else next.delete(id);
    savingIds = next;
  }

  function updateLocalImage(image: GeneratedImageView): void {
    if (data) {
      data = {
        ...data,
        images: data.images.map((candidate) => candidate.id === image.id ? image : candidate),
      };
    }
    tagDrafts = { ...tagDrafts, [image.id]: image.tags.join(', ') };
    momentDrafts = { ...momentDrafts, [image.id]: image.meaningfulMoment?.note ?? '' };
  }

  async function saveImageUpdate(
    image: GeneratedImageView,
    input: Parameters<typeof updateGeneratedImage>[1],
  ): Promise<void> {
    setSaving(image.id, true);
    error = '';
    try {
      const response = await updateGeneratedImage(image.id, input);
      updateLocalImage(response.image);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to update generated image';
    } finally {
      setSaving(image.id, false);
    }
  }

  async function toggleFavorite(image: GeneratedImageView): Promise<void> {
    await saveImageUpdate(image, { favorite: !image.favorite });
  }

  async function saveTags(image: GeneratedImageView): Promise<void> {
    await saveImageUpdate(image, { tags: splitTags(tagDrafts[image.id] ?? '') });
  }

  async function saveMeaningfulMoment(image: GeneratedImageView): Promise<void> {
    await saveImageUpdate(image, {
      meaningfulMoment: {
        marked: true,
        note: momentDrafts[image.id] ?? '',
      },
      ...(image.conversation ? { conversation: image.conversation } : {}),
    });
  }

  async function clearMeaningfulMoment(image: GeneratedImageView): Promise<void> {
    await saveImageUpdate(image, { meaningfulMoment: { marked: false } });
  }

  function updateTagDraft(id: string, value: string): void {
    tagDrafts = { ...tagDrafts, [id]: value };
  }

  function updateMomentDraft(id: string, value: string): void {
    momentDrafts = { ...momentDrafts, [id]: value };
  }

  function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function imageLabel(image: GeneratedImageView): string {
    return image.sourceToolName || image.mode || image.provider || 'image';
  }

  function isSaving(image: GeneratedImageView): boolean {
    return savingIds.has(image.id);
  }

  onMount(() => {
    void loadImages();
  });
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <p class="text-xs uppercase tracking-[0.2em] text-shadow-500">The Gallery</p>
      <h1 class="mt-1 text-2xl font-serif font-bold text-shadow-900">Generated Images</h1>
      <p class="mt-1 text-sm text-shadow-600">{images.length} image{images.length === 1 ? '' : 's'}</p>
    </div>
    <button
      onclick={refreshImages}
      disabled={refreshing}
      class="rounded-xl border border-bark-300 px-3 py-2 text-sm font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {refreshing ? 'Refreshing...' : 'Refresh'}
    </button>
  </div>

  <div class="grid gap-3 border-y border-bark-300 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
    <label class="block text-sm font-medium text-shadow-700">
      Search
      <input
        class="mt-1 w-full rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900"
        value={filterSearch}
        oninput={(event) => filterSearch = (event.currentTarget as HTMLInputElement).value}
      />
    </label>
    <label class="block text-sm font-medium text-shadow-700">
      Tags
      <input
        class="mt-1 w-full rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900"
        value={filterTags}
        oninput={(event) => filterTags = (event.currentTarget as HTMLInputElement).value}
      />
    </label>
    <div class="flex flex-wrap items-end gap-3">
      <label class="flex h-10 items-center gap-2 rounded-lg border border-bark-300 px-3 text-sm font-medium text-shadow-700">
        <input type="checkbox" bind:checked={favoriteOnly} class="size-4 accent-moss-600" />
        Favorites
      </label>
      <label class="flex h-10 items-center gap-2 rounded-lg border border-bark-300 px-3 text-sm font-medium text-shadow-700">
        <input type="checkbox" bind:checked={meaningfulOnly} class="size-4 accent-moss-600" />
        Meaningful
      </label>
      <button
        onclick={() => void loadImages()}
        class="h-10 rounded-lg border border-gold-300 bg-gold-50 px-3 text-sm font-medium text-gold-800 transition-colors hover:bg-gold-100"
      >
        Apply
      </button>
    </div>
  </div>

  {#if error}
    <div class="card-garden border-l-4 border-l-wilt-400 p-4">
      <p class="text-sm font-medium text-wilt-700">{error}</p>
    </div>
  {/if}

  {#if loading}
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each Array(6) as _}
        <div class="card-garden overflow-hidden animate-pulse">
          <div class="aspect-[4/3] bg-bark-200"></div>
          <div class="space-y-2 p-4">
            <div class="h-4 w-2/3 rounded bg-bark-200"></div>
            <div class="h-3 w-1/2 rounded bg-bark-200"></div>
          </div>
        </div>
      {/each}
    </div>
  {:else if images.length === 0}
    <div class="card-garden p-8 text-center">
      <p class="text-sm text-shadow-600">No generated images found.</p>
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each images as image (image.id)}
        <article class="card-garden overflow-hidden">
          <a href={image.url} target="_blank" rel="noreferrer" class="block bg-bark-100">
            <img
              src={image.url}
              alt={image.prompt || image.fileName}
              class="aspect-[4/3] w-full object-contain"
              loading="lazy"
            />
          </a>
          <div class="space-y-3 p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold text-shadow-900">{image.fileName}</p>
                <p class="mt-0.5 text-xs text-shadow-500">{formatDate(image.createdAt)}</p>
              </div>
              <span class="shrink-0 rounded-full border border-gold-300 bg-gold-50 px-2 py-0.5 text-xs font-medium text-gold-700">
                {imageLabel(image)}
              </span>
            </div>

            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                aria-pressed={image.favorite}
                onclick={() => void toggleFavorite(image)}
                disabled={isSaving(image)}
                class="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 {image.favorite ? 'border-moss-300 bg-moss-50 text-moss-800' : 'border-bark-300 text-shadow-700 hover:bg-bark-100'}"
              >
                {image.favorite ? 'Favorited' : 'Favorite'}
              </button>
              <button
                type="button"
                aria-pressed={Boolean(image.meaningfulMoment)}
                onclick={() => image.meaningfulMoment ? void clearMeaningfulMoment(image) : void saveMeaningfulMoment(image)}
                disabled={isSaving(image)}
                class="rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 {image.meaningfulMoment ? 'border-gold-300 bg-gold-50 text-gold-800' : 'border-bark-300 text-shadow-700 hover:bg-bark-100'}"
              >
                {image.meaningfulMoment ? 'Meaningful' : 'Mark meaningful'}
              </button>
            </div>

            {#if image.prompt}
              <p class="line-clamp-3 text-sm leading-relaxed text-shadow-700">{image.prompt}</p>
            {/if}

            {#if image.tags.length > 0}
              <div class="flex flex-wrap gap-1.5">
                {#each image.tags as tag}
                  <span class="rounded-full bg-bark-100 px-2 py-0.5 text-xs font-medium text-shadow-700">{tag}</span>
                {/each}
              </div>
            {/if}

            <div class="space-y-2 border-t border-bark-300 pt-3">
              <label class="block text-xs font-medium text-shadow-600" for="tags-{image.id}">Tags</label>
              <div class="flex gap-2">
                <input
                  id="tags-{image.id}"
                  class="min-w-0 flex-1 rounded-lg border border-bark-300 bg-white px-2.5 py-1.5 text-sm text-shadow-900"
                  value={tagDrafts[image.id] ?? ''}
                  oninput={(event) => updateTagDraft(image.id, (event.currentTarget as HTMLInputElement).value)}
                />
                <button
                  type="button"
                  onclick={() => void saveTags(image)}
                  disabled={isSaving(image)}
                  class="rounded-lg border border-bark-300 px-2.5 py-1 text-xs font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>

            <div class="space-y-2">
              <label class="block text-xs font-medium text-shadow-600" for="moment-{image.id}">Moment</label>
              <textarea
                id="moment-{image.id}"
                rows="2"
                class="w-full resize-y rounded-lg border border-bark-300 bg-white px-2.5 py-1.5 text-sm text-shadow-900"
                value={momentDrafts[image.id] ?? ''}
                oninput={(event) => updateMomentDraft(image.id, (event.currentTarget as HTMLTextAreaElement).value)}
              ></textarea>
              <div class="flex justify-end gap-2">
                {#if image.meaningfulMoment}
                  <button
                    type="button"
                    onclick={() => void clearMeaningfulMoment(image)}
                    disabled={isSaving(image)}
                    class="rounded-lg border border-bark-300 px-2.5 py-1 text-xs font-medium text-shadow-700 transition-colors hover:bg-bark-100 disabled:opacity-50"
                  >
                    Clear
                  </button>
                {/if}
                <button
                  type="button"
                  onclick={() => void saveMeaningfulMoment(image)}
                  disabled={isSaving(image)}
                  class="rounded-lg border border-gold-300 bg-gold-50 px-2.5 py-1 text-xs font-medium text-gold-800 transition-colors hover:bg-gold-100 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>

            <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt class="text-shadow-500">Root</dt>
              <dd class="text-right font-medium text-shadow-700">{image.rootKind}</dd>
              <dt class="text-shadow-500">Size</dt>
              <dd class="text-right font-medium text-shadow-700">{formatBytes(image.sizeBytes)}</dd>
              {#if image.model}
                <dt class="text-shadow-500">Model</dt>
                <dd class="truncate text-right font-medium text-shadow-700">{image.model}</dd>
              {/if}
              {#if image.requestId}
                <dt class="text-shadow-500">Request</dt>
                <dd class="truncate text-right font-mono text-shadow-700">{image.requestId}</dd>
              {/if}
              {#if image.conversation?.turnId}
                <dt class="text-shadow-500">Turn</dt>
                <dd class="truncate text-right font-mono text-shadow-700">{image.conversation.turnId}</dd>
              {/if}
              {#if image.conversation?.channelId}
                <dt class="text-shadow-500">Channel</dt>
                <dd class="truncate text-right font-mono text-shadow-700">{image.conversation.channelId}</dd>
              {/if}
            </dl>

            {#if image.companionNoteRefs.length > 0}
              <div class="flex flex-wrap gap-1.5 border-t border-bark-300 pt-3">
                {#each image.companionNoteRefs as ref}
                  {#if ref.url}
                    <a href={ref.url} class="rounded-full bg-moss-50 px-2 py-0.5 text-xs font-medium text-moss-800 hover:bg-moss-100">{ref.label || ref.id}</a>
                  {:else}
                    <span class="rounded-full bg-moss-50 px-2 py-0.5 text-xs font-medium text-moss-800">{ref.label || ref.id}</span>
                  {/if}
                {/each}
              </div>
            {/if}

            <div class="flex items-center justify-between gap-2 border-t border-bark-300 pt-3">
              <span class="truncate text-xs font-mono text-shadow-500">{image.relativePath}</span>
              <div class="flex shrink-0 gap-2">
                {#if image.artifactRefs.find((ref) => ref.kind === 'shared_image' && ref.url)}
                  <a
                    href={image.artifactRefs.find((ref) => ref.kind === 'shared_image' && ref.url)?.url}
                    target="_blank"
                    rel="noreferrer"
                    class="rounded-lg border border-bark-300 px-2.5 py-1 text-xs font-medium text-shadow-700 transition-colors hover:bg-bark-100"
                  >
                    Source
                  </a>
                {/if}
                <a
                  href={image.url}
                  target="_blank"
                  rel="noreferrer"
                  class="rounded-lg border border-bark-300 px-2.5 py-1 text-xs font-medium text-shadow-700 transition-colors hover:bg-bark-100"
                >
                  Open
                </a>
              </div>
            </div>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
