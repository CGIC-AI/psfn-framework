<script lang="ts">
  import ConfirmationModal from './ConfirmationModal.svelte';
  import {
    beginJournalPrivacyBreakGlass,
    decideJournalPrivacyBreakGlass,
    type JournalPrivacyBreakGlassConfirmation,
    type JournalPrivacyDisclosure,
    type JournalPrivacyStream,
  } from '$lib/api/endpoints/values';
  import type { PrivacyBreakGlassReasonCategory } from '../../../../src/shared/contracts/privacy-break-glass.js';

  interface Props {
    stream: JournalPrivacyStream;
    streamLabel: string;
    onDisclosure: (disclosure: JournalPrivacyDisclosure) => void;
  }

  const REASON_OPTIONS: ReadonlyArray<{
    value: PrivacyBreakGlassReasonCategory;
    label: string;
  }> = [
    { value: 'incident_response', label: 'Incident response' },
    { value: 'safety_intervention', label: 'Safety intervention' },
    { value: 'data_repair', label: 'Data repair' },
    { value: 'legal_emergency', label: 'Legal emergency' },
  ];

  let { stream, streamLabel, onDisclosure }: Props = $props();
  let reasonCategory = $state<PrivacyBreakGlassReasonCategory>('safety_intervention');
  let reason = $state('');
  let pending = $state<JournalPrivacyBreakGlassConfirmation | null>(null);
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
      pending = await beginJournalPrivacyBreakGlass({ stream, reasonCategory, reason });
      statusMessage = 'Audited confirmation issued. Review the exact disclosure before continuing.';
    } catch (cause) {
      pending = null;
      error = `No journal was disclosed. ${errorText(cause)}`;
    } finally {
      busy = false;
    }
  }

  function cancelConfirmation(): void {
    pending = null;
    statusMessage = 'Confirmation cancelled. No journal was disclosed.';
  }

  async function confirmDisclosure(): Promise<void> {
    const confirmation = pending;
    if (!confirmation) return;
    // The UI consumes its local handle before the request. The server remains
    // authoritative for single-use, expiry, principal, route, and origin.
    pending = null;
    busy = true;
    error = '';
    statusMessage = '';
    try {
      const disclosure = await decideJournalPrivacyBreakGlass(confirmation);
      onDisclosure(disclosure);
      reason = '';
      statusMessage = 'One-time audited disclosure loaded. No standing journal access was created.';
    } catch (cause) {
      error = `No journal was disclosed. The confirmation may be denied, expired, or already used. ${errorText(cause)}`;
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
      {streamLabel} is companion-private. Reading it requires an exact-target, single-use,
      audited disclosure; ordinary admin sign-in does not unlock it.
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
        placeholder="State the concrete emergency, safety, or repair need."
        class="resize-y rounded-lg border border-bark-300 bg-bark-50 px-3 py-2 text-sm normal-case tracking-normal text-shadow-800"
      ></textarea>
    </label>
    <button
      type="submit"
      disabled={busy || !reason.trim()}
      class="rounded-lg bg-wilt-600 px-4 py-2 text-sm font-medium text-white hover:bg-wilt-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Requesting…' : 'Request audited confirmation'}
    </button>
  </form>

  {#if error}
    <p class="mt-3 text-sm text-wilt-700" role="alert">{error}</p>
  {:else if statusMessage}
    <p class="mt-3 text-sm text-shadow-700" aria-live="polite">{statusMessage}</p>
  {/if}
</section>

<ConfirmationModal
  open={pending !== null}
  title="Confirm companion-private journal disclosure?"
  body={`This discloses one bounded snapshot of ${streamLabel}. The authorization is single-use and does not unlock other journal views.`}
  context={pending ? `Exact stream: ${pending.stream}. Confirmation expires: ${pending.expiresAt}.` : ''}
  confirmLabel="Disclose exact journal"
  cancelLabel="Keep private"
  tone="danger"
  {busy}
  onConfirm={() => void confirmDisclosure()}
  onCancel={cancelConfirmation}
/>
