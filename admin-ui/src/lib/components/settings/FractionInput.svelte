<script lang="ts">
  /**
   * 0-1 fraction input. Canonical value is a number in [0, 1]. Renders a
   * numeric field, a slider, and a percent echo. Write-back only occurs for
   * finite values inside [0, 1]; out-of-range drafts never overwrite the
   * stored value.
   */
  let {
    value = $bindable(0),
    id,
    step = 0.05,
    class: className = '',
  }: {
    value: number;
    id?: string;
    step?: number;
    class?: string;
  } = $props();

  let draft = $state<number>(value);

  let lastEmitted = $state<number>(value);
  $effect(() => {
    if (value === lastEmitted) return;
    lastEmitted = value;
    draft = value;
  });

  function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
  }

  function commit(next: number): void {
    if (!Number.isFinite(next)) return;
    const clamped = clamp01(next);
    lastEmitted = clamped;
    value = clamped;
  }

  function onNumberInput(event: Event): void {
    const parsed = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(parsed)) return;
    draft = parsed;
    commit(draft);
  }

  function onRangeInput(event: Event): void {
    const parsed = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(parsed)) return;
    draft = parsed;
    commit(draft);
  }
</script>

<span class={`inline-flex items-center gap-2 ${className}`.trim()}>
  <input
    {id}
    type="number"
    class="input-garden w-24"
    value={draft}
    min="0"
    max="1"
    {step}
    oninput={onNumberInput}
  />
  <input
    type="range"
    aria-label="Fraction slider"
    class="w-28 accent-gold-500"
    min="0"
    max="1"
    {step}
    value={draft}
    oninput={onRangeInput}
  />
  <span class="text-xs text-shadow-500">{Math.round(clamp01(value) * 100)}%</span>
</span>
