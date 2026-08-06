<script lang="ts">
  interface Props {
    open: boolean;
    title: string;
    context: string;
    reason: string;
    busy?: boolean;
    onReasonChange?: (reason: string) => void;
    onConfirm?: () => void;
    onCancel?: () => void;
  }

  let {
    open,
    title,
    context,
    reason,
    busy = false,
    onReasonChange,
    onConfirm,
    onCancel,
  }: Props = $props();

  let reasonIsValid = $derived(reason.trim().length > 0);

  function cancel(): void {
    if (!busy) onCancel?.();
  }

  function confirm(): void {
    if (!busy && reasonIsValid) onConfirm?.();
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!open || busy || event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <button
      type="button"
      class="absolute inset-0 bg-black/45"
      aria-label="Cancel concern action"
      onclick={cancel}
      disabled={busy}
    ></button>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="concern-action-escalation-title"
      class="relative w-full max-w-xl rounded-xl border border-bark-300 bg-bark-50 shadow-2xl"
    >
      <div class="border-b border-bark-200 p-5">
        <h2 id="concern-action-escalation-title" class="text-lg font-serif font-semibold text-shadow-900">
          {title}
        </h2>
      </div>
      <div class="space-y-4 p-5">
        <p class="text-sm leading-relaxed text-shadow-800">
          State why this protected change is necessary, then run it once. The action click
          mints and immediately spends one single-use grant for only this exact target.
        </p>
        <p class="rounded-lg border border-bark-200 bg-bark-100 px-3 py-2 text-sm text-shadow-700 break-words">
          {context}
        </p>
        <label class="grid gap-1 text-xs font-medium uppercase tracking-wide text-shadow-600" for="concern-action-justification">
          Mandatory justification
          <textarea
            id="concern-action-justification"
            value={reason}
            oninput={(event) => onReasonChange?.((event.currentTarget as HTMLTextAreaElement).value)}
            maxlength="512"
            rows="3"
            required
            disabled={busy}
            placeholder="State why this exact concern action is necessary."
            class="resize-y rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm normal-case tracking-normal text-shadow-800 disabled:opacity-60"
          ></textarea>
        </label>
        <p class="text-xs text-shadow-600">
          The companion receives a content-free record of who acted, the protected category,
          the action, time, and this justification. A retry mints a fresh grant.
        </p>
      </div>
      <div class="flex flex-col-reverse gap-2 border-t border-bark-200 p-5 sm:flex-row sm:justify-end">
        <button
          type="button"
          onclick={cancel}
          disabled={busy}
          class="rounded-lg border border-bark-300 px-4 py-2 text-shadow-700 transition-colors hover:bg-bark-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Keep unchanged
        </button>
        <button
          type="button"
          onclick={confirm}
          disabled={busy || !reasonIsValid}
          class="rounded-lg bg-wilt-600 px-4 py-2 font-medium text-white transition-colors hover:bg-wilt-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Run exact action'}
        </button>
      </div>
    </div>
  </div>
{/if}
