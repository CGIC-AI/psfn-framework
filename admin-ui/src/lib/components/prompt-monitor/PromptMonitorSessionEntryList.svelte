<script lang="ts">
  import type { SessionEntry } from '$lib/types';

  interface Props {
    title: string;
    entries?: SessionEntry[];
    emptyText?: string;
  }

  let {
    title,
    entries = [],
    emptyText = 'No entries recorded.',
  }: Props = $props();

  function formatTimestamp(value: number | string | undefined): string {
    const numeric = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
    if (!Number.isFinite(numeric)) return 'Unknown time';
    return new Date(numeric).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatSpeaker(entry: SessionEntry): string {
    return entry.authorName ?? entry.authorId ?? entry.role;
  }
</script>

<div class="rounded-xl border border-bark-200 bg-white p-4">
  <h3 class="font-medium text-shadow-900">{title}</h3>
  {#if entries.length === 0}
    <p class="mt-3 text-sm text-shadow-600">{emptyText}</p>
  {:else}
    <div class="mt-3 space-y-3">
      {#each entries as entry, index (`${entry.timestamp ?? 'unknown'}-${entry.role}-${index}`)}
        <div class="rounded-lg border border-bark-200 bg-bark-50 p-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-shadow-900">{formatSpeaker(entry)}</p>
              <p class="mt-0.5 text-xs uppercase tracking-wide text-shadow-600">{entry.role}</p>
            </div>
            <p class="text-xs text-shadow-600">{formatTimestamp(entry.timestamp)}</p>
          </div>
          <pre class="mt-2 overflow-auto whitespace-pre-wrap font-mono text-sm text-shadow-800">{entry.content}</pre>
        </div>
      {/each}
    </div>
  {/if}
</div>
