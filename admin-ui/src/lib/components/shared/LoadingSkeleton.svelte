<script lang="ts">
  let { lines = 3, className = '' } = $props();
</script>

<div class="space-y-3 animate-pulse {className}">
  {#each Array(lines) as _, i}
    <div class="h-4 bg-bark-200 dark:bg-shadow-700 rounded" style="width: {85 - i * 15}%"></div>
  {/each}
</div>
