<script lang="ts">
  import type { IntakeL1RuleMatchProvenance } from '../../../../../src/shared/contracts/intake-rule-match.js';

  let {
    matches = [],
    unavailable = false,
    totalCount,
    truncated = false,
  }: {
    matches?: readonly IntakeL1RuleMatchProvenance[];
    unavailable?: boolean;
    totalCount?: number;
    truncated?: boolean;
  } = $props();
</script>

{#if unavailable}
  <p class="rounded border border-wilt-200 bg-wilt-50 px-2 py-1 text-xs text-wilt-700" role="alert">
    L1 rule-match provenance is unavailable. The item remains held and release is disabled; discard is still available.
  </p>
{:else if matches.length > 0}
  <div class="space-y-1" data-testid="l1-rule-match-provenance">
    <p class="text-sm text-shadow-800">
      <span class="font-medium text-shadow-700">L1 rules:</span>
      {#each matches as match (match.ruleId + match.startOffset + match.endOffset)}
        <code class="ml-1 inline-block rounded border border-gold-200 bg-gold-50 px-1.5 py-0.5 font-mono text-xs text-gold-800">{match.ruleId}</code>
      {/each}
    </p>
    <ul class="space-y-1">
      {#each matches as match (match.ruleId + match.startOffset + match.endOffset)}
        <li class="rounded border border-bark-200 bg-bark-50 px-2 py-1 text-xs text-shadow-700">
          <code class="font-mono">{match.kind} · {match.startOffset}..{match.endOffset}</code>
          <span class="ml-1 break-words">“{match.excerpt}”</span>
        </li>
      {/each}
    </ul>
    {#if truncated}
      <p class="text-xs text-gold-800">
        Showing {matches.length} of {totalCount ?? matches.length} rule matches; additional evidence omitted by the safety cap.
      </p>
    {/if}
  </div>
{/if}
