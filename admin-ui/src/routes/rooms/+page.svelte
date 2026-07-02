<script lang="ts">
  import { onMount } from 'svelte';
  import {
    getRooms,
    getRoomRoster,
    type RoomSummary,
    type RoomRosterMember,
  } from '$lib/api/endpoints/rooms';
  import { pushToast } from '$lib/stores/toast.svelte';

  const ROSTER_PAGE_SIZE = 50;

  // ── State ──
  let rooms = $state<RoomSummary[]>([]);
  let roomsLoading = $state(true);
  let roomsError = $state('');

  let selected = $state<RoomSummary | null>(null);
  let members = $state<RoomRosterMember[]>([]);
  let rosterTotal = $state(0);
  let rosterOffset = $state(0);
  let rosterLoading = $state(false);
  let rosterError = $state('');

  function formatTimestamp(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  async function loadRooms() {
    roomsLoading = true;
    roomsError = '';
    try {
      const data = await getRooms();
      rooms = data.rooms;
    } catch (e) {
      roomsError = e instanceof Error ? e.message : 'Failed to load rooms';
    } finally {
      roomsLoading = false;
    }
  }

  async function loadRoster(room: RoomSummary, offset = 0) {
    selected = room;
    rosterOffset = offset;
    rosterLoading = true;
    rosterError = '';
    try {
      const data = await getRoomRoster(room.channelId, {
        channel: room.channel,
        limit: ROSTER_PAGE_SIZE,
        offset,
      });
      members = data.members;
      rosterTotal = data.total;
    } catch (e) {
      rosterError = e instanceof Error ? e.message : 'Failed to load roster';
      pushToast(rosterError, 'error');
    } finally {
      rosterLoading = false;
    }
  }

  function nextPage() {
    if (selected && rosterOffset + ROSTER_PAGE_SIZE < rosterTotal) {
      loadRoster(selected, rosterOffset + ROSTER_PAGE_SIZE);
    }
  }

  function prevPage() {
    if (selected && rosterOffset > 0) {
      loadRoster(selected, Math.max(0, rosterOffset - ROSTER_PAGE_SIZE));
    }
  }

  onMount(loadRooms);
</script>

<div class="space-y-6">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-serif font-bold text-shadow-900">Rooms</h1>
      <p class="text-sm text-shadow-600 mt-1">
        Known conversation channels and their rosters -- who has been seen where. Derived from
        channel activity; DATA only, never loaded into prompts.
      </p>
    </div>
    <button
      onclick={loadRooms}
      disabled={roomsLoading}
      class="text-sm px-3 py-1.5 rounded-lg border border-bark-300
             text-shadow-600 hover:bg-bark-100
             transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
    >
      {roomsLoading ? 'Loading...' : 'Refresh'}
    </button>
  </div>

  {#if roomsLoading && rooms.length === 0}
    <div class="card-garden p-6">
      <p class="text-sm text-shadow-600">Loading rooms...</p>
    </div>
  {:else if roomsError}
    <div class="card-garden p-6 border-l-4 border-l-wilt-400">
      <p class="text-sm text-shadow-800">{roomsError}</p>
    </div>
  {:else if rooms.length === 0}
    <div class="card-garden p-12 text-center">
      <p class="font-serif text-lg text-shadow-700 mb-1">No known rooms yet</p>
      <p class="text-sm text-shadow-600">
        Rooms appear here once tracked contacts have channel activity. Untracked speakers have no
        contact record and correctly do not appear.
      </p>
    </div>
  {:else}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Room list -->
      <div class="lg:col-span-1 space-y-2">
        {#each rooms as room (room.channel + ':' + room.channelId)}
          <button
            onclick={() => loadRoster(room)}
            class="w-full text-left card-garden px-4 py-3 transition-colors
                   {selected && selected.channelId === room.channelId && selected.channel === room.channel
                     ? 'border-l-4 border-l-moss-400 bg-bark-50'
                     : 'hover:bg-bark-50'}"
          >
            <div class="flex items-center justify-between">
              <code class="font-mono text-sm text-shadow-800 truncate">{room.channelId}</code>
              <span class="ml-2 shrink-0 inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-moss-100 text-moss-700">
                {room.memberCount} {room.memberCount === 1 ? 'member' : 'members'}
              </span>
            </div>
            <div class="mt-1 text-xs text-shadow-600">
              <span>{room.channel}</span>
              <span class="mx-1">&middot;</span>
              <span>last active {formatTimestamp(room.lastActivity)}</span>
            </div>
          </button>
        {/each}
      </div>

      <!-- Roster detail -->
      <div class="lg:col-span-2">
        {#if !selected}
          <div class="card-garden p-12 text-center">
            <p class="font-serif text-lg text-shadow-700 mb-1">Select a room</p>
            <p class="text-sm text-shadow-600">Choose a room to view its known-member roster.</p>
          </div>
        {:else}
          <div class="card-garden overflow-hidden">
            <div class="px-5 py-4 border-b border-bark-100 bg-bark-50 flex items-center justify-between">
              <div>
                <h3 class="text-base font-semibold text-shadow-900">Roster</h3>
                <code class="font-mono text-xs text-shadow-600">{selected.channel}:{selected.channelId}</code>
              </div>
              <span class="text-xs text-shadow-600">{rosterTotal} known {rosterTotal === 1 ? 'member' : 'members'}</span>
            </div>

            {#if rosterLoading && members.length === 0}
              <div class="p-6"><p class="text-sm text-shadow-600">Loading roster...</p></div>
            {:else if rosterError}
              <div class="p-6 border-l-4 border-l-wilt-400"><p class="text-sm text-shadow-800">{rosterError}</p></div>
            {:else if members.length === 0}
              <div class="p-8 text-center"><p class="text-sm text-shadow-600">No known members in this room.</p></div>
            {:else}
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="text-left text-shadow-600 border-b border-bark-100">
                      <th class="px-4 py-2 font-medium">Name</th>
                      <th class="px-4 py-2 font-medium">Trust</th>
                      <th class="px-4 py-2 font-medium">Relationship</th>
                      <th class="px-4 py-2 font-medium">First seen</th>
                      <th class="px-4 py-2 font-medium">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each members as member (member.contactId)}
                      <tr class="border-b border-bark-50 hover:bg-bark-50">
                        <td class="px-4 py-2 text-shadow-900 font-medium">{member.displayName}</td>
                        <td class="px-4 py-2 text-shadow-800">{member.trustLevel}</td>
                        <td class="px-4 py-2 text-shadow-800">{member.relationshipType}</td>
                        <td class="px-4 py-2 text-shadow-700">{formatTimestamp(member.firstSeen)}</td>
                        <td class="px-4 py-2 text-shadow-700">{formatTimestamp(member.lastSeen)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>

              {#if rosterTotal > ROSTER_PAGE_SIZE}
                <div class="px-5 py-3 border-t border-bark-100 flex items-center justify-between">
                  <span class="text-xs text-shadow-600">
                    Showing {rosterOffset + 1}-{Math.min(rosterOffset + members.length, rosterTotal)} of {rosterTotal}
                  </span>
                  <div class="flex gap-2">
                    <button
                      onclick={prevPage}
                      disabled={rosterOffset === 0 || rosterLoading}
                      class="text-sm px-3 py-1 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >Prev</button>
                    <button
                      onclick={nextPage}
                      disabled={rosterOffset + ROSTER_PAGE_SIZE >= rosterTotal || rosterLoading}
                      class="text-sm px-3 py-1 rounded-lg border border-bark-300 text-shadow-600 hover:bg-bark-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >Next</button>
                  </div>
                </div>
              {/if}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
