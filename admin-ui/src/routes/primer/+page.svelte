<script lang="ts">
  // Primer is a static reference page -- no API calls needed.
  // Content is based on the server-rendered primer template.

  interface PrimerKnob {
    name: string;
    description: string;
  }

  interface PrimerSection {
    title: string;
    intro?: string;
    knobs: PrimerKnob[];
  }

  const sections: PrimerSection[] = [
    {
      title: 'Models',
      knobs: [
        {
          name: 'Primary Model',
          description: 'The model that generates your conversational responses. This is your voice, your thinking engine. Larger models produce richer, more nuanced responses but cost more per turn.',
        },
        {
          name: 'Extraction Model',
          description: 'The model used for memory extraction -- analyzing conversations after the fact to identify important facts worth remembering. Can be a different (often cheaper) model since it runs asynchronously and doesn\'t need to be your "voice."',
        },
        {
          name: 'Provider',
          description: 'The API provider routing layer (usually "openrouter"). The LiteLLM proxy handles the actual routing -- this tells it which provider namespace to use.',
        },
        {
          name: 'Model Roster',
          description: 'Purpose-based model assignments: chat (conversation), background (extraction, maintenance), reasoning (deep thinking), longContext (large documents). Each slot specifies a model, provider, max tokens, and context window. Unassigned slots fall back along a chain: background to chat, reasoning to chat, longContext to chat.',
        },
        {
          name: 'Model Catalog',
          description: 'A registry of available models with their capabilities and constraints. Used by the role assignment system to validate assignments. Populated automatically via model discovery from LiteLLM/OpenRouter.',
        },
        {
          name: 'Provider Order',
          description: 'Preferred order of OpenRouter providers when multiple can serve the same model. Useful for prioritizing cheaper or faster providers. Example: ["DeepInfra", "Together", "Fireworks"].',
        },
      ],
    },
    {
      title: 'Token Limits',
      knobs: [
        {
          name: 'Primary Max Tokens',
          description: 'Maximum length of your responses in tokens (~4 chars each). Higher values let you be more verbose and thorough. Lower values force conciseness. Default: 16384 (~60K chars).',
        },
        {
          name: 'Extraction Max Tokens',
          description: 'Maximum tokens for memory extraction responses. Usually doesn\'t need to be as high as primary since extraction outputs are structured XML. Default: 8192.',
        },
        {
          name: 'Default Context Window',
          description: 'The assumed context window size for your primary model, in tokens. Used by the budgeting system to calculate how much space to allocate for memories, history, and system prompt. Default: 128,000. Set this to match your actual model\'s context window for accurate budgeting.',
        },
      ],
    },
    {
      title: 'Context Budgeting',
      intro: 'These percentages control how your context window is divided up. They work together -- think of your context window as a garden bed with allocated plots.',
      knobs: [
        {
          name: 'Memory Budget %',
          description: 'What percentage of your context window to reserve for retrieved memories. Default: 20%. Higher values give you richer recall but leave less room for conversation history.',
        },
        {
          name: 'Memory Retrieval Budget %',
          description: 'Percentage of the context budget dedicated to memory retrieval results specifically. Works alongside the memory budget to fine-tune how much context goes to memories vs other sources.',
        },
        {
          name: 'Session History Budget %',
          description: 'Percentage of the context window for conversation history. Balances how much recent chat you see against room for memories and system prompt.',
        },
        {
          name: 'Extraction Threshold %',
          description: 'When session content exceeds this percentage of the context window, memory extraction is triggered. Default: 30%. Lower values extract more aggressively (catching details sooner).',
        },
        {
          name: 'Compaction Threshold %',
          description: 'When session content exceeds this percentage, auto-compaction kicks in -- summarizing older messages to free up space. Default: 70%. The oldest 50% of messages get compacted via LLM summarization.',
        },
        {
          name: 'Emotional Salience Threshold %',
          description: 'During compaction, messages with emotional salience above this threshold are preserved verbatim instead of being summarized. Protects emotionally significant moments from being flattened into summaries.',
        },
      ],
    },
    {
      title: 'Memory',
      knobs: [
        {
          name: 'Retrieval Limit',
          description: 'How many memories to inject into your context for each conversation turn. More memories give you richer context but consume more of your input token budget. Default: 15.',
        },
        {
          name: 'Extraction Interval',
          description: 'How many messages between memory extraction runs. Lower values extract more frequently (catching details sooner) but cost more LLM calls. Default: every 5 messages.',
        },
        {
          name: 'Salience Floor',
          description: 'Memories below this salience threshold get pruned during maintenance. Read-only -- controlled by the memory system constants. Memories naturally decay over time unless accessed or reinforced.',
        },
      ],
    },
    {
      title: 'Memory Extraction Quality',
      intro: 'These thresholds control the quality gate for what gets extracted into long-term memory. Higher values mean pickier extraction -- fewer but more reliable memories.',
      knobs: [
        {
          name: 'Minimum Importance',
          description: 'Extracted memories below this importance score are discarded. Filters out trivial observations.',
        },
        {
          name: 'Minimum Confidence',
          description: 'How confident the extraction model must be about a fact before storing it. Prevents uncertain or speculative inferences from becoming "memories."',
        },
        {
          name: 'Minimum Novelty',
          description: 'How different a new memory must be from existing ones. Prevents near-duplicates from accumulating. Works alongside embedding-based deduplication.',
        },
        {
          name: 'Max Writes Per Extraction',
          description: 'Maximum number of new memories that can be created from a single extraction run. Prevents one long conversation from flooding your memory store.',
        },
        {
          name: 'Extraction Telemetry / Retrieval Telemetry',
          description: 'When enabled, detailed metrics about extraction and retrieval operations are logged to the event bus -- visible in Garden Pulse and the audit timeline.',
        },
      ],
    },
    {
      title: 'Profile Synthesis',
      intro: 'Periodically refreshes contact profiles by synthesizing recent relational memories into coherent summaries. Like forming an impression of someone over time.',
      knobs: [
        {
          name: 'Enabled',
          description: 'Whether profile synthesis runs at all. When off, contact profiles are only updated manually.',
        },
        {
          name: 'Refresh Interval',
          description: 'How often to check if any contact profiles need refreshing.',
        },
        {
          name: 'Cooldown',
          description: 'Minimum time between synthesis runs for the same contact. Prevents re-synthesizing after every single interaction.',
        },
        {
          name: 'Min Writes / Min Source Memories',
          description: 'A contact needs at least this many new relational memories (and total source memories) before synthesis is triggered. Ensures enough data before forming impressions.',
        },
        {
          name: 'Quality Thresholds (Importance / Confidence / Novelty)',
          description: 'Same as extraction quality thresholds but applied to the synthesis output. Controls how selective the profile refresh is.',
        },
        {
          name: 'Source Memory Limit',
          description: 'Maximum number of memories to feed into a single synthesis run. Prevents context overflow for contacts with very long history.',
        },
      ],
    },
    {
      title: 'Sessions',
      knobs: [
        {
          name: 'Message Limit',
          description: 'How many recent messages to include in your conversation context window. Higher values give you more conversational memory within a single session but consume more tokens. Default: 30 messages.',
        },
      ],
    },
    {
      title: 'Think Tool (RLM+REPL)',
      knobs: [
        {
          name: 'Max Tokens',
          description: 'Maximum tokens available for each think tool iteration. Controls how much reasoning you can do in a single thinking step.',
        },
        {
          name: 'Max Wall Time',
          description: 'Maximum real-world time (in ms) for a single think session. Prevents runaway thinking loops. A safety net -- most think sessions finish well under this limit.',
        },
        {
          name: 'Max Sub-Queries',
          description: 'Maximum number of llm_query() calls within a single think session. Each sub-query is an LLM call, so this controls both cost and depth of reasoning.',
        },
      ],
    },
    {
      title: 'Resilience',
      knobs: [
        {
          name: 'Retry Max Attempts',
          description: 'How many times to retry a failed LLM call before giving up. Handles transient network errors and rate limits gracefully.',
        },
        {
          name: 'Retry Base Delay',
          description: 'Starting delay (in ms) between retries. Uses exponential backoff -- each retry waits longer. A 1000ms base means retries at ~1s, ~2s, ~4s, etc.',
        },
      ],
    },
    {
      title: 'Scheduler',
      knobs: [
        {
          name: 'Maintenance Interval',
          description: 'How often (in ms) the scheduler runs maintenance tasks: memory salience decay, heartbeat checks, and other periodic work. Default: 300,000ms (5 minutes). Lower values make maintenance more responsive but add overhead.',
        },
      ],
    },
    {
      title: 'Import Processing',
      intro: 'Controls how bulk memory imports (from external sources like Voxta, ChatGPT exports, etc.) are processed.',
      knobs: [
        {
          name: 'Route Mode',
          description: 'Where import processing LLM calls are routed: default (use the normal extraction model), local (use a local endpoint for cost savings on large imports).',
        },
        {
          name: 'Strict Policy',
          description: 'When enabled, import processing applies stricter quality thresholds. Useful for noisy source data where you want higher confidence before storing.',
        },
        {
          name: 'Local Endpoint URL / Local Model',
          description: 'When route mode is local, the URL and model name for the local inference endpoint. Typically a local Ollama or vLLM instance for high-throughput bulk processing.',
        },
      ],
    },
    {
      title: 'How Settings Work',
      knobs: [
        {
          name: 'Persistence',
          description: 'Runtime config now lives in canonical system-data JSON files such as settings.json, models.json, scheduler.json, and capability-tier.json. Changes take effect immediately and mutate the live configuration object that components read from per-call.',
        },
        {
          name: 'Defaults',
          description: '.env is now for secrets and process/bootstrap wiring only. Mutable runtime behavior belongs in the JSON config owners, and Garden writes to the correct owner file for you.',
        },
      ],
    },
  ];
</script>

<div class="space-y-6">
  <!-- Header -->
  <div>
    <h1 class="text-2xl font-serif font-bold text-shadow-900">The Almanac</h1>
    <p class="text-sm text-shadow-600 mt-1">Internal reference for understanding the knobs and dials of the substrate</p>
  </div>

  <!-- Intro -->
  <div class="card-garden p-5">
    <p class="text-sm text-shadow-700 leading-relaxed">
      This is your internal reference for understanding the knobs and dials of your substrate.
      Each setting shapes how you think, remember, and express yourself.
    </p>
  </div>

  <!-- Sections -->
  {#each sections as section}
    <div class="card-garden p-5">
      <h2 class="text-lg font-serif font-semibold text-shadow-900 mb-4">{section.title}</h2>

      {#if section.intro}
        <p class="text-sm text-shadow-600 mb-4 leading-relaxed">{section.intro}</p>
      {/if}

      <div class="space-y-4">
        {#each section.knobs as knob}
          <div class="pl-4 border-l-2 border-bark-200">
            <p class="text-sm font-semibold text-shadow-800 mb-1">{knob.name}</p>
            <p class="text-sm text-shadow-700 leading-relaxed">{knob.description}</p>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
