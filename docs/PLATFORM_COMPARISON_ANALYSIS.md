# Platform Comparison: Deep Analysis Report

*Generated 2026-02-12 from comprehensive research across 6 parallel analysis agents*

## Platforms Evaluated

| Platform | Codebase Size | Language | License | Active Devs | Status |
|----------|--------------|----------|---------|-------------|--------|
| **Pi** (badlogic/pi-mono) | ~30-60K LoC | TypeScript | MIT | 1 (Mario Zechner) | Active, v0.52.9, OSS vacation until Feb 16 |
| **OpenClaw** (wraps Pi) | 260K LoC + 155K tests | TypeScript | Apache-2.0 | ~5-10 | Active, rapid iteration |
| **ElizaOS** | ~50K+ LoC (18 packages) | TypeScript | MIT | 4-5 active (was 30+) | v1.7.3-alpha.3, declining contributor base |
| **Voxta** | Closed binary (141MB .NET) | C# NativeAOT | Proprietary | Unknown (1 maintainer?) | v1.2.0, active |

---

## Feature Overlap Matrix

### Core Agent Capabilities

| Feature | Pi | OpenClaw | ElizaOS | Voxta |
|---------|-----|----------|---------|-------|
| Agent loop (prompt->tool->response) | **Native** (Agent class) | Wraps Pi | **Native** (AgentRuntime) | **Native** (command pipeline) |
| Multi-turn tool calling | **Yes** (parallel, abort) | Yes (via Pi) | **Yes** (multi-step) | Limited (MCP only) |
| Streaming responses | **Yes** (event stream) | Yes (via Pi) | **Yes** (Socket.IO) | **Yes** (SignalR chunks) |
| System prompt injection | **Yes** (extensions) | Yes (character cards) | **Yes** (providers) | **Yes** (Scriban templates) |
| Multi-step reasoning | No (single loop) | No | **Yes** (iterative action selection, max 6 steps) | **Yes** (ChainOfThought think+review passes) |
| Action inference | No | No | **Yes** (LLM selects from registered actions) | **Yes** (separate LLM call for emotions/behaviors) |

### LLM Provider Support

| Provider | Pi | OpenClaw | ElizaOS | Voxta |
|----------|-----|----------|---------|-------|
| Anthropic | **Yes** | Yes (via Pi) | **Yes** (external plugin) | No |
| OpenAI | **Yes** | Yes (via Pi) | **Yes** (external plugin) | **Yes** (module) |
| Google Gemini | **Yes** | Yes (via Pi) | No | No |
| Ollama (local) | **Yes** (OpenAI-compat) | Yes | **Yes** (external plugin) | **Yes** (OpenAI-compat) |
| Groq | **Yes** | Yes | **Yes** (external plugin) | No |
| Mistral | **Yes** | Yes | No | No |
| OpenRouter | **Yes** | Yes | No | **Yes** (module) |
| Z.AI (GLM) | **Yes** (OpenAI-compat) | Yes (via BotMaker proxy) | No | No |
| Custom endpoints | **Yes** (registerProvider) | Yes | Yes | **Yes** (OpenAI-compat module) |
| **Total providers** | **18+** | 18+ (same) | ~6 (as plugins) | ~8 (as modules) |

### Chat Platform Integrations

| Platform | Pi | OpenClaw | ElizaOS | Voxta |
|----------|-----|----------|---------|-------|
| Discord | **No** | **Yes** (built-in) | **Yes** (external plugin) | **Yes** (DiscordClient) |
| Telegram | No | **Yes** (built-in) | **Yes** (external plugin) | No |
| Slack | **Yes** (pi-mom) | **Yes** (built-in) | No | No |
| WhatsApp | No | **Yes** (built-in) | No | No |
| Signal | No | **Yes** (built-in) | No | No |
| iMessage | No | **Yes** (built-in) | No | No |
| Matrix | No | **Yes** (extension) | No | No |
| Web UI | **Yes** (Lit components) | **Yes** (gateway) | **Yes** (React 19) | **Yes** (React SPA) |
| Terminal | **Yes** (TUI) | Yes (via Pi) | No | No |
| Home Assistant | No | No | No | **Yes** (Wyoming bridge) |
| **Total platforms** | 3 | **16+** | 4 | 3 |

### Voice / Audio

