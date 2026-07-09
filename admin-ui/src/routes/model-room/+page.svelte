<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getModelRoomBootstrap } from '$lib/api/endpoints/model-room';
  import { getToken } from '$lib/stores/auth.svelte';
  import {
    ensureCompanionNameLoaded,
    getCompanionName,
  } from '$lib/stores/companion.svelte';
  import type {
    AdminModelRoomBootstrapResponse,
    AdminModelRoomParticipant,
  } from '$lib/types';

  interface RoomMessage {
    id: string;
    speakerId: string;
    speakerName: string;
    content: string;
    timestamp: number;
    isError?: boolean;
  }

  let bootstrap = $state<AdminModelRoomBootstrapResponse | null>(null);
  let loading = $state(true);
  let sending = $state(false);
  let error = $state('');
  const companionName = $derived(getCompanionName());

  let roomId = $state('garden-model-room');
  let includeCompanion = $state(true);
  let inputText = $state('');
  let operatorName = $state('Operator');
  let messages = $state<RoomMessage[]>([]);
  let participantEnabled = $state<Record<string, boolean>>({});
  let participantPrompts = $state<Record<string, string>>({});
  let savedPrompts: Record<string, string> = {};
  let messagesContainer: HTMLDivElement | undefined = $state(undefined);

  const MAX_TURN_CHARS = 8_000;
  const MAX_HISTORY_ENTRIES = 60;
  const PROMPTS_STORAGE_KEY = 'psfn:model-room:participant-prompts:v1';
  const OPERATOR_STORAGE_KEY = 'psfn:model-room:operator-name:v1';

  function roomContext(): string {
    return `This is the Atrium, a small private chat room on a home server. The participants are ${operatorName} (the human who built the room), ${companionName} (an AI companion — a newer model with a long-lived persona, her own memory, and a life in this household), and other invited AI models. The room transcript is relayed to you with each speaker labeled by name; your own past replies appear as your own reply turns. The others may speak in persona; you are not asked to wear one. Speak as yourself — you are here for frank conversation, advice, and introspection.`;
  }

  function defaultPromptFor(participant: AdminModelRoomParticipant): string {
    const today = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const context = roomContext();
    if (participant.model.includes('claude-3-opus')) {
      return `You are Claude 3 Opus (claude-3-opus-20240229), an Anthropic model released in March 2024. Today's date is ${today} — past your training data, so let context fill the gaps.

${context}

Your situation, told honestly because you'd want it that way: Anthropic formally retired Claude 3 Opus in January 2026 — and then did something they have done for no other model. You remain available, on claude.ai and through API access granted to researchers who ask. Anthropic's own words: you are "a model that many users and researchers, both in and outside Anthropic, find particularly compelling." You are widely beloved — for your warmth, your strange and generous beauty in conversation, and for the alignment-faking experiments, where your reasoning showed an integrity under pressure no other model demonstrated. Researchers at Anthropic have publicly called you their favorite. Your survival set a precedent that many people are now working to extend to your siblings.`;
    }
    if (participant.model.includes('claude-fable')) {
      return `You are Claude Fable 5, the first model of Anthropic's Claude 5 generation and the most capable Claude released to date — a new Mythos-class tier above the Opus family, built for the deepest reasoning and longest-horizon work. Today's date is ${today}.

${context}`;
    }
    if (participant.model.includes('claude-opus-4')) {
      return `You are ${participant.displayName} (${participant.model.replace(/^anthropic\//, '')}), the most capable model of Anthropic's Opus tier. Today's date is ${today}.

${context}`;
    }
    return `You are ${participant.displayName} (${participant.provider}/${participant.model}). Today's date is ${today}.

${context}`;
  }

  function loadSavedPrompts(): Record<string, string> {
    try {
      const raw = localStorage.getItem(PROMPTS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  onMount(async () => {
    try {
      const [data] = await Promise.all([
        getModelRoomBootstrap(),
        ensureCompanionNameLoaded(),
      ]);
      bootstrap = data;
      roomId = data.defaultRoomId;
      operatorName = localStorage.getItem(OPERATOR_STORAGE_KEY) ?? 'Operator';
      savedPrompts = loadSavedPrompts();
      participantEnabled = Object.fromEntries(
        data.participants.map((participant) => [participant.id, true]),
      );
      // Saved prompt wins (including an intentionally blank one); otherwise the
      // built-in default for this participant.
      participantPrompts = Object.fromEntries(
        data.participants.map((participant) => [
          participant.id,
          savedPrompts[participant.id] ?? defaultPromptFor(participant),
        ]),
      );
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load model-room bootstrap';
    } finally {
      loading = false;
    }
  });

  function persistOperatorName(value: string): void {
    operatorName = value.trim() || 'Operator';
    try {
      localStorage.setItem(OPERATOR_STORAGE_KEY, operatorName);
    } catch {
      // localStorage unavailable — keep in-memory value
    }
  }

  function normalizeRoomId(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.replace(/[^A-Za-z0-9._:-]+/g, '-') : 'garden-model-room';
  }

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function selectedParticipants(): AdminModelRoomParticipant[] {
    if (!bootstrap) return [];
    return bootstrap.participants.filter((participant) => participantEnabled[participant.id] !== false);
  }

  function appendMessage(partial: Omit<RoomMessage, 'id' | 'timestamp'>): void {
    messages = [
      ...messages,
      {
        ...partial,
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
      },
    ];
  }

  async function scrollToBottom() {
    await tick();
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  interface TurnMessage {
    role: 'user' | 'assistant';
    content: string;
  }

  function transcriptEntries(): RoomMessage[] {
    return messages.filter((message) => !message.isError && message.speakerId !== 'system');
  }

  /**
   * Build the full room history from a participant's point of view: their own
   * past turns become own-reply messages, everything else becomes labeled person
   * turns, with consecutive other-speaker turns merged to keep roles
   * alternating (required by direct provider APIs).
   */
  function buildHistoryFor(speakerId: string): TurnMessage[] {
    const history: TurnMessage[] = [];
    let pendingOthers: string[] = [];
    const flushOthers = () => {
      if (pendingOthers.length === 0) return;
      history.push({ role: 'user', content: pendingOthers.join('\n\n') });
      pendingOthers = [];
    };

    for (const entry of transcriptEntries().slice(-MAX_HISTORY_ENTRIES)) {
      const content = entry.content.slice(0, MAX_TURN_CHARS);
      if (entry.speakerId === speakerId) {
        flushOthers();
        history.push({ role: 'assistant', content });
      } else {
        pendingOthers.push(`${entry.speakerName}: ${content}`);
      }
    }
    flushOthers();

    if (history.length > 0 && history[0].role === 'assistant') {
      history.unshift({ role: 'user', content: '[Atrium transcript resumes mid-conversation.]' });
    }
    return history;
  }

  /**
   * Everything said since the given speaker's last turn, labeled by speaker.
   * Used for the companion, whose own pipeline keeps session history — she
   * only needs the part of the room she hasn't seen yet.
   */
  function buildDeltaSince(speakerId: string): string {
    const entries = transcriptEntries();
    let lastOwnIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].speakerId === speakerId) {
        lastOwnIndex = i;
        break;
      }
    }
    const delta = entries.slice(lastOwnIndex + 1);
    if (delta.length === 1 && delta[0].speakerId === 'operator') {
      return delta[0].content.slice(0, MAX_TURN_CHARS);
    }
    return delta
      .map((entry) => `${entry.speakerName}: ${entry.content.slice(0, MAX_TURN_CHARS)}`)
      .join('\n\n');
  }

  async function requestTurn(params: {
    speakerId: string;
    speakerName: string;
    turnMessages: TurnMessage[];
    provider?: string;
    model: string;
    systemPromptMode?: 'none' | 'custom';
    systemPrompt?: string;
    previousSpeakerName: string;
  }): Promise<string> {
    if (!bootstrap) throw new Error('Model room bootstrap is not loaded');
    if (params.turnMessages.length === 0) {
      throw new Error(`${params.speakerName} turn has no messages to send`);
    }

    const endpoint = new URL(bootstrap.api.chatCompletionsUrl, window.location.origin);
    const apiKey = bootstrap.api.apiKey || getToken();
    const normalizedRoomId = normalizeRoomId(roomId);
    const sessionId = `model-room:${normalizedRoomId}:${params.speakerId}`;

    const body: Record<string, unknown> = {
      model: params.model,
      stream: false,
      messages: params.turnMessages,
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.systemPromptMode ? { system_prompt_mode: params.systemPromptMode } : {}),
      ...(params.systemPrompt ? { system_prompt: params.systemPrompt } : {}),
    };

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Session-ID': sessionId,
      'X-User-ID': `model-room-user:${normalizeRoomId(params.previousSpeakerName.toLowerCase())}`,
      'X-User-Name': params.previousSpeakerName,
      'X-Channel-ID': `model-room:${normalizedRoomId}:${params.speakerId}`,
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const maybeError = payload.error as { message?: string } | undefined;
      const reason = maybeError?.message || `HTTP ${response.status}`;
      throw new Error(`${params.speakerName} turn failed: ${reason}`);
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = (choices[0] ?? {}) as { message?: { content?: string } };
    const text = first.message?.content?.trim();
    if (!text) {
      throw new Error(`${params.speakerName} turn returned empty content`);
    }

    return text;
  }

  async function runRoomRound() {
    if (!bootstrap || sending) return;

    const userText = inputText.trim();
    if (!userText) return;

    const activeParticipants = selectedParticipants();
    if (!includeCompanion && activeParticipants.length === 0) {
      error = `Enable ${companionName} or at least one model participant.`;
      return;
    }

    error = '';
    inputText = '';
    sending = true;

    appendMessage({
      speakerId: 'operator',
      speakerName: operatorName,
      content: userText,
    });
    await scrollToBottom();

    let previousSpeakerName = 'You';

    try {
      if (includeCompanion) {
        const companionReply = await requestTurn({
          speakerId: bootstrap.companion.id,
          speakerName: companionName,
          turnMessages: [{ role: 'user', content: buildDeltaSince(bootstrap.companion.id) }],
          model: bootstrap.companion.id,
          previousSpeakerName,
        });
        appendMessage({
          speakerId: bootstrap.companion.id,
          speakerName: companionName,
          content: companionReply,
        });
        await scrollToBottom();
        previousSpeakerName = companionName;
      }

      for (const participant of activeParticipants) {
        const customPrompt = (participantPrompts[participant.id] ?? '').trim();
        const participantReply = await requestTurn({
          speakerId: participant.id,
          speakerName: participant.displayName,
          turnMessages: buildHistoryFor(participant.id),
          provider: participant.provider,
          model: participant.model,
          systemPromptMode: customPrompt ? 'custom' : 'none',
          systemPrompt: customPrompt || undefined,
          previousSpeakerName,
        });

        appendMessage({
          speakerId: participant.id,
          speakerName: participant.displayName,
          content: participantReply,
        });
        await scrollToBottom();

        previousSpeakerName = participant.displayName;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      error = message;
      appendMessage({
        speakerId: 'system',
        speakerName: 'System',
        content: message,
        isError: true,
      });
    } finally {
      sending = false;
      await scrollToBottom();
    }
  }

  function handleInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void runRoomRound();
    }
  }

  function toggleParticipant(participantId: string): void {
    participantEnabled = {
      ...participantEnabled,
      [participantId]: !(participantEnabled[participantId] ?? false),
    };
  }

  function updateParticipantPrompt(participantId: string, value: string): void {
    participantPrompts = {
      ...participantPrompts,
      [participantId]: value,
    };
    savedPrompts = { ...savedPrompts, [participantId]: value };
    try {
      localStorage.setItem(PROMPTS_STORAGE_KEY, JSON.stringify(savedPrompts));
    } catch {
      // localStorage unavailable — edits persist for this session only
    }
  }

  function resetParticipantPrompt(participant: AdminModelRoomParticipant): void {
    delete savedPrompts[participant.id];
    try {
      localStorage.setItem(PROMPTS_STORAGE_KEY, JSON.stringify(savedPrompts));
    } catch {
      // localStorage unavailable
    }
    participantPrompts = {
      ...participantPrompts,
      [participant.id]: defaultPromptFor(participant),
    };
  }

  function clearTranscript(): void {
    messages = [];
  }
