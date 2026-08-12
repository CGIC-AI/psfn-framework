<script lang="ts">
  import {
    submitAutomataLessonProposal,
    type AutomataLessonGroup,
    type AutomataSnapshot,
  } from '$lib/api/endpoints/automata';

  let { lessons } = $props<{ lessons: AutomataSnapshot['lessons'] }>();

  let proposalGroupId = $state('');
  let proposalTargetKind = $state<'instruction' | 'tool'>('instruction');
  let proposalTargetId = $state('');
  let proposalBaseRevision = $state('');
  let proposalBefore = $state('');
  let proposalAfter = $state('');
  let proposalSubmitting = $state(false);
  let proposalMessage = $state('');
  let proposalError = $state('');

  function canPropose(group: AutomataLessonGroup): boolean {
    return group.support === 'supported'
      && group.evidenceQuality === 'verified'
      && !group.contradiction.present
      && !group.inferenceOnly
      && !group.sourceTraceTruncated;
  }

  function beginProposal(group: AutomataLessonGroup): void {
    proposalGroupId = group.groupId;
    proposalTargetKind = group.toolName === 'none' ? 'instruction' : 'tool';
    proposalTargetId = proposalTargetKind === 'tool' ? group.toolName : group.lessonCode;
    proposalBaseRevision = group.promptRevision;
    proposalBefore = '';
    proposalAfter = '';
    proposalMessage = '';
    proposalError = '';
  }

  async function submitProposal(group: AutomataLessonGroup): Promise<void> {
    proposalSubmitting = true;
    proposalMessage = '';
    proposalError = '';
    try {
      const receipt = await submitAutomataLessonProposal({
        kind: 'automata_lesson',
        groupId: group.groupId,
        target: {
          kind: proposalTargetKind,
          id: proposalTargetId,
          baseRevision: proposalBaseRevision,
        },
        before: proposalBefore,
        after: proposalAfter,
      });
      proposalMessage = `Pending governed review ${receipt.reviewId} created. No prompt or tool was changed.`;
    } catch (cause) {
      proposalError = cause instanceof Error ? cause.message : 'Failed to submit lesson proposal.';
    } finally {
      proposalSubmitting = false;
    }
  }
</script>

