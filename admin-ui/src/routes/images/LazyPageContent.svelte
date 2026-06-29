<script lang="ts">
  import { onMount } from 'svelte';
  import { listGeneratedImages } from '$lib/api/endpoints/images';
  import type { GeneratedImageView, GeneratedImagesResponse } from '$lib/api/endpoints/images';

  let data = $state<GeneratedImagesResponse | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let error = $state('');

  let images = $derived(data?.images ?? []);

  async function loadImages() {
    error = '';
    try {
      data = await listGeneratedImages();
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

            {#if image.prompt}
              <p class="line-clamp-3 text-sm leading-relaxed text-shadow-700">{image.prompt}</p>
            {/if}

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
            </dl>

            <div class="flex items-center justify-between gap-2 border-t border-bark-300 pt-3">
              <span class="truncate text-xs font-mono text-shadow-500">{image.relativePath}</span>
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
        </article>
      {/each}
    </div>
  {/if}
</div>