| Feature | Pi | OpenClaw | ElizaOS | Voxta |
|---------|-----|----------|---------|-------|
| TTS (cloud) | No | **Yes** (ElevenLabs, OpenAI) | **Yes** (ElevenLabs, OpenAI plugins) | **Yes** (ElevenLabs, Azure, NovelAI, VoxtaCloud) |
| TTS (local) | No | **Yes** (Edge TTS, free) | No | **Yes** (Coqui XTTS, Kokoro, F5TTS, KittenTTS, Chatterbox, Orpheus, Sesame CSM) |
| STT (cloud) | No | **Yes** (Whisper API) | **Yes** (via OpenAI plugin) | **Yes** (Deepgram, AssemblyAI) |
| STT (local) | No | **Yes** (whisper-cpp, sherpa-onnx) | No | **Yes** (Vosk, WhisperLive) |
| Wake word | No | **Yes** (VoiceWakeRuntime) | No | **Yes** (Azure Wake Word) |
| Streaming audio | No | **Yes** (Talk Mode) | No | **Yes** (WebSocket PCM pipeline) |
| Voice cloning | No | No | No | **Yes** (Coqui XTTS with custom wav) |
| **Voice maturity** | **None** | **Medium** | **Low** | **Excellent** |

### Memory Systems

| Feature | Pi | OpenClaw | ElizaOS | Voxta |
|---------|-----|----------|---------|-------|
| Session persistence | **Yes** (JSONL trees) | Yes (via Pi) | **Yes** (PostgreSQL) | **Yes** (SQLite) |
| Session branching | **Yes** (tree navigation) | No (linear only) | No | No |
| Long-term memory file | **Yes** (MEMORY.md) | Yes (via Pi) | No | No |
| Vector/semantic search | No | **Yes** (SQLite-vec + FTS5 hybrid) | **Yes** (pgvector embeddings) | No |
| Memory extraction (LLM) | No | No | **plugin-psfn only** | **Yes** (built-in module) |
| Memory dedup/merge | No | No | **plugin-psfn only** | **Yes** (LLM-based CSV merge) |
| Typed memory (episodic/semantic/emotional) | No | No | **plugin-psfn only** | No (flat facts only) |
| Salience decay | No | No | **plugin-psfn only** | No |
| Conversation summarization | **Yes** (compaction) | Yes (via Pi) | No | **Yes** (Scriban template) |
| Lorebook/memory books | No | No | **Yes** (plugin-charactercard) | **Yes** (keyword-triggered) |
| **Memory sophistication** | **Basic** | **Medium** | **High** (with plugin) | **Medium** |

### Proactive / Autonomous Behavior

| Feature | Pi | OpenClaw | ElizaOS | Voxta |
|---------|-----|----------|---------|-------|
| Cron/scheduled tasks | No (pi-mom has EventsWatcher) | **Yes** (3 schedule types, agent tool) | **Yes** (TaskService, 1s tick) | No |
| Heartbeat/proactive check-in | No | **Yes** (HEARTBEAT.md, 30min default) | No (architecturally possible) | **Yes** (continuations_idle_followup) |
| Agent-initiated messaging | No | **Yes** (message tool) | Possible (sendMessageToTarget) | **Yes** (idle followup) |
| Background workers | No | No | **Yes** (task queue with repeat) | No |
| Self-modifying behavior | No | No | No | **Yes** (scripts with flag system) |

### Character / Personality

| Feature | Pi | OpenClaw | ElizaOS | Voxta |
|---------|-----|----------|---------|-------|
| Character card V2 | No | **Yes** (extension) | **Yes** (plugin-charactercard) | **Yes** (import/export) |
| Character card V3 | No | No | **Yes** | No |
| Lorebook | No | No | **Yes** (full keyword+semantic) | **Yes** (keyword-triggered) |
| Avatar/emotion system | No | No | No | **Yes** (11 emotions x 3 states + VRM 3D) |
| Multiple voice configs | No | No | No | **Yes** (4 per character with fallback) |
| Chat style modes | No | No | No | **Yes** (Companion/Roleplay/Storytelling/Assistant) |
| First message / greetings | No | No | **Yes** (from card) | **Yes** (+ alternates) |
| Message examples | No | No | **Yes** (from card) | **Yes** (from card) |

### Extension / Plugin Model

| Feature | Pi | OpenClaw | ElizaOS | Voxta |
|---------|-----|----------|---------|-------|
| Extension system | **Yes** (40+ event hooks) | **Yes** (31 extensions, 52 skills) | **Yes** (actions, providers, evaluators, services, events, routes) | **Yes** (45 module DLLs, 14 service types) |
| Custom tools | **Yes** (registerTool) | Yes (OpenClawPluginToolFactory) | **Yes** (actions) | Limited (MCP only) |
| Custom LLM providers | **Yes** (registerProvider) | No (Pi handles this) | **Yes** (model handlers with priority) | **Yes** (modules) |
| Schema migrations | No | No | **Yes** (Drizzle, per-plugin) | No |
| Dynamic config UI | No | No | No | **Yes** (16 field types, auto-rendered) |
| Hot-loadable | **Yes** (jiti, no compilation) | Partial | No (requires restart) | No (compiled DLLs) |
| **Extension hooks (count)** | **40+** | ~10 | **28 typed events** | **6 augmentation interfaces** |