<section class="garden-section card-garden p-5" aria-labelledby="lessons-heading">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="page-kicker">Recurrent diagnostics</p>
      <h2 id="lessons-heading" class="text-lg font-semibold text-shadow-900">Instruction and tool lessons</h2>
      <p class="mt-1 text-sm text-shadow-600">Current attributed findings only. A cluster is a candidate pattern, never a verified defect.</p>
    </div>
    <span class="text-sm text-shadow-500">{lessons.sourceFindingCount} attributed sources</span>
  </div>

  {#if !lessons.available}
    <div class="garden-empty mt-4 border-l-4 border-l-gold-400 p-4">
      <p class="font-medium text-shadow-800">Lesson projection unavailable</p>
      <p class="mt-1 text-sm text-shadow-600">Reason: {lessons.degradationReason ?? 'source unavailable'}. No healthy or empty lesson state is inferred.</p>
    </div>
  {:else if lessons.groups.length === 0}
    <div class="garden-empty mt-4 p-5 text-sm text-shadow-600">No explicitly attributed current findings form a lesson yet.</div>
  {:else}
    <div class="mt-4 space-y-3">
      {#each lessons.groups as group (group.groupId)}
        <article class="rounded-xl border border-bark-200 p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div class="font-medium text-shadow-900">{group.lessonCode}</div>
              <div class="mt-1 font-mono text-xs text-shadow-500">{group.automatonClass} · {group.toolName} · {group.promptRevision}</div>
            </div>
            <div class="flex flex-wrap gap-2 text-xs">
              <span class="rounded bg-bark-100 px-2 py-1">{group.support}</span>
              <span class="rounded bg-bark-100 px-2 py-1">{group.evidenceQuality} evidence</span>
              {#if group.contradiction.present}<span class="rounded bg-gold-100 px-2 py-1 text-gold-800">contradictory</span>{/if}
              {#if group.inferenceOnly}<span class="rounded bg-gold-100 px-2 py-1 text-gold-800">inference only</span>{/if}
            </div>
          </div>
          <dl class="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div><dt class="text-xs text-shadow-500">Failure category</dt><dd>{group.failureCategory}</dd></div>
            <div><dt class="text-xs text-shadow-500">Current support</dt><dd>{group.sourceCount} finding{group.sourceCount === 1 ? '' : 's'}</dd></div>
            <div><dt class="text-xs text-shadow-500">Interpretation</dt><dd>Candidate pattern, not verified defect</dd></div>
          </dl>
          <details class="mt-3 text-sm">
            <summary class="cursor-pointer text-shadow-600">Redacted trace references</summary>
            <div class="mt-2 grid gap-3 md:grid-cols-2">
              <div><div class="text-xs font-medium text-shadow-500">Finding IDs</div>{#each group.sourceFindingIds as id}<div class="break-all font-mono text-xs">{id}</div>{/each}</div>
              <div><div class="text-xs font-medium text-shadow-500">Evidence digests</div>{#each group.evidenceIds as id}<div class="break-all font-mono text-xs">{id}</div>{/each}</div>
            </div>
          </details>
          <div class="mt-3">
            <button type="button" class="garden-action" disabled={!canPropose(group)} onclick={() => beginProposal(group)}>
              Prepare review-only diff
            </button>
            {#if !canPropose(group)}
              <span class="ml-2 text-xs text-shadow-500">Investigate low support, contradictions, inference-only evidence, or truncated traces first.</span>
            {/if}
          </div>

          {#if proposalGroupId === group.groupId}
            <div class="mt-4 rounded-xl bg-bark-50 p-4">
              <p class="text-sm font-medium text-shadow-800">Governed change proposal</p>
              <p class="mt-1 text-xs text-shadow-600">Submitting creates a pending CogSec and independent-review artifact. It never applies this diff.</p>
              <div class="mt-3 grid gap-3 md:grid-cols-3">
                <label class="text-xs font-medium">Target kind<select class="mt-1 w-full rounded border border-bark-300 bg-surface p-2" bind:value={proposalTargetKind}><option value="instruction">Instruction</option><option value="tool">Tool</option></select></label>
                <label class="text-xs font-medium">Target ID<input class="mt-1 w-full rounded border border-bark-300 bg-surface p-2" bind:value={proposalTargetId} /></label>
                <label class="text-xs font-medium">Base revision<input class="mt-1 w-full rounded border border-bark-300 bg-surface p-2" bind:value={proposalBaseRevision} /></label>
              </div>
              <div class="mt-3 grid gap-3 md:grid-cols-2">
                <label class="text-xs font-medium">Current content<textarea class="mt-1 min-h-28 w-full rounded border border-bark-300 bg-surface p-2 font-mono text-xs" bind:value={proposalBefore}></textarea></label>
                <label class="text-xs font-medium">Proposed content<textarea class="mt-1 min-h-28 w-full rounded border border-bark-300 bg-surface p-2 font-mono text-xs" bind:value={proposalAfter}></textarea></label>
              </div>
              <div class="mt-3 flex items-center gap-3">
                <button type="button" class="garden-action garden-action--primary" disabled={proposalSubmitting} onclick={() => submitProposal(group)}>{proposalSubmitting ? 'Submitting…' : 'Submit for governed review'}</button>
                <button type="button" class="garden-action" disabled={proposalSubmitting} onclick={() => { proposalGroupId = ''; }}>Cancel</button>
              </div>
              {#if proposalMessage}<p class="mt-3 text-sm text-moss-700" role="status">{proposalMessage}</p>{/if}
              {#if proposalError}<p class="mt-3 text-sm text-wilt-600" role="alert">{proposalError}</p>{/if}
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>
