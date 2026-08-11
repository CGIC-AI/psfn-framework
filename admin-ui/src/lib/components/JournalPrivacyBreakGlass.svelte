<script lang="ts">
  import ConfirmationModal from './ConfirmationModal.svelte';
  import {
    beginJournalPrivacyBreakGlass,
    decideJournalPrivacyBreakGlass,
    type JournalPrivacyBreakGlassConfirmation,
    type JournalPrivacyDisclosure,
    type JournalPrivacyTarget,
  } from '$lib/api/endpoints/values';
  import type { PrivacyBreakGlassReasonCategory } from '../../../../src/shared/contracts/privacy-break-glass.js';

  interface Props {
    targets: readonly JournalPrivacyTarget[];
    onDisclosure: (disclosure: JournalPrivacyDisclosure) => void;
  }

  const REASON_OPTIONS: ReadonlyArray<{
    value: PrivacyBreakGlassReasonCategory;
    label: string;
  }> = [
    { value: 'incident_response', label: 'Incident response' },
    { value: 'safety_intervention', label: 'Safety intervention' },
    { value: 'data_repair', label: 'Data repair' },
    { value: 'research_check', label: 'Research check' },
  ];

  let { targets, onDisclosure }: Props = $props();
  let reasonCategory = $state<PrivacyBreakGlassReasonCategory>('research_check');
  let reason = $state('');
  let pending = $state<JournalPrivacyBreakGlassConfirmation[]>([]);
  let busy = $state(false);
  let error = $state('');
  let statusMessage = $state('');

  function errorText(value: unknown): string {
    return value instanceof Error ? value.message : 'Privacy break-glass was denied';
  }

  async function requestConfirmation(): Promise<void> {
    busy = true;
    error = '';
    statusMessage = '';
    try {
      const confirmations: JournalPrivacyBreakGlassConfirmation[] = [];
      for (const target of targets) {
        confirmations.push(await beginJournalPrivacyBreakGlass({
          stream: target.stream,
          reasonCategory,
          reason,
        }));
      }
      pending = confirmations;
      statusMessage = 'Audited confirmations issued. Review the journal-session disclosure before continuing.';
    } catch (cause) {
      pending = [];
      error = `No journal bodies were disclosed. ${errorText(cause)}`;
    } finally {
      busy = false;
    }
  }

  function cancelConfirmation(): void {
    pending = [];
    statusMessage = 'Confirmation cancelled. No journal bodies were disclosed.';
  }

  async function confirmDisclosure(): Promise<void> {
    const confirmations = pending;
    if (confirmations.length === 0) return;
    // The UI consumes its local handle before the request. The server remains
    // authoritative for single-use, expiry, principal, route, and origin.
    pending = [];
    busy = true;
    error = '';
    statusMessage = '';
    let disclosedCount = 0;
    try {
      for (const confirmation of confirmations) {
        const disclosure = await decideJournalPrivacyBreakGlass(confirmation);
        onDisclosure(disclosure);
        disclosedCount += 1;
      }
      reason = '';
      statusMessage = 'All journal views are unlocked for this browser session.';
    } catch (cause) {
      error = `${String(disclosedCount)} of ${String(confirmations.length)} journal views were unlocked. Retry once for any remaining view. ${errorText(cause)}`;
    } finally {
      busy = false;
    }
  }
</script>

<section class="card-garden border-l-4 border-l-wilt-400 p-5" aria-labelledby="journal-privacy-title">
  <div class="space-y-2">
    <h2 id="journal-privacy-title" class="font-serif text-lg font-semibold text-shadow-900">
      Privacy break-glass required
    </h2>
    <p class="text-sm text-shadow-700">
      Journal bodies are companion-private. One reason and one confirmation unlock all journal
      views for this browser session; each exact stream remains separately audited on the server.
    </p>
    <p class="text-xs text-shadow-600">
      Views: {targets.map(target => target.label).join(', ')}.
    </p>
  </div>

  <form class="mt-4 grid gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-end" onsubmit={(event) => {
    event.preventDefault();
    void requestConfirmation();
  }}>
    <label class="grid gap-1 text-xs font-medium uppercase tracking-wide text-shadow-600">
      Reason category
      <select
        bind:value={reasonCategory}
        disabled={busy}
        class="rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm normal-case tracking-normal text-shadow-800"
      >
        {#each REASON_OPTIONS as option}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>
    <label class="grid gap-1 text-xs font-medium uppercase tracking-wide text-shadow-600" for="privacy-break-glass-reason">
      Audited reason
      <textarea
        id="privacy-break-glass-reason"
        bind:value={reason}
        maxlength="384"
        rows="2"
        required
        disabled={busy}
        placeholder="State the concrete research, safety, incident, or repair purpose."
        class="resize-y rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm normal-case tracking-normal text-shadow-800"
      ></textarea>
    </label>
    <button
      type="submit"
      disabled={busy || !reason.trim()}
      class="rounded-lg bg-wilt-600 px-4 py-2 text-sm font-medium text-white hover:bg-wilt-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Requesting…' : 'Unlock all journal views'}
    </button>
  </form>

  {#if error}
    <p class="mt-3 text-sm text-wilt-700" role="alert">{error}</p>
  {:else if statusMessage}
    <p class="mt-3 text-sm text-shadow-700" aria-live="polite">{statusMessage}</p>
  {/if}
</section>

<ConfirmationModal
  open={pending.length > 0}
  title="Unlock all companion-private journal views?"
  body={`This loads ${pending.length} separately audited journal snapshots into this browser session. It does not create standing server access.`}
  context={pending.length > 0 ? `Exact streams: ${pending.map(item => item.stream).join(', ')}. Earliest confirmation expires: ${pending[0]?.expiresAt}.` : ''}
  confirmLabel="Unlock journal session"
  cancelLabel="Keep private"
  tone="danger"
  {busy}
  onConfirm={() => void confirmDisclosure()}
  onCancel={cancelConfirmation}
/>
