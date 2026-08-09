<script lang="ts">
  import type { AdminDashboardData } from '$lib/types';
  import { scopeGardenPath } from '$lib/fleet/companion-scope';

  let {
    traces,
    formatTokens,
    formatDuration,
  } = $props<{
    traces: AdminDashboardData['stats']['recentAnalysisWorkbenchTraces'];
    formatTokens: (value: number) => string;
    formatDuration: (value: number) => string;
  }>();
</script>

<section id="traces" aria-labelledby="traces-heading" class="card-garden scroll-mt-4 overflow-hidden">
  <div class="flex items-start justify-between gap-3 border-b border-bark-300 px-4 py-3 sm:px-5">
    <div>
      <h2 id="traces-heading" class="font-serif text-lg text-shadow-900">Recent analysis workbench traces</h2>
      <p class="mt-1 text-xs text-shadow-600">Latest {Math.min(10, traces.length)} live trace summaries.</p>
    </div>
    <a href={scopeGardenPath('/analysis-workbench')} class="whitespace-nowrap text-xs font-medium text-gold-700 hover:text-gold-800">
      View steps <span aria-hidden="true">→</span>
    </a>
  </div>

  {#if traces.length > 0}
    <div class="overflow-x-auto">
      <table class="w-full min-w-[720px] text-sm">
        <caption class="sr-only">Recent analysis workbench traces</caption>
        <thead>
          <tr class="text-left text-[11px] uppercase tracking-[0.08em] text-shadow-600">
            <th scope="col" class="py-2 pl-4 pr-3 font-medium sm:pl-5">Task</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">Iterations</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">Tokens</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">Duration</th>
            <th scope="col" class="py-2 pl-3 pr-4 text-right font-medium sm:pr-5">When</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-bark-200">
          {#each traces.slice(0, 10) as trace (`${trace.timestamp}:${trace.task}`)}
            <tr class="transition-colors hover:bg-bark-100">
              <td class="max-w-[26rem] py-3 pl-4 pr-3 sm:pl-5">
                <div class="flex items-start gap-2">
                  <span
                    class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full {trace.budgetStop ? 'bg-wilt-500' : trace.truncated ? 'bg-gold-500' : 'bg-moss-500'}"
                    aria-hidden="true"
                  ></span>
                  <span class="truncate text-shadow-800" title={trace.task}>{trace.task}</span>
                  {#if trace.budgetStop}
                    <span class="sr-only">Budget stopped: {trace.budgetStop}</span>
                  {:else if trace.truncated}
                    <span class="sr-only">Trace truncated</span>
                  {/if}
                </div>
              </td>
              <td class="px-3 py-3 text-right tabular-nums text-shadow-600">{trace.iterations}</td>
              <td class="px-3 py-3 text-right tabular-nums text-shadow-600">{formatTokens(trace.totalTokens)}</td>
              <td class="px-3 py-3 text-right tabular-nums text-shadow-600">{formatDuration(trace.durationMs)}</td>
              <td class="whitespace-nowrap py-3 pl-3 pr-4 text-right text-shadow-600 sm:pr-5">
                {new Date(trace.timestamp).toLocaleString()}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="px-5 py-8 text-center text-sm text-shadow-600">No recent analysis workbench traces are available.</p>
  {/if}
</section>
