<script lang="ts">
  import type { ActionPipeStatus } from '$lib/api/endpoints/action-pipe';
  import { formatTime, shortRef, stateClass } from './action-pipe-helpers';

  type Notification = NonNullable<ActionPipeStatus['taskLifecycleNotifications']>[number];

  let { notifications }: { notifications: Notification[] } = $props();
</script>

<section class="space-y-4" aria-labelledby="task-lifecycle-notifications-heading">
  <div>
    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-shadow-500">Partner updates</p>
    <h2 id="task-lifecycle-notifications-heading" class="mt-1 text-lg font-serif font-semibold text-shadow-900">
      Long-running task lifecycle
    </h2>
    <p class="mt-1 text-sm text-shadow-600">
      Companion-authored updates routed through the proactive outbound privacy and rate-limit policy.
    </p>
  </div>
  {#if notifications.length === 0}
    <div class="card-garden p-5 text-sm text-shadow-600">No recent task lifecycle notifications.</div>
  {:else}
    <div class="grid gap-4 xl:grid-cols-2">
      {#each notifications.slice(0, 10) as notification (notification.actionId)}
        <article class="card-garden p-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="font-serif font-semibold text-shadow-900">{notification.taskLabel}</h3>
              <p class="mt-1 font-mono text-xs text-shadow-500">
                {notification.source} · {shortRef(notification.handoffId)}
              </p>
            </div>
            <span class="rounded-full border px-2.5 py-1 text-xs font-semibold {stateClass(notification.notificationStatus)}">
              {notification.notificationStatus}
            </span>
          </div>
          <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div><dt class="text-shadow-500">Lifecycle</dt><dd class="font-medium text-shadow-900">{notification.lifecycleStatus}</dd></div>
            <div><dt class="text-shadow-500">Recorded</dt><dd class="font-mono text-shadow-900">{formatTime(notification.recordedAt)}</dd></div>
          </dl>
          {#if notification.reason}
            <p class="mt-3 text-sm text-shadow-600">{notification.reason}</p>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>
