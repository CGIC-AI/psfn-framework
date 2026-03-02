<script lang="ts">
  import type { IdentityConfirmationTone } from './identity-confirmation-flow';

  interface Props {
    open: boolean;
    title: string;
    body: string;
    context?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: IdentityConfirmationTone;
    busy?: boolean;
    onConfirm?: () => void;
    onCancel?: () => void;
  }

  let {
    open,
    title,
    body,
    context = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'primary',
    busy = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  function handleCancel() {
    if (busy) return;
    onCancel?.();
  }

  function handleConfirm() {
    if (busy) return;
    onConfirm?.();
  }

  function handleBackdropClick(event: MouseEvent) {
    event.preventDefault();
    handleCancel();
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (!open || busy) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      handleCancel();
    }
  }

  let confirmButtonClasses = $derived.by(() => {
    if (tone === 'danger') {
      return 'bg-wilt-600 hover:bg-wilt-700 focus:ring-wilt-300';
    }
    return 'bg-gold-600 hover:bg-gold-700 focus:ring-gold-300';
  });
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <button
      type="button"
      class="absolute inset-0 bg-shadow-900/45"
      aria-label="Cancel confirmation dialog"
      onclick={handleBackdropClick}
      disabled={busy}
    ></button>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="identity-confirmation-title"
      class="relative w-full max-w-xl rounded-xl border border-bark-300 bg-white shadow-2xl"
    >
      <div class="p-5 border-b border-bark-200">
        <h2 id="identity-confirmation-title" class="text-lg font-serif font-semibold text-shadow-900">{title}</h2>
      </div>
      <div class="p-5 space-y-3">
        <p class="text-sm text-shadow-800 leading-relaxed">{body}</p>
        {#if context}
          <p class="text-sm text-shadow-700 bg-bark-100 border border-bark-200 rounded-lg px-3 py-2 break-words">{context}</p>
        {/if}
      </div>
      <div class="p-5 border-t border-bark-200 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button
          type="button"
          onclick={handleCancel}
          disabled={busy}
          class="px-4 py-2 rounded-lg border border-bark-300 text-shadow-700 hover:bg-bark-100 transition-colors
            focus:outline-none focus:ring-2 focus:ring-bark-300 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onclick={handleConfirm}
          disabled={busy}
          class={`px-4 py-2 rounded-lg text-white font-medium transition-colors focus:outline-none focus:ring-2 ${confirmButtonClasses}
            disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