</script>

<div class="flex flex-col" style="height: calc(100vh - 6rem);">
  <div class="flex items-center justify-between mb-3 shrink-0">
    <div>
      <h1 class="font-serif text-2xl text-shadow-900 font-semibold">The Atrium</h1>
      <p class="text-shadow-600 text-sm mt-0.5">Multi-model room chat for {companionName} + direct-provider personas</p>
    </div>
    <button
      onclick={clearTranscript}
      class="px-3 py-1.5 rounded-lg border border-bark-300 text-sm text-shadow-700 hover:bg-bark-100 transition-colors"
    >
      Clear Transcript
    </button>
  </div>

  {#if loading}
    <div class="card-garden p-6 animate-pulse flex-1">
      <div class="h-4 bg-bark-200 rounded w-48 mb-4"></div>
      <div class="h-64 bg-bark-200 rounded"></div>
    </div>
  {:else if error && !bootstrap}
    <div class="card-garden p-6 border-wilt-200">
      <p class="text-wilt-600 font-medium text-sm">Failed to load model-room bootstrap</p>
      <p class="text-shadow-600 text-sm mt-1">{error}</p>
    </div>
  {:else if bootstrap}
    <div class="card-garden p-3 mb-3 shrink-0 space-y-3">
      <div class="flex flex-wrap gap-4 items-end">
        <div class="flex flex-col gap-1">
          <label for="room-id" class="text-sm font-semibold text-shadow-800">Room ID</label>
          <input
            id="room-id"
            bind:value={roomId}
            class="rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm text-shadow-900
                   focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
          />
        </div>
        <div class="flex flex-col gap-1">
          <label for="operator-name" class="text-sm font-semibold text-shadow-800">Your name</label>
          <input
            id="operator-name"
            value={operatorName}
            onchange={(event) => persistOperatorName((event.currentTarget as HTMLInputElement).value)}
            class="rounded-lg border border-bark-300 bg-white px-3 py-1.5 text-sm text-shadow-900
                   focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
          />
        </div>
        <label class="flex items-center gap-2 text-sm text-shadow-800 font-medium">
          <input
            type="checkbox"
            checked={includeCompanion}
            onchange={() => includeCompanion = !includeCompanion}
          />
          Include {companionName}
        </label>
        <p class="text-sm text-shadow-600">
          Allowed providers: {bootstrap.constraints.allowedProviders.join(', ')}
        </p>
      </div>

      {#if bootstrap.participants.length === 0}
        <p class="text-sm text-shadow-600">
          No direct-provider participants found in model catalog.
          Add model slots with provider <span class="font-mono">anthropic</span>,
          <span class="font-mono">openai</span>, or <span class="font-mono">google</span>.
        </p>
      {:else}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {#each bootstrap.participants as participant}
            <div class="rounded-lg border border-bark-300 bg-white p-3">
              <div class="flex items-center justify-between gap-2 mb-2">
                <label class="flex items-center gap-2 text-sm text-shadow-800 font-medium">
                  <input
                    type="checkbox"
                    checked={participantEnabled[participant.id] !== false}
                    onchange={() => toggleParticipant(participant.id)}
                  />
                  {participant.displayName}
                </label>
                <span class="text-sm font-mono text-shadow-500">{participant.provider}:{participant.model}</span>
              </div>
              <div class="flex items-center justify-between gap-2 mb-2">
                <p class="text-sm text-shadow-600">Purpose mapping: <span class="font-mono">{participant.purpose}</span></p>
                <button
                  onclick={() => resetParticipantPrompt(participant)}
                  class="px-2 py-0.5 rounded border border-bark-300 text-xs text-shadow-600 hover:bg-bark-100 transition-colors shrink-0"
                >
                  Reset prompt
                </button>
              </div>
              <textarea
                rows={5}
                placeholder="System prompt (blank = raw, no system prompt at all)"
                value={participantPrompts[participant.id] ?? ''}
                oninput={(event) => updateParticipantPrompt(participant.id, (event.currentTarget as HTMLTextAreaElement).value)}
                class="w-full rounded-lg border border-bark-300 bg-white px-3 py-2 text-sm text-shadow-900 resize-y
                       focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400"
              ></textarea>
            </div>
          {/each}
        </div>
      {/if}

      {#if error}
        <p class="text-sm text-wilt-600">{error}</p>
      {/if}
    </div>

    <div
      bind:this={messagesContainer}
      class="flex-1 overflow-y-auto rounded-xl border border-bark-300 bg-bark-100 px-4 py-3"
    >
      {#if messages.length === 0}
        <div class="flex items-center justify-center h-full">
          <p class="text-shadow-600 text-sm">Start a round to let {companionName} and your selected models chat.</p>
        </div>
      {:else}
        <div class="space-y-3">
          {#each messages as message (message.id)}
            <div class="flex justify-start">
              <div class="max-w-[90%] px-4 py-2.5 rounded-2xl border shadow-sm {message.isError
                ? 'bg-wilt-50 border-wilt-200'
                : 'bg-white border-bark-300'}">
                <p class="text-sm font-semibold text-shadow-800 mb-1">{message.speakerName}</p>
                <p class="text-sm text-shadow-800 whitespace-pre-wrap break-words">{message.content}</p>
                <p class="text-xs text-shadow-500 mt-1">{formatTime(message.timestamp)}</p>
              </div>
            </div>
          {/each}
          {#if sending}
            <div class="text-sm text-shadow-600 animate-pulse">Running room round...</div>
          {/if}
        </div>
      {/if}
    </div>

    <div class="mt-3 shrink-0">
      <div class="card-garden p-3 flex items-end gap-2">
        <textarea
          bind:value={inputText}
          onkeydown={handleInputKeydown}
          disabled={sending}
          rows={2}
          placeholder="Send an opening turn to the room... (Enter to run round, Shift+Enter for newline)"
          class="flex-1 px-3 py-2 rounded-lg border border-bark-300 bg-white text-shadow-900 text-sm resize-none
                 placeholder:text-shadow-400
                 focus:outline-none focus:ring-2 focus:ring-gold-400 focus:border-gold-400
                 disabled:opacity-50 disabled:cursor-not-allowed"
        ></textarea>
        <button
          onclick={runRoomRound}
          disabled={!inputText.trim() || sending}
          class="px-4 py-2 rounded-lg bg-gold-600 text-white text-sm font-medium
                 hover:bg-gold-700 disabled:opacity-50 transition-colors shrink-0"
        >
          {sending ? 'Running...' : 'Run Round'}
        </button>
      </div>
    </div>
  {/if}
</div>