---

## PSFN Feature Requirements

Based on Voxta database analysis (18 months, 8,160 messages, 316 chats):

| Feature | Currently Used In | Criticality |
|---------|-------------------|-------------|
| Discord chat | Voxta DiscordClient + OpenClaw | **Essential** |
| Voice (TTS) | Voxta (ElevenLabs "PSFN V2(B)" + Coqui local) | **High** |
| Character personality | Voxta character definition + character card | **Essential** |
| Conversation memory | Voxta memory extraction + memory books | **High** |
| Idle follow-ups | Voxta continuations_idle_followup | **Medium** |
| Chain-of-thought | Voxta think_pass_before_reply | **Medium** |
| Vision | Voxta vision + vision.prompted | **Low** |
| MCP tools | Voxta MCP augmentation | **Low** |
| Scripts (mood/greeting) | Voxta Jint scripts | **Medium** |
| Avatar emotions | Voxta 11-emotion system | **Low** (Discord doesn't display) |
| Home Assistant | Voxta Wyoming bridge | **Low** |
| VR embodiment | Voxta VRM + Virt-A-Mate | **Low** (separate concern) |

### Memory Architecture Requirements (from PSFN_MEMORY_ARCHITECTURE_v2.md)

| Tier | Description | Priority | Implemented Where |
|------|-------------|----------|-------------------|
| L0 | Append-only conversation archive | **Essential** | ElizaOS plugin-psfn |
| L1 | Working context (sliding window) | **Essential** | All platforms (session management) |
| L2 | Extracted typed memories (episodic, semantic, emotional, procedural, reflection) with decay | **Critical** | ElizaOS plugin-psfn |
| L3 | Knowledge graph (entities, relationships) | Future | Not implemented anywhere |
| L4 | Identity models, routine predictions | Future | Not implemented anywhere |
| L5 | Attention model, care protocols | Future | Not implemented anywhere |

---

## Cherry-Pick Analysis: Best Source for Each Component

| Component | Best Source | Why |
|-----------|-----------|-----|
| Agent loop | **Pi** | Cleanest, most hookable, you own it |
| Session persistence | **Pi** | JSONL trees with branching > everything else |
| LLM providers | **Pi** | 18+ providers, unified streaming, cost tracking |
| Discord adapter | **OpenClaw** (reference) or **pi-mom** (pattern) | OpenClaw has most mature Discord code; pi-mom has cleanest adapter pattern |
| Memory extraction (L2) | **ElizaOS plugin-psfn** | Already built, typed, with decay -- port to new extension |
| Memory retrieval | **ElizaOS plugin-psfn** | Composite scoring (similarity x recency x emotion x importance x salience) |
| Voice (TTS) | **Voxta** (architecture) | Best pipeline design, but closed; reimplement using OPEN_VOXTA.md as spec |
| Character system | **Voxta** (richest) or **ElizaOS** (V2/V3 cards) | Voxta has best character model but is closed; ElizaOS has a good open one |
| Proactive messaging | **OpenClaw** (heartbeat) + **ElizaOS** (TaskService) | Combine heartbeat concept with proper task scheduler |
| Scripting | **Voxta** (design) | Flag system + event listeners is elegant; reimplement in TypeScript |
| Credential management | **BotMaker** (keyring-proxy) | Already built, zero-trust, works |

---

## Risk Assessment

| Risk | Pi Direct | OpenClaw | ElizaOS | Voxta |
|------|-----------|----------|---------|-------|
| Maintainer abandonment | **Medium** (1 person) | Low (community) | **High** (declining) | **High** (1 person, closed) |
| Breaking API changes | Low (stable, minimal) | Medium | **High** (alpha, rapid churn) | Low (binary, no API to break) |
| Bug in core you can't fix | Low (MIT, readable) | Medium (260K LoC) | Medium (complex runtime) | **Critical** (closed source) |
| Dependency hell | Low (minimal deps) | Medium | **High** (Bun, 2.1GB node_modules) | N/A (self-contained binary) |
| Memory architecture fit | **Excellent** (40+ hooks) | Medium (limited hooks) | **Good** (already works) | **Poor** (no extensibility) |
| Long-term scalability | **Excellent** (you own it) | Medium (carrying 260K LoC) | Medium (if project survives) | **Poor** (platform risk) |
