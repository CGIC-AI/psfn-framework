# PSFN Framework — System Schematic (2026-08-05)

One complete, monolithic Mermaid flowchart of the PSFN framework at
function/library/logic level: both split-runtime processes, the operator
surface, the intake firewall (L0–L4) with its decision logic, the memory and
episodic faculties, scheduler lanes, shard/subagent machinery, ICP, pinned
libraries, persistence and owner roots, the Kubernetes deployment topology,
and every external service.

- Render target: landscape canvas (4:3), `flowchart LR`.
- Diamonds are runtime decision/gate logic; cylinders are persisted state;
  yellow nodes are pinned third-party libraries; purple is deployment topology.
- Source of truth: `src/app/{gateway,agent,operator}/main.ts`,
  `src/app/startup/composition/`, `src/{core,faculties,boundary,primitives,system,persistence,operator}/`,
  `deploy/helm/psfn/`, `proxy/litellm_config.yaml`, root `package.json`.
- Complements (does not replace) the prose topology in `docs/architecture.md`
  and the compact runtime view in `docs/architecture-diagram.mmd`.

```mermaid
%%{init: {"flowchart": {"curve": "basis", "nodeSpacing": 45, "rankSpacing": 70}} }%%
flowchart LR
  %% ======================================================================
  %% EXTERNAL ACTORS AND SERVICES
  %% ======================================================================
  subgraph EXT["External actors and services"]
    EXT_OPERATOR["Operator (human)"]
    EXT_PARTNER["Partner and contacts (humans)"]
    EXT_DISCORD["Discord API\ntext + voice (DAVE E2EE)"]
    EXT_TELEGRAM["Telegram Bot API"]
    EXT_OPENROUTER["OpenRouter\nz-ai/glm-5 · deepseek-v3.2 · kimi-k2.5 · wildcard"]
    EXT_FAL["FAL.ai\nimage generation fleet"]
    EXT_DEEPGRAM["Deepgram STT"]
    EXT_ELEVEN["ElevenLabs TTS"]
    EXT_HF["Hugging Face Hub\nmodel artifacts (prefetch)"]
    EXT_NTFY["ntfy push notifications"]
    EXT_MCP["MCP servers"]
  end

  %% ======================================================================
  %% CLIENT PERIPHERY
  %% ======================================================================
  subgraph CLIENTS["Client periphery"]
    UI_SAT["Satellite devices\nPi-class · VaM (Voxta SignalR) · ESPHome voice"]
    UI_HUB["PSFN-Satellite-Hub (sibling repo)\nPython hub/ + src/ts realtime path\npi_realtime · voxta-relay · ESPHome native API"]
    UI_COMPANION["companion-ui — React 19 + Vite 7 PWA\nlib/api client.ts + gateway-client.ts\nhub-stream.ts · service-worker sw.js"]
    UI_ADMIN["admin-ui (Garden) — SvelteKit 2 + Svelte 5 static\n~40 routes: chat, memory, sessions, prompts, settings,\nfleet, cogsec, confirmations, telemetry, scheduler…"]
  end

  %% ======================================================================
  %% DEPLOYMENT TOPOLOGY (live authority)
  %% ======================================================================
  subgraph K8S["k3s namespace psfn — Helm chart deploy/helm/psfn (live authority)"]
    K8S_GW["Deployment: gateway"]
    K8S_AGENT["Deployment: agent\n(+ fleet-agents.yaml)"]
    K8S_GARDEN["Deployment: garden"]
    K8S_HUB["Deployment: satellite-hub"]
    K8S_CUI["Deployment: companion-ui-test"]
    K8S_LITELLM["Deployment: litellm v1.72.6-stable\nvirtual keys; real provider keys stay here"]
    K8S_TEI["Deployment: tei\nHF text-embeddings-inference cpu-1.6.0"]
    K8S_PG["StatefulSet: postgres 17 + pgvector"]
    K8S_REDIS["StatefulSet: redis"]
    K8S_EMOSIM["Deployment: emosim (observer-eval sidecar)\nHTTP 17342 / TCP 17341 · netpol-isolated · SHA-pinned image"]
    K8S_CERT["cert-manager Issuers\ncertificates.yaml (@peculiar/x509)"]
    K8S_PVC["PVCs\ncompanion-data · system-data · workspace\npostgres-data · model caches"]
    K8S_NETPOL["NetworkPolicies\npsfn-egress · litellm · tei/postgres isolation"]
    K8S_PREFETCH["Job: model-prefetch"]
  end

  %% ======================================================================
  %% GATEWAY PROCESS (privileged host boundary)
  %% ======================================================================
  subgraph GATEWAY["Gateway process — src/app/gateway/main.ts"]
    GW_MAIN["main()\nloadConfig · resolveStartupPreflightBundle\nhydrateSecretBearingConfig · fleet-auth PG init\nsatellite/places registries · fleet backup scheduler"]
    GW_CORE["buildGatewayPrivilegedCore()\nEventBus · EligibilityGate · CapabilityRuntime\nprovider services · MCP runtime · intake screening"]
    GW_SERVER["GatewayServer — boundary/gateway/server.ts\nNDJSON JSON-RPC over unix socket / WS+TLS\nmethod dispatch · policy decisions · confirmation delivery"]
    GW_METHODS["methods/*\nllm · shell · git · fs · web · mcp · beads · vault\nimage · discord · notify · confirmation · clarify\ncontact-lifecycle · memory-deletion · home-assistant\nkube-self-management · intake-image · session-hmac\nshard-backends · system-data · runtime-health · register"]
    GW_POLICY["Policy gates (fail closed)\nURL/SSRF · fs · shell · git · web · media\nper-companion capability tiers"]
    GW_SANDBOX["bubblewrap sandbox\nsandbox/ runner + shell execution policy"]
    GW_LLM["LLMClient — primitives/llm/client.ts\npi-ai streamSimple / completeSimple\nretry.ts · fallback.ts · prompt-cache.ts\nmodel-budget.ts + model-call-gate.ts · work-spec welfare flags"]
    GW_ROUTE["routing.ts + system/config/models-config.ts\nRoutingPurpose → model slot roster\nchat · reasoning · memory · background · context · import_processing"]
    GW_EMBED["Embedding provider — faculties/memory/embedding.ts\nollama | transformers | api (TEI)"]
    GW_COST["llm-cost-capture.ts\ncharge-policy-config.ts · charge-ledger · model-usage"]
    GW_CHAN["channel-surfaces.ts + adapters\nDiscordAdapter (discord.js + @discordjs/voice)\nTelegramAdapter (raw Bot API)\napi/server.ts: OpenAI-compatible HTTP · voice WS · companion-ui WS\nsatellite-registry · places-registry · companion-relay (SSE)"]
    GW_BLOCKD{"contact blocked?\ncontact-block-gate.ts"}
    GW_DROP["drop + audit log"]
    GW_FLEET["fleet-auth-broker.ts + fleet-sso-router.ts\nEd25519 hop capabilities · replay guard\naudited escalation grants · portal projection"]
    GW_VOICE["primitives/voice\nSTT/TTS connectors: deepgram.ts · elevenlabs.ts\naudio pipeline · turn controller · WS transports"]
    GW_MCP["mcp/runtime.ts\nMCP tool bridging"]

    subgraph INTAKE["Intake firewall — gateway side (cogsec L0–L3)"]
      IN_L0["L0 envelope — createIntakeEnvelope()\nshared/contracts/intake-envelope.ts\nsource class → risk tier · taint propagation\npolicy: intake-policy.json"]
      IN_L1["L1 deterministic scanners\ncore/cogsec/intake/scanners/*\ninvisible-text · datamark · encoding-smuggling\nNFKC normalization · rule-engine · urls\nsecrets-pii · structure · proximity\nIntakeScreeningService (off/shadow/enforce)"]
      IN_D1{"L1 clean?"}
      IN_L15["L1.5 ONNX injection classifier\ninjection-classifier.ts\nprotectai/deberta-v3-base-prompt-injection-v2\nnever blocks alone"]
      IN_L2["L2 fast screener — l2-screener.ts\ntool-less LLM screen · fail closed"]
      IN_D2{"L2 release?"}
      IN_L25["L2.5 vision screener — vision-screener.ts\nper-image · OCR re-enters as image_ocr"]
      IN_L3["L3 heavy screener — l3-screener.ts\nmandatory CogSec event + quarantine\nsafe representation only"]
      IN_D3{"L3 outcome"}
    end
  end

  %% ======================================================================
  %% AGENT PROCESS (isolated companion runtime)
  %% ======================================================================
  subgraph AGENT["Agent process — src/app/agent/main.ts"]
    AG_MAIN["main()\nprepareAgentStartupContext → GatewayClient connect\nidentify · model-purpose selection · auth tokens"]
    AG_PERSIST["createAgentPersistenceRuntime()\npersistence/runtime-factory.ts\nPostgres memory/episodic/contact/enrollment/intention\npresence · ICP · reflection journal · background-work"]
    AG_COMPOSE["startup/composition/composition.ts\ncomposeSessionRuntimeAsync · composeMemoryStoreAsync\ncomposeIdentity · composeSubstrateAgent\nwireMemoryRuntime · wireShardAndThinkRuntime\nwireReflectionRuntime · wireOperatorHookRuntime"]
    AG_CLIENT["GatewayClient — boundary/gateway/client.ts\nimplements LLMProviderPort + EmbeddingProviderPort\nreverse notifications (onApiChatCompletion, …)"]
    AG_LOOP["SubstrateAgent.handleMessage()\ncore/agent/substrate-agent.ts (pi-agent-core Agent)\nturn reservation → stream adapter → tool loop\nregisterTool · validateToolWiring · fatigue budget"]
    AG_TOOLS["model-facing tools\ntool_search · toolset · memory · orient · wiki\njournal · subagent · session-search · self-status\nfocus · lifecycle · ntfy · analysis-workbench"]
    AG_CTX["SessionManager — core/session/manager.ts\nL0 JSONL journal · context-builder\nauto-compaction · cross-channel continuity\nturn provenance · intake-screened observations"]
    AG_PROMPT["identity/prompt-composer.ts\nprompt-registry · prompt-store\nruntime-prompt-layers · persona preamble\ncharacter card (@character-foundry)"]
    AG_HOOK["pre-tool hook gate\nhook-registry + HOOK.yaml (sync decisions)"]
    AG_CAP{"capability eligibility?\ntiers: nursery · apprentice · autonomous\nsystem/capabilities/eligibility.ts"}
    AG_CONFIRM{"operator confirmation?\nconfirmation-queue.ts (24h expiry)"}
    AG_MEMW["MemoryWriter — faculties/memory/writer.ts\nintentional writes · reconciliation · normalization\nsubject-authorized store"]
    AG_MEMR["MemoryRetriever — faculties/memory/retrieval/\nscoring · budget · episodic resolution\nsocial context · access scopes · provenance"]
    AG_MEMX["MemoryExtractor — faculties/memory/extraction/\nLLM pass · fact acceptance · importance\ngroup-memory lanes"]
    AG_EPIS["faculties/memory/episodic/\nEpisodicSynthesizer · SleepCycleEpisodeConsolidator\nEpisodeArcWeaver · DreamMeaningPass · topic segmentation"]
    AG_COREMEM["CoreMemoryStore + orient tool\nfaculties/core-memory"]
    AG_WIKI["WikiStore + SleeptimeWikiPass\nshared-world caretaker (fleet leader)\nplaces-wiki publication"]
    AG_SHARD["ShardManager — faculties/shards/manager.ts\ndigest-bound launch · TTL approval grants\ncapability derivation from parent snapshot\nfold-review.ts · parent-ICP delivery"]
    AG_SUB["SubagentFaculty — faculties/subagents\nrole registry · bounded work specs · tool governance"]
    AG_BENCH["analysis-workbench\nsandboxed REPL loop (via gateway shell)"]
    AG_ICP["core/icp — inter-companion protocol\ninitiation sources: weighted-thought · intention\nco-location · felt-impulse · social-desire\nlineage · speaking precedence"]
    AG_ICPD{"consent + capacity?\nGatewayIcpLocalPolicyCoordinator\nshared autonomy/fatigue stores"}
    AG_INTENT["core/intention\nconcerns · motivation · weighted thoughts\ncontradiction dampening · social desire\nproactive outbound + proactive-time-gate"]
    AG_EMO["core/emotion — VAD state · appraisal · calibration\nONNX text/audio classifiers\npartner-affect shadow bridge"]
    AG_SELF["core/self-model\ninternal-state persistence · metacognition\nsituated location"]
    AG_SCHED["Scheduler — core/scheduler/scheduler.ts\ntick loop · registerTask · registerHeartbeat\neligibility-gated · rest windows · quiet hours"]
    AG_TASKS["registered tasks\nheartbeat · durable background-work supervisor\nsalience-decay · social-graph builder\nshared-world-wiki-caretaker (fleet leader)\ndatabase backups (single / fleet / fleet-auth)\nreflection runtime: multi-template reflections\nepisodic synthesis · sleep consolidation\narc formation · dream pass · sleeptime wiki"]
    AG_LANES["startup lanes — app/agent/startup/*-lane.ts\ntemporal-wakeup · free-time · weighted-thought-outreach\nsocial-desire · speaking-arbiter · introspection\ndrift-review (+ second-arrow)"]
    AG_SINK["L4 sink gates — core/cogsec/intake/sink-gates.ts\nprompt_assembly · memory_write · wiki_write\nskill_write · persona_mutation · trust_mutation\ntool_egress · lethal-trifecta enforcement"]
    AG_SINKD{"sink gate verdict"}
    AG_COGSEC["core/cogsec support\nCogSecEventStore · canary egress scan\ndisclosure capsules · drift review\ntombstones · lineage · forensic archive"]
    AG_API["AgentApiBackend — channels/api/agent-backend.ts\nOpenAI-compatible edge · shard actions · telemetry"]
    AG_ADMIN["private admin transport\n(companion-scoped Garden surface)"]
  end

  %% ======================================================================
  %% OPERATOR PROCESS (Garden)
  %% ======================================================================
  subgraph OPERATOR["Operator process — src/app/operator/main.ts"]
    OP_MAIN["main()\nrequires ADMIN_PORT"]
    OP_SURFACE["GardenOperatorSurface\noperator/garden/operator-surface.ts\nHTTP(S) + auth — /login /garden /api/admin/*"]
    OP_ROUTES["routes/* (~28 modules)\nmemory · sessions · prompts · settings\nintake-quarantine · drift-review · ICP autonomy\ncontacts · images · wiki · scheduler · telemetry…"]
    OP_FLEET["FleetGardenControlPlane\nimmutable target registry · capability admission\ndirect DB + transport proxy · fleet model-usage service"]
    OP_DECIDE{"approve | deny | modify"}
  end

  %% ======================================================================
  %% PINNED LIBRARIES (root package.json)
  %% ======================================================================
  subgraph LIBS["Pinned libraries"]
    LIB_AGENT["@mariozechner/pi-agent-core 0.73.1\n@mariozechner/pi-ai 0.73.1"]
    LIB_DISCORD["discord.js 14.26.4 · @discordjs/voice 0.19.2\n@snazzah/davey 0.1.9 · prism-media 1.3.5"]
    LIB_PG["pg 8.20.0 · @redis/client 6.0.1"]
    LIB_HF["@huggingface/transformers 4.2.0\njs-tiktoken 1.0.21"]
    LIB_NET["undici 7.28.0 · ws 8.21.0\njson-rpc-2.0 1.7.1 · ipaddr.js 2.2.0"]
    LIB_SCHEMA["@sinclair/typebox 0.34.48 · yaml 2.9.0"]
    LIB_MISC["winston 3.19.0 · uuid 11.1.1\npdfjs-dist 5.4.394 · @peculiar/x509 1.14.3\n@character-foundry/character-foundry 0.5.0"]
    LIB_MCP["@modelcontextprotocol/client 2.0.0"]
  end

  %% ======================================================================
  %% PERSISTENCE AND OWNER ROOTS
  %% ======================================================================
  subgraph PERSIST["Persistence and owner roots"]
    DB_PG[("PostgreSQL 17 + pgvector\nmemory · episodic · contacts · fleet-auth\nmodel-usage · presence · ICP · background-work\nmigrations.ts · tenancy.ts · shared-schema.ts")]
    DB_REDIS[("Redis\nsession-tail cache")]
    DB_JSONL[("Session JSONL\ncanonical L0 transcript archive")]
    DB_OWNER[("JSON owner files\nsettings · models · providers · scheduler\ncapability-tier · channels · skills · trust\nintake-policy · charge · backup · companions")]
    DB_QUAR[("intake-quarantine.json\ncompanion-data/state")]
    DB_WS[("WORKSPACE_PATH\npersonal files · wiki · generated media · authored skills")]
    DB_BAK[("encrypted backups\npg_dump + companion tree + workspace + system config")]
  end

  %% ======================================================================
  %% EDGES — external world into channels
  %% ======================================================================
  EXT_PARTNER --> EXT_DISCORD
  EXT_PARTNER --> EXT_TELEGRAM
  EXT_DISCORD --> GW_CHAN
  EXT_TELEGRAM --> GW_CHAN
  UI_SAT -- "mic audio / playback" --> UI_HUB
  UI_HUB -- "STT stream" --> EXT_DEEPGRAM
  UI_HUB -- "TTS audio" --> EXT_ELEVEN
  UI_HUB -- "satellite turns / presence in · event-bus relay out" --> GW_CHAN
  UI_COMPANION -- "hub WS protocol" --> UI_HUB
  UI_COMPANION -- "WS actions + approvals\nescalation / hop capabilities" --> GW_FLEET
  EXT_OPERATOR --> UI_ADMIN
  UI_ADMIN -- "/api/admin/*" --> OP_SURFACE
  UI_HUB -- "hub device assertions" --> GW_FLEET

  %% ======================================================================
  %% EDGES — inbound turn (chat lifecycle, docs/chat-turn-lifecycle.md)
  %% ======================================================================
  GW_CHAN --> GW_BLOCKD
  GW_BLOCKD -- "yes" --> GW_DROP
  GW_BLOCKD -- "no" --> GW_SERVER
  GW_CHAN -- "untrusted inbound\nweb · documents · images · transcripts" --> IN_L0
  GW_SERVER -- "voice.handleMessage RPC" --> AG_CLIENT
  AG_CLIENT -- "registerGatewayMessageHandlers" --> AG_LOOP

  %% ======================================================================
  %% EDGES — intake firewall pipeline
  %% ======================================================================
  IN_L0 --> IN_L1 --> IN_D1
  IN_D1 -- "clean" --> IN_L15 --> IN_L2
  IN_D1 -- "flagged (escalate)" --> IN_L2
  IN_L2 --> IN_D2
  IN_D2 -- "release / sanitize" --> GW_SERVER
  IN_D2 -- "fail-closed on screener error" --> IN_L3
  IN_D2 -- "escalate" --> IN_L3
  GW_METHODS -- "intake.screen_image RPC" --> IN_L25 --> IN_L2
  IN_L3 --> IN_D3
  IN_D3 -- "safe representation only" --> GW_SERVER
  IN_D3 -- "quarantine + mandatory CogSec event" --> DB_QUAR
  IN_D3 -- "event" --> AG_COGSEC
  GW_METHODS -- "web fetch / search content" --> IN_L0

  %% ======================================================================
  %% EDGES — turn internals (agent)
  %% ======================================================================
  AG_LOOP -- "assemble context" --> AG_CTX
  AG_CTX --> AG_MEMR
  AG_CTX --> AG_COREMEM
  AG_CTX --> AG_WIKI
  AG_CTX --> AG_EMO
  AG_LOOP --> AG_PROMPT
  AG_PROMPT -- "prompt_assembly gate" --> AG_SINK
  AG_LOOP -- "LLM RPC (streaming)" --> AG_CLIENT
  AG_CLIENT -- "llm.* methods" --> GW_SERVER
  GW_SERVER --> GW_METHODS
  GW_METHODS --> GW_LLM
  GW_LLM --> GW_ROUTE
  GW_ROUTE -- "OpenAI-compatible endpoint" --> K8S_LITELLM
  K8S_LITELLM --> EXT_OPENROUTER
  K8S_LITELLM --> EXT_FAL
  GW_LLM --> GW_COST --> DB_PG
  GW_SERVER -- "deltas stream back" --> AG_CLIENT
  AG_CLIENT -- "stream adapter" --> AG_LOOP
  AG_LOOP -- "record L0 journal" --> AG_CTX --> DB_JSONL
  AG_LOOP -- "reply egress" --> AG_CLIENT
  AG_CLIENT -- "channel dock" --> GW_CHAN
  GW_CHAN --> EXT_DISCORD
  GW_CHAN --> EXT_TELEGRAM
  AG_LOOP -- "post-turn actions\nemotion appraisal · extraction enqueue · turn record" --> AG_MEMX
  AG_LOOP -- "post-turn actions" --> AG_EMO

  %% ======================================================================
  %% EDGES — tool call path
  %% ======================================================================
  AG_LOOP -- "tool call" --> AG_TOOLS
  AG_TOOLS --> AG_HOOK
  AG_HOOK --> AG_CAP
  AG_CAP -- "granted" --> AG_CONFIRM
  AG_CAP -- "denied (fail closed)" --> AG_LOOP
  AG_CONFIRM -- "not required / approved" --> AG_CLIENT
  AG_CONFIRM -- "local tools: memory · wiki · journal" --> AG_MEMW
  AG_CONFIRM -- "request" --> GW_SERVER
  GW_SERVER -- "confirmation / clarify" --> GW_FLEET
  GW_SERVER -- "notify" --> EXT_NTFY
  GW_FLEET -- "operator surface" --> OP_SURFACE
  OP_SURFACE --> OP_DECIDE
  OP_DECIDE -- "decision relayed (CompanionEventRelay)" --> GW_SERVER
  GW_SERVER -- "verdict" --> AG_CLIENT
  AG_CLIENT -- "gateway RPC tools" --> GW_SERVER
  GW_METHODS --> GW_POLICY
  GW_POLICY -- "shell.exec" --> GW_SANDBOX
  GW_POLICY -- "result" --> AG_CLIENT
  AG_CLIENT -- "tool observation (intake-screened at session entry)" --> AG_CTX

  %% ======================================================================
  %% EDGES — memory write path (sink-gated)
  %% ======================================================================
  AG_MEMX --> AG_MEMW
  AG_LOOP -- "intentional write" --> AG_MEMW
  AG_MEMW -- "memory_write gate" --> AG_SINK
  AG_WIKI -- "wiki_write gate" --> AG_SINK
  AG_SINK --> AG_SINKD
  AG_SINKD -- "allow" --> DB_PG
  AG_SINKD -- "hold" --> DB_QUAR
  AG_SINKD -- "incident" --> AG_COGSEC
  AG_MEMW -- "embedding RPC" --> AG_CLIENT
  AG_CLIENT -- "embed" --> GW_EMBED
  GW_EMBED --> K8S_TEI
  AG_MEMX --> AG_EPIS
  AG_EPIS --> DB_PG
  AG_MEMR --> DB_PG

  %% ======================================================================
  %% EDGES — shards, subagents, ICP
  %% ======================================================================
  AG_LOOP -- "shard launch" --> AG_SHARD
  AG_SHARD -- "TTL approval grant" --> AG_CONFIRM
  AG_SHARD --> AG_SUB --> AG_BENCH
  AG_BENCH -- "workbench shell via gateway" --> AG_CLIENT
  AG_SHARD -- "shard-backends RPC" --> AG_CLIENT
  AG_SHARD -- "fold-back review → parent turn" --> AG_LOOP
  AG_INTENT --> AG_ICP
  AG_ICP --> AG_ICPD
  AG_ICPD -- "consent + capacity ok" --> AG_CLIENT
  AG_CLIENT -- "GatewayCompanionChannelLane\nICP delivery to sibling companion" --> GW_CHAN
  GW_CHAN -- "recipient ingress (intake-screened)" --> AG_CLIENT

  %% ======================================================================
  %% EDGES — scheduler and lanes
  %% ======================================================================
  AG_SCHED --> AG_TASKS
  AG_SCHED --> AG_LANES
  AG_LANES -- "initiate turns" --> AG_LOOP
  AG_TASKS -- "sleep consolidation · arcs · dreams" --> AG_EPIS
  AG_TASKS -- "backups" --> DB_BAK
  DB_BAK --> DB_PG
  DB_BAK --> DB_JSONL
  DB_BAK --> DB_OWNER
  DB_BAK --> DB_WS

  %% ======================================================================
  %% EDGES — Garden / operator
  %% ======================================================================
  OP_MAIN --> OP_SURFACE
  OP_SURFACE --> OP_ROUTES
  OP_ROUTES --> OP_FLEET
  OP_FLEET -- "per-companion admin transports\nfan-out + fleet usage/cost aggregation" --> AG_ADMIN
  OP_SURFACE -- "double-confirm release / discard" --> DB_QUAR
  OP_ROUTES --> DB_OWNER
  OP_FLEET --> DB_PG
  AG_ADMIN --> OP_FLEET

  %% ======================================================================
  %% EDGES — startup wiring
  %% ======================================================================
  GW_MAIN --> GW_CORE
  GW_CORE --> GW_SERVER
  GW_CORE --> GW_LLM
  GW_CORE --> GW_POLICY
  AG_MAIN --> AG_PERSIST
  AG_MAIN --> AG_COMPOSE
  AG_COMPOSE --> AG_LOOP
  AG_COMPOSE --> AG_CTX
  AG_COMPOSE --> AG_SCHED
  AG_PERSIST --> DB_PG
  AG_PERSIST --> DB_REDIS
  AG_LOOP --> AG_INTENT
  AG_LOOP --> AG_SELF
  AG_LOOP --> AG_ICP

  %% ======================================================================
  %% EDGES — deployment topology (dotted = hosts / runs)
  %% ======================================================================
  K8S_GW -. "runs" .-> GW_MAIN
  K8S_AGENT -. "runs" .-> AG_MAIN
  K8S_GARDEN -. "runs" .-> OP_MAIN
  K8S_HUB -. "runs" .-> UI_HUB
  K8S_CUI -. "serves" .-> UI_COMPANION
  K8S_PG -. "persists" .-> DB_PG
  K8S_REDIS -. "persists" .-> DB_REDIS
  K8S_PVC -. "mounts" .-> DB_OWNER
  K8S_PVC -. "mounts" .-> DB_JSONL
  K8S_PVC -. "mounts" .-> DB_QUAR
  K8S_PVC -. "mounts" .-> DB_WS
  K8S_EMOSIM -. "observer-eval turn observation" .-> AG_LOOP
  K8S_CERT -. "issues mTLS certs" .-> GW_SERVER
  K8S_PREFETCH -. "pulls" .-> EXT_HF
  EXT_HF -. "ONNX weights" .-> IN_L15
  EXT_HF -. "ONNX weights" .-> AG_EMO
  K8S_NETPOL -. "constrains egress" .-> K8S_GW

  %% ======================================================================
  %% EDGES — libraries (dotted = dependency)
  %% ======================================================================
  LIB_AGENT -.-> AG_LOOP
  LIB_DISCORD -.-> GW_CHAN
  LIB_PG -.-> DB_PG
  LIB_HF -.-> IN_L15
  LIB_HF -.-> AG_EMO
  LIB_NET -.-> GW_SERVER
  LIB_NET -.-> AG_CLIENT
  LIB_SCHEMA -.-> GW_CORE
  LIB_MISC -.-> AG_MAIN
  LIB_MCP -.-> GW_MCP
  GW_MCP -.-> EXT_MCP

  %% ======================================================================
  %% STYLING
  %% ======================================================================
  classDef ext fill:#f5f5f5,stroke:#616161,color:#212121
  classDef client fill:#e0f7fa,stroke:#00838f,color:#004d40
  classDef k8s fill:#ede7f6,stroke:#5e35b1,color:#311b92
  classDef proc fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
  classDef sec fill:#ffebee,stroke:#c62828,color:#b71c1c
  classDef lib fill:#fff8e1,stroke:#f9a825,color:#5d4037
  classDef store fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
  classDef decision fill:#fff3e0,stroke:#e65100,color:#e65100

  class EXT_OPERATOR,EXT_PARTNER,EXT_DISCORD,EXT_TELEGRAM,EXT_OPENROUTER,EXT_FAL,EXT_DEEPGRAM,EXT_ELEVEN,EXT_HF,EXT_NTFY,EXT_MCP ext
  class UI_SAT,UI_HUB,UI_COMPANION,UI_ADMIN client
  class K8S_GW,K8S_AGENT,K8S_GARDEN,K8S_HUB,K8S_CUI,K8S_LITELLM,K8S_TEI,K8S_PG,K8S_REDIS,K8S_EMOSIM,K8S_CERT,K8S_PVC,K8S_NETPOL,K8S_PREFETCH k8s
  class GW_MAIN,GW_CORE,GW_SERVER,GW_METHODS,GW_LLM,GW_ROUTE,GW_EMBED,GW_COST,GW_CHAN,GW_FLEET,GW_VOICE,GW_MCP,AG_MAIN,AG_PERSIST,AG_COMPOSE,AG_CLIENT,AG_LOOP,AG_TOOLS,AG_CTX,AG_PROMPT,AG_HOOK,AG_MEMW,AG_MEMR,AG_MEMX,AG_EPIS,AG_COREMEM,AG_WIKI,AG_SHARD,AG_SUB,AG_BENCH,AG_ICP,AG_INTENT,AG_EMO,AG_SELF,AG_SCHED,AG_TASKS,AG_LANES,AG_API,AG_ADMIN,OP_MAIN,OP_SURFACE,OP_ROUTES,OP_FLEET proc
  class GW_POLICY,GW_SANDBOX,IN_L0,IN_L1,IN_L15,IN_L2,IN_L25,IN_L3,AG_SINK,AG_COGSEC,GW_DROP sec
  class LIB_AGENT,LIB_DISCORD,LIB_PG,LIB_HF,LIB_NET,LIB_SCHEMA,LIB_MISC,LIB_MCP lib
  class DB_PG,DB_REDIS,DB_JSONL,DB_OWNER,DB_QUAR,DB_WS,DB_BAK store
  class GW_BLOCKD,IN_D1,IN_D2,IN_D3,AG_CAP,AG_CONFIRM,AG_ICPD,AG_SINKD,OP_DECIDE decision
```

## Legend

- **Blue** — runtime processes and their functions (gateway, agent, operator).
- **Red** — security enforcement: policy gates, sandbox, intake firewall stages, sink gates.
- **Orange diamonds** — decision/gate logic evaluated at runtime.
- **Green cylinders** — persisted state (Postgres, Redis, JSONL, owner files, quarantine, workspace, backups).
- **Yellow** — pinned third-party libraries (exact versions from root `package.json`).
- **Purple** — Kubernetes deployment topology (`deploy/helm/psfn`, the live authority).
- **Teal** — client periphery (companion-ui, admin-ui/Garden, Satellite Hub, satellite devices).
- **Grey** — external actors and third-party services.
- Solid arrows are data/control flow; dotted arrows are hosting, mounting, or library-dependency relations.
