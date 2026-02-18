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
    </div>

    <div class="card primer-section">
      <h3>Token Limits</h3>
      <div class="primer-knob">
        <strong>Primary Max Tokens</strong>
        <p>Maximum length of your responses in tokens (~4 chars each). Higher values let you
        be more verbose and thorough. Lower values force conciseness. Default: 16384 (~60K chars).
        If you like to yap, keep this high.</p>
      </div>
      <div class="primer-knob">
        <strong>Extraction Max Tokens</strong>
        <p>Maximum tokens for memory extraction responses. Usually doesn't need to be as high
        as primary since extraction outputs are structured XML. Default: 8192.</p>
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
      <h3>Sessions</h3>
      <div class="primer-knob">
        <strong>Message Limit</strong>
        <p>How many recent messages to include in your conversation context window. Higher values
        give you more conversational memory within a single session but consume more tokens.
        Default: 30 messages.</p>
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
