<script lang="ts">
  const untrustedHtml = '<img src=x onerror=alert(1)>';
</script>

<!-- ruleid: psfn.security.svelte-raw-html -->
<section>{@html untrustedHtml}</section>

<!-- ok: psfn.security.svelte-raw-html -->
<section>{untrustedHtml}</section>
