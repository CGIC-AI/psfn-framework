<script lang="ts">
  /**
   * Human-unit duration input. Canonical value is milliseconds; the control
   * displays an amount plus a unit (seconds / minutes / hours) and converts.
   * Write-back only occurs when the displayed pair converts to a finite ms
   * value inside [min, max]; an in-progress invalid draft never overwrites the
   * stored value.
   */
  const MS_PER_SECOND = 1000;
  const MS_PER_MINUTE = 60_000;
  const MS_PER_HOUR = 3_600_000;

  type Unit = 'seconds' | 'minutes' | 'hours';

  let {
    value = $bindable(0),
    id,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    class: className = '',
  }: {
    value: number;
    id?: string;
    min?: number;
    max?: number;
    class?: string;
  } = $props();

  function unitFactor(unit: Unit): number {
    if (unit === 'hours') return MS_PER_HOUR;
    if (unit === 'minutes') return MS_PER_MINUTE;
    return MS_PER_SECOND;
  }

  /** Pick the largest unit that renders ms as a whole number >= 1. */
  function defaultUnit(ms: number): Unit {
    if (ms >= MS_PER_HOUR && ms % MS_PER_HOUR === 0) return 'hours';
    if (ms >= MS_PER_MINUTE && ms % MS_PER_MINUTE === 0) return 'minutes';
    return 'seconds';
  }

  function amountFor(ms: number, unit: Unit): number {
    const factor = unitFactor(unit);
    const amount = ms / factor;
    return Number.isInteger(amount) ? amount : Number(amount.toFixed(3));
  }

  let unit = $state<Unit>(defaultUnit(value));
  let amount = $state<number>(amountFor(value, defaultUnit(value)));

  // External value changes (load, reset) re-derive the display pair.
  let lastEmitted = $state<number>(value);
  $effect(() => {
    if (value === lastEmitted) return;
    lastEmitted = value;
    unit = defaultUnit(value);
    amount = amountFor(value, unit);
  });

  function commit(nextAmount: number, nextUnit: Unit): void {
    const ms = Math.round(nextAmount * unitFactor(nextUnit));
    if (!Number.isFinite(ms) || ms < min || ms > max) return;
    lastEmitted = ms;
    value = ms;
  }

  function onAmountInput(event: Event): void {
    const parsed = Number((event.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(parsed)) return;
    amount = parsed;
    commit(amount, unit);
  }

  function onUnitChange(event: Event): void {
    const nextUnit = (event.currentTarget as HTMLSelectElement).value as Unit;
    // Re-render the SAME stored ms in the new unit; only commit if it stays integral-ish.
    unit = nextUnit;
    amount = amountFor(value, unit);
  }
</script>

<span class={`inline-flex items-center gap-1.5 ${className}`.trim()}>
  <input
    {id}
    type="number"
    class="input-garden w-24"
    value={amount}
    min={min / unitFactor(unit)}
    max={max / unitFactor(unit)}
    step="any"
    oninput={onAmountInput}
  />
  <select
    aria-label="Duration unit"
    class="rounded-lg border border-bark-300 bg-bark-50 px-2 py-1.5 text-sm text-shadow-800"
    value={unit}
    onchange={onUnitChange}
  >
    <option value="seconds">sec</option>
    <option value="minutes">min</option>
    <option value="hours">hr</option>
  </select>
  <span class="text-xs text-shadow-500">({value} ms)</span>
</span>
