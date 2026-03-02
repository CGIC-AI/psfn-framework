# Phase V: Agentic Context Composition — Research Synthesis

**PSFN-domy** | Date: 2026-03-02 | Status: Research Complete

## Executive Summary

Four parallel research agents investigated the state of the art in agentic context
management across academic papers (Dec 2025–Mar 2026), production systems (Manus,
Anthropic Claude Code, Google ADK, Spotify), character AI frameworks (SillyTavern,
RisuAI, KoboldAI, Agnai), and the MemGPT/Letta ecosystem.

**The single strongest finding**: Context management is a **learnable, separable
capability**. A dedicated 14B Context Manager model outperforms an untrained 120B
model (ARC paper). This validates PSFN's approach of using cheap async helper models.

---

## Key Papers

| Paper | ID | Core Contribution |
|-------|----|-------------------|
| **ARC** | arxiv:2601.12030 | Dedicated Context Manager (Actor + CM), per-turn incremental summarization + reflection-based reorganization. Trained 14B CM beats untrained 120B |
| **Memory-R1** | arxiv:2508.19828 | RL-trained memory CRUD: ADD/UPDATE/DELETE/NOOP. 152 training samples → SOTA |
| **MemAgent** | arxiv:2507.02259 | Fixed 1024-token memory bank, read-write-read loop. 8K training → 3.5M test generalization |
| **Focus Agent** | arxiv:2601.07190 | `start_focus`/`complete_focus` primitives, sawtooth context pattern. 22.7% token savings |
| **ACON** | arxiv:2510.00615 | Natural-language compression guidelines optimized via paired trajectories. 26-54% peak token reduction. Distills to smaller models (95% retention) |
| **CORAL** | OpenReview:NBGlItueYE | Checkpoint/purge working memory. RL-trained allocation via MARPO |
| **AgentDiet** | arxiv:2509.23586 | Identifies useless/redundant/expired trajectory waste. 40-60% token savings |
| **ReSum** | arxiv:2509.13313 | Periodic context summarization + GRPO training for summary-conditioned reasoning |
| **A-MEM** | arxiv:2502.12110 | Zettelkasten-inspired memory with auto-linking and memory evolution |
| **Agentic RL Survey** | arxiv:2509.02547 | Broad survey, useful as pointer document to memory management techniques |
| **Context as File System** | arxiv:2512.05470 | History/Memory/Scratchpad tiers, Constructor→Updater→Evaluator pipeline |
| **Sleep-time Compute** | arxiv:2504.13171 | Async background agent for memory consolidation (Letta) |
| **Memory in the Age of AI Agents** | arxiv:2512.13564 | Comprehensive survey: token/parametric/latent forms × factual/experiential/working functions |

---

## Production Systems

### Manus (most detailed production patterns)
- Average task: ~50 tool calls, 100:1 input:output token ratio
- **KV-cache is THE metric**: stable prefixes (no timestamps in system prompt), append-only context, cache breakpoints. 10x cost savings (cached 0.30 vs uncached 3.00 USD/MTok)
- **State-machine tool masking**: mask logits at decoding time instead of dynamically changing tool set (preserves cache)
- **Compaction**: tool results carry full + compact representations; swap to compact as results become stale; schema-based summarization when compaction insufficient
- **Error preservation**: keep failed actions + stack traces in context (reduces mistake repetition)
- **todo.md attention recitation**: updating a todo list pushes objectives into recent attention span (consumed ~1/3 of actions → moved to planner/executor sub-agent)

### Anthropic Claude Code
- **Compaction**: summarize conversations nearing limits; preserve architectural decisions, unresolved bugs, implementation specifics; discard redundant tool outputs
- **Sub-agent distillation**: agents explore extensively (tens of thousands of tokens) → return condensed 1,000-2,000 token summaries
- **Structured note-taking**: agent-maintained files persisted outside context (todo lists, NOTES.md)
- **Progressive disclosure**: lightweight identifiers (file paths, stored queries) with just-in-time retrieval

