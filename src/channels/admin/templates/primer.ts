export function primerPage(): string {
  return `
    <div class="primer-section">
      <p style="color:var(--text-muted);margin-bottom:1.5rem">
        This is your internal reference for understanding the knobs and dials of your substrate.
        Each setting shapes how you think, remember, and express yourself.
      </p>
    </div>

    <div class="card primer-section">
      <h3>Models</h3>
      <div class="primer-knob">
        <strong>Primary Model</strong>
        <p>The model that generates your conversational responses. This is your voice, your thinking engine.
        Larger models produce richer, more nuanced responses but cost more per turn.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Model</strong>
        <p>The model used for memory extraction — analyzing conversations after the fact to identify
        important facts worth remembering. Can be a different (often cheaper) model since it runs
        asynchronously and doesn't need to be your "voice."</p>
      </div>
      <div class="primer-knob">
        <strong>Provider</strong>
        <p>The API provider routing layer (usually "openrouter"). The LiteLLM proxy handles
        the actual routing — this tells it which provider namespace to use.</p>
      </div>
      <div class="primer-knob">
        <strong>Model Roster</strong>
        <p>Purpose-based model assignments: <strong>chat</strong> (conversation), <strong>background</strong>
        (extraction, maintenance), <strong>reasoning</strong> (deep thinking), <strong>longContext</strong>
        (large documents). Each slot specifies a model, provider, max tokens, and context window.
        Unassigned slots fall back along a chain: background→chat, reasoning→chat, longContext→chat.</p>
      </div>
      <div class="primer-knob">
        <strong>Model Catalog</strong>
        <p>A registry of available models with their capabilities and constraints. Used by the role assignment
        system to validate assignments. Populated automatically via model discovery from LiteLLM/OpenRouter.</p>
      </div>
      <div class="primer-knob">
        <strong>Provider Order</strong>
        <p>Preferred order of OpenRouter providers when multiple can serve the same model. Useful for
        prioritizing cheaper or faster providers. Example: <code>["DeepInfra", "Together", "Fireworks"]</code>.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Token Limits</h3>
      <div class="primer-knob">
        <strong>Primary Max Tokens</strong>
        <p>Maximum length of your responses in tokens (~4 chars each). Higher values let you
        be more verbose and thorough. Lower values force conciseness. Default: 16384 (~60K chars).</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Max Tokens</strong>
        <p>Maximum tokens for memory extraction responses. Usually doesn't need to be as high
        as primary since extraction outputs are structured XML. Default: 8192.</p>
      </div>
      <div class="primer-knob">
        <strong>Default Context Window</strong>
        <p>The assumed context window size for your primary model, in tokens. Used by the budgeting system
        to calculate how much space to allocate for memories, history, and system prompt. Default: 128,000.
        Set this to match your actual model's context window for accurate budgeting.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Context Budgeting</h3>
      <p style="color:var(--text-muted);margin-bottom:0.75rem">
        These percentages control how your context window is divided up. They work together —
        think of your context window as a garden bed with allocated plots.
      </p>
      <div class="primer-knob">
        <strong>Memory Budget %</strong>
        <p>What percentage of your context window to reserve for retrieved memories. Default: 20%.
        Higher values give you richer recall but leave less room for conversation history.</p>
      </div>
      <div class="primer-knob">
        <strong>Memory Retrieval Budget %</strong>
        <p>Percentage of the context budget dedicated to memory retrieval results specifically.
        Works alongside the memory budget to fine-tune how much context goes to memories vs other sources.</p>
      </div>
      <div class="primer-knob">
        <strong>Session History Budget %</strong>
        <p>Percentage of the context window for conversation history. Balances how much recent
        chat you see against room for memories and system prompt.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Threshold %</strong>
        <p>When session content exceeds this percentage of the context window, memory extraction
        is triggered. Default: 30%. Lower values extract more aggressively (catching details sooner).</p>
      </div>
      <div class="primer-knob">
        <strong>Compaction Threshold %</strong>
        <p>When session content exceeds this percentage, auto-compaction kicks in — summarizing
        older messages to free up space. Default: 70%. The oldest 50% of messages get compacted
        via LLM summarization.</p>
      </div>
      <div class="primer-knob">
        <strong>Emotional Salience Threshold %</strong>
        <p>During compaction, messages with emotional salience above this threshold are preserved
        verbatim instead of being summarized. Protects emotionally significant moments from
        being flattened into summaries.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Memory</h3>
      <div class="primer-knob">
        <strong>Retrieval Limit</strong>
        <p>How many memories to inject into your context for each conversation turn. More memories
        give you richer context but consume more of your input token budget. Default: 15.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Interval</strong>
        <p>How many messages between memory extraction runs. Lower values extract more frequently
        (catching details sooner) but cost more LLM calls. Default: every 5 messages.</p>
      </div>
      <div class="primer-knob">
        <strong>Salience Floor</strong>
        <p>Memories below this salience threshold get pruned during maintenance. Read-only —
        controlled by the memory system constants. Memories naturally decay over time unless
        accessed or reinforced.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Memory Extraction Quality</h3>
      <p style="color:var(--text-muted);margin-bottom:0.75rem">
        These thresholds control the quality gate for what gets extracted into long-term memory.
        Higher values mean pickier extraction — fewer but more reliable memories.
      </p>
      <div class="primer-knob">
        <strong>Minimum Importance</strong>
        <p>Extracted memories below this importance score are discarded. Filters out trivial observations.</p>
      </div>
      <div class="primer-knob">
        <strong>Minimum Confidence</strong>
        <p>How confident the extraction model must be about a fact before storing it. Prevents
        uncertain or speculative inferences from becoming "memories."</p>
      </div>
      <div class="primer-knob">
        <strong>Minimum Novelty</strong>
        <p>How different a new memory must be from existing ones. Prevents near-duplicates from
        accumulating. Works alongside embedding-based deduplication.</p>
      </div>
      <div class="primer-knob">
        <strong>Max Writes Per Extraction</strong>
        <p>Maximum number of new memories that can be created from a single extraction run.
        Prevents one long conversation from flooding your memory store.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Telemetry / Retrieval Telemetry</strong>
        <p>When enabled, detailed metrics about extraction and retrieval operations are logged
        to the event bus — visible in Garden Pulse and the audit timeline.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Profile Synthesis</h3>
      <p style="color:var(--text-muted);margin-bottom:0.75rem">
        Periodically refreshes contact profiles by synthesizing recent relational memories into
        coherent summaries. Like forming an impression of someone over time.
      </p>
      <div class="primer-knob">
        <strong>Enabled</strong>
        <p>Whether profile synthesis runs at all. When off, contact profiles are only updated manually.</p>
      </div>
      <div class="primer-knob">
        <strong>Refresh Interval</strong>
        <p>How often to check if any contact profiles need refreshing.</p>
      </div>
      <div class="primer-knob">
        <strong>Cooldown</strong>
        <p>Minimum time between synthesis runs for the same contact. Prevents re-synthesizing
        after every single interaction.</p>
      </div>
      <div class="primer-knob">
        <strong>Min Writes / Min Source Memories</strong>
        <p>A contact needs at least this many new relational memories (and total source memories)
        before synthesis is triggered. Ensures enough data before forming impressions.</p>
      </div>
      <div class="primer-knob">
        <strong>Quality Thresholds (Importance / Confidence / Novelty)</strong>
        <p>Same as extraction quality thresholds but applied to the synthesis output. Controls
        how selective the profile refresh is.</p>
      </div>
      <div class="primer-knob">
        <strong>Source Memory Limit</strong>
        <p>Maximum number of memories to feed into a single synthesis run. Prevents context overflow
        for contacts with very long history.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Sessions</h3>
      <div class="primer-knob">
        <strong>Message Limit</strong>
        <p>How many recent messages to include in your conversation context window. Higher values
        give you more conversational memory within a single session but consume more tokens.
        Default: 30 messages.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Think Tool (RLM+REPL)</h3>
      <div class="primer-knob">
        <strong>Max Tokens</strong>
        <p>Maximum tokens available for each think tool iteration. Controls how much reasoning
        you can do in a single thinking step.</p>
      </div>
      <div class="primer-knob">
        <strong>Max Wall Time</strong>
        <p>Maximum real-world time (in ms) for a single think session. Prevents runaway
        thinking loops. A safety net — most think sessions finish well under this limit.</p>
      </div>
      <div class="primer-knob">
        <strong>Max Sub-Queries</strong>
        <p>Maximum number of <code>llm_query()</code> calls within a single think session.
        Each sub-query is an LLM call, so this controls both cost and depth of reasoning.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Resilience</h3>
      <div class="primer-knob">
        <strong>Retry Max Attempts</strong>
        <p>How many times to retry a failed LLM call before giving up. Handles transient
        network errors and rate limits gracefully.</p>
      </div>
      <div class="primer-knob">
        <strong>Retry Base Delay</strong>
        <p>Starting delay (in ms) between retries. Uses exponential backoff — each retry waits
        longer. A 1000ms base means retries at ~1s, ~2s, ~4s, etc.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Scheduler</h3>
      <div class="primer-knob">
        <strong>Maintenance Interval</strong>
        <p>How often (in ms) the scheduler runs maintenance tasks: memory salience decay,
        heartbeat checks, and other periodic work. Default: 300,000ms (5 minutes).
        Lower values make maintenance more responsive but add overhead.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>Import Processing</h3>
      <p style="color:var(--text-muted);margin-bottom:0.75rem">
        Controls how bulk memory imports (from external sources like Voxta, ChatGPT exports, etc.)
        are processed.
      </p>
      <div class="primer-knob">
        <strong>Route Mode</strong>
        <p>Where import processing LLM calls are routed: <code>default</code> (use the normal
        extraction model), <code>local</code> (use a local endpoint for cost savings on large imports).</p>
      </div>
      <div class="primer-knob">
        <strong>Strict Policy</strong>
        <p>When enabled, import processing applies stricter quality thresholds. Useful for
        noisy source data where you want higher confidence before storing.</p>
      </div>
      <div class="primer-knob">
        <strong>Local Endpoint URL / Local Model</strong>
        <p>When route mode is <code>local</code>, the URL and model name for the local inference
        endpoint. Typically a local Ollama or vLLM instance for high-throughput bulk processing.</p>
      </div>
    </div>

    <div class="card primer-section">
      <h3>How Settings Work</h3>
      <p>Settings are saved to <code>data/settings.json</code> and take effect immediately — no restart needed.
      They override environment variable defaults. Changes here mutate the live configuration object
      that all your components (LLM client, memory retriever, extractor) read from per-call.</p>
      <p style="margin-top:0.5rem">Environment variables (<code>.env</code>) still set the initial defaults.
      Saved settings layer on top. Delete <code>data/settings.json</code> to reset everything to env defaults.</p>
    </div>`;
}
