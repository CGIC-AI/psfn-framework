<script lang="ts">
  let { variant = 'default', size = 'sm', children } = $props();

  const variants: Record<string, string> = {
    default: 'bg-bark-100 text-bark-700 dark:bg-shadow-800 dark:text-shadow-300',
    gold: 'bg-gold-100 text-gold-800 dark:bg-gold-900/30 dark:text-gold-300',
    moss: 'bg-moss-100 text-moss-800 dark:bg-moss-900/30 dark:text-moss-300',
    petal: 'bg-petal-100 text-petal-800 dark:bg-petal-900/30 dark:text-petal-300',
    wilt: 'bg-wilt-100 text-wilt-800 dark:bg-wilt-900/30 dark:text-wilt-300',
    shadow: 'bg-shadow-100 text-shadow-700 dark:bg-shadow-800 dark:text-shadow-300',
  };

  const sizes: Record<string, string> = {
    xs: 'px-1.5 py-0.5 text-[10px]',
    sm: 'px-2 py-0.5 text-[11px]',
    md: 'px-2.5 py-1 text-xs',
  };
</script>

<span class="inline-flex items-center rounded-full font-medium {variants[variant] || variants.default} {sizes[size] || sizes.sm}">
  {@render children()}
</span>