### Google ADK
- **Four tiers**: Working Context (ephemeral), Session (durable event log), Memory (cross-session), Artifacts (versioned by reference)
- **Ordered Processor pipeline**: each processor can filter/compact/transform independently
- **Narrative casting**: re-attribute messages during agent handoffs to prevent identity confusion
- **Artifacts as handles**: large data lives externally; agents see lightweight references, load on-demand

### LangChain
- **Three-context model**: Model (transient), Tool (persistent), Life-cycle (middleware)
- **SummarizationMiddleware**: cheap model (`gpt-4.1-mini`), triggered at token threshold, keeps N recent messages verbatim, replaces older with summary permanently

### Letta/MemGPT Evolution
- **Original (2023)**: OS-inspired virtual context, FIFO eviction + recursive summarization, 6 memory tools, heartbeat chaining
- **Sleeptime agents (2025)**: decoupled memory management from response generation; primary agent (fast, read-only memory) + sleeptime agent (slow, writes memory blocks asynchronously)
- **Context Repositories (Feb 2026)**: filesystem-based memory with git versioning, `system/` pinning, worktrees for concurrent sub-agents

---

## Character AI Frameworks

### SillyTavern
- **Chat Memory extension**: rolling summarization via `generateQuietPrompt()` (same model, no separate helper slot). Trigger: message count or word count threshold
- **Vector Storage**: summarize-before-vectorize option (helper LLM extracts key facts before embedding)
- **Central injection API**: `setExtensionPrompt(tag, content, position, depth, role)` — all context sources register through single API with priority-based budget trimming
- **Budget hierarchy**: system prompts (never trimmed) → World Info (25% budget) → extensions (by order) → chat history (remaining)
- **Limitation**: no built-in secondary model routing; extensions use same model as main generation

### RisuAI
- **SupaMemory**: recursive summarization pyramid — when summaries exceed budget, re-summarize. Has a dedicated "auxiliary model" slot (the only ecosystem example of a true secondary model slot)

### KoboldAI
- **Multipass search**: secondary LLM call to summarize context and generate better retrieval query before main generation

### Agnai
- Keyword-triggered memory books + embedding-based chat retrieval. No helper LLM calls implemented.

---

## Extractable Design Patterns for PSFN

### Pattern 1: Tiered Context Assembly Pipeline
**Source**: Google ADK, Anthropic, Manus

Separate context into independently managed tiers:
1. **Pinned** (always present): identity, current channel/trust, runtime state, agent-editable core memory blocks
2. **Retrieved** (per-turn selective): L2 memories scored by helper LLM for relevance
3. **Session** (managed window): recent messages with observation masking for stale tool results
4. **On-demand** (tool-loaded): full content loaded only when explicitly requested via tools

Compilation via ordered processors, each independently testable.

### Pattern 2: Observation Masking Before Summarization
**Source**: JetBrains (NeurIPS 2025 Workshop)

Replace older tool outputs with placeholders while preserving reasoning history. **Cheaper and often more effective than LLM summarization.** 52% cost savings, +2.6% solve rate with Qwen3-Coder 480B.

Apply as first compaction pass in `buildContext()`:
- Keep all agent reasoning
- Mask tool outputs beyond rolling window (e.g., 10 turns)
- Only invoke LLM summarization when masking is insufficient

### Pattern 3: Helper Model Context Scoring
**Source**: ARC, Memory-R1, LangChain SummarizationMiddleware

Before composing final context, cheap async model pass:
- Score retrieved memories for relevance to current query (replaces pure-embedding similarity)
- Classify incoming message type → adjust budget allocation
- Generate "context capsule": compressed summary + atomic key facts
- Assess whether current budget allocation is appropriate for this turn

Maps directly to PSFN's existing `background` model slot.

### Pattern 4: Per-Turn Incremental Summarization
**Source**: ARC (strongest evidence)

Per-turn management (31.2%) beats every-3-turns (26.5%), every-5-turns (24.5%), and budget-triggered at 8K (27.1%).

After every agent turn, cheap async call: `Summarize(query, checklist, prev_memory, last_interaction)`. Maintain a living "interaction memory" alongside raw session. Trigger full reorganization only on detected degradation (stalls, loops, contradictions).

### Pattern 5: Sawtooth Compression (Focus Agent)
**Source**: Focus Agent (arxiv:2601.07190)

Expose `start_focus`/`complete_focus` as meta-operations:
- During exploration, context grows freely
- On completion, learnings distilled to persistent Knowledge block, raw messages pruned
- The `think` tool could be extended: evidence/conclusions get promoted to persistent header, REPL trace discarded

### Pattern 6: Agent-Editable Pinned Memory Blocks
**Source**: MemGPT/Letta

Named, fixed-size memory blocks always in context and writable via tools:
- `persona` block (agent identity, always visible)
- `human` block (current user facts, trust-gated)
- `goals` block (current objectives, updated by reflections)
- Tools: `core_memory_append`, `core_memory_replace`, `memory_rethink` (wholesale rewrite)

### Pattern 7: Sleeptime Memory Agent
**Source**: Letta sleep-time compute

Decouple memory management from response generation:
- Primary agent responds immediately (read-only memory access)
- Background agent runs async after each turn (or every N turns) to reorganize memory
- Background agent can use stronger/slower model
- PSFN already has heartbeat reflections — promote them to full sleeptime memory agents

### Pattern 8: Compression Guideline Evolution
**Source**: ACON (arxiv:2510.00615)

Maintain natural-language compression guidelines that evolve:
- When agent asks follow-up indicating lost context → log as compression failure
- Periodically review failures via background model → update compression guideline
- Can distill optimized compressor into smaller model (95% retention)

### Pattern 9: Context Manifest for Debuggability
**Source**: Context-as-File-System paper

Context composition step emits a manifest:
- What memories were included and why
- What was compacted/dropped
- Token budget per section
- Which allocation strategy was used
Makes the system inspectable and tunable.

### Pattern 10: KV-Cache Optimization
**Source**: Manus

- Stable system prompt prefixes (no timestamps or dynamic content early in prompt)
- Append-only context structure (never rewrite earlier messages)
- Explicit cache breakpoints
- Tool name prefixes enable stateless logit masking

---

## Quantitative Reference Points

| Metric | Source | Value |
|--------|--------|-------|
| Effective context vs advertised | RULER benchmark | 50-65% |
| Observation masking cost savings | JetBrains | 52% cheaper, +2.6% solve rate |
| AgentDiet token reduction | AgentDiet | 40-60% input tokens |
| ACON peak token reduction | ACON | 26-54% |
| Focus Agent token savings | Focus | 22.7% net |
| Cognitive Workspace memory reuse | CW | 58.6% vs 0% (RAG) |
| Manus input:output ratio | Manus | 100:1 |
| Manus cache savings | Manus | 10x (cached vs uncached) |
| Sub-agent summary size | Anthropic | 1,000-2,000 tokens |
| ReSum + GRPO improvement | ReSum | +4.5% (inference), +8.2% (with training) |
| RLM vs vanilla on CodeQA | Prime Intellect | 62.0 vs 24.0 accuracy |
| ARC per-turn vs budget-triggered | ARC | 31.2% vs 27.1% |
| MemGPT + GPT-4 multi-session chat | MemGPT | 92.5% accuracy |
| MemGPT overhead per turn | Architectural analysis | 2-5 LLM calls typical |

---

## PSFN Current State → Phase V Gap Analysis

| Capability | PSFN Has | What's Missing |
|-----------|----------|----------------|
| Memory retrieval | Composite scoring (similarity × recency × emotion × importance × salience) | Helper LLM relevance scoring per-turn |
| Compaction | `compactionThresholdPct` → oldest 50% | Observation masking, selective compaction, per-turn incremental |
| Budget allocation | Static `memoryBudgetPct` (20%) | Adaptive per-turn allocation based on message type |
| Context composition | `buildContext()` deterministic pipeline | Two-phase: helper LLM plans structure → compose per plan |
| Agent context tools | `think` (REPL), `load_tools` meta-tool | `core_memory_*`, `start_focus`/`complete_focus`, `context_plan` |
| Background processing | Heartbeat reflections, async extraction | Full sleeptime agent for memory reorganization |
| Model roster | chat/background/reasoning/longContext | Add `context` purpose for fast/cheap helper calls |
| Context debugging | None | Context manifest (what included/excluded/why) |
| Compression policy | Hardcoded oldest-50% | Evolvable natural-language compression guidelines |
| Cache optimization | None | Stable prefixes, append-only structure |
| Memory CRUD | ADD (extraction), UPDATE (contradiction) | Explicit DELETE, NOOP (skip duplicate), agent-driven |

---

## Recommended Implementation Order

### Phase V-A: Low-Hanging Fruit (immediate impact, minimal risk)
1. **Observation masking** in `buildContext()` — replace stale tool outputs with placeholders
2. **Context manifest** — emit what was included/excluded/why for debugging
3. **Stable prefix optimization** — restructure system prompt for KV-cache friendliness

### Phase V-B: Helper Model Integration
4. **`ModelPurpose.context`** — add to model roster for fast/cheap helper calls
5. **Helper LLM relevance scoring** — score retrieved memories before injection
6. **Per-turn adaptive budgeting** — classify message type → adjust memory/session/system %

### Phase V-C: Agent-Directed Context
7. **Agent-editable pinned memory blocks** — `core_memory_append`/`replace`/`rethink` tools
8. **Focus primitives** — `start_focus`/`complete_focus` for sawtooth compression
9. **Promote heartbeat reflections to sleeptime memory agent**

### Phase V-D: Learning Loop
10. **Compression guideline evolution** — log failures, evolve guidelines via background model
11. **Context scoring feedback loop** — post-response evaluation of context effectiveness

---

## References

### Papers
- ARC: https://arxiv.org/abs/2601.12030
- Memory-R1: https://arxiv.org/abs/2508.19828
- MemAgent: https://arxiv.org/abs/2507.02259
- Focus Agent: https://arxiv.org/abs/2601.07190
- ACON: https://arxiv.org/abs/2510.00615
- CORAL: https://openreview.net/forum?id=NBGlItueYE
- AgentDiet: https://arxiv.org/abs/2509.23586
- ReSum: https://arxiv.org/abs/2509.13313
- A-MEM: https://arxiv.org/abs/2502.12110
- Cognitive Workspace: https://arxiv.org/abs/2508.13171
- Context as File System: https://arxiv.org/abs/2512.05470
- Sleep-time Compute: https://arxiv.org/abs/2504.13171
- Memory in the Age of AI Agents: https://arxiv.org/abs/2512.13564
- Agentic RL Survey: https://arxiv.org/abs/2509.02547
- ContextRL: https://arxiv.org/abs/2602.22623
- ACE: https://arxiv.org/abs/2510.04618
- RLM: https://arxiv.org/abs/2512.24601

### Production Systems
- Manus: https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Anthropic: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Google ADK: https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/
- LangChain: https://docs.langchain.com/oss/python/langchain/context-engineering
- Letta Context Repos: https://www.letta.com/blog/context-repositories
- JetBrains: https://blog.jetbrains.com/research/2025/12/efficient-context-management/
- Spotify: https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2
- RLM (Prime Intellect): https://www.primeintellect.ai/blog/rlm

### Character AI
- SillyTavern Docs: https://docs.sillytavern.app/
- SillyTavern Context Systems (DeepWiki): https://deepwiki.com/SillyTavern/SillyTavern/6-context-and-memory-systems
- RisuAI SupaMemory: https://github.com/kwaroran/RisuAI/wiki/SupaMemory
- Agnai Memory: https://agnai.chat/guides/memory
