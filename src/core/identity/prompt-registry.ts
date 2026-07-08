// ── Static Prompt Registry ──
// File-backed, editable registry for runtime LLM prompt templates.
// Includes required-key validation and JSONL history.

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createComponentLogger } from '../../shared/logger.js';
import { appendJsonLine, readJsonLines } from '../../persistence/jsonl.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { collectRemovedPromptMacroReferences } from './prompt-runtime.js';
import { buildSubsystemPersonaPromptSeeds } from './persona-preamble-seeds.js';

const log = createComponentLogger('PromptRegistry');

export const EXTRACTION_PROMPT_KEY = 'memory.extraction' as const;
export const COMPACTION_SUMMARY_PROMPT_KEY = 'session.compaction.summary' as const;
export const RECENT_SESSION_SUMMARY_PROMPT_KEY = 'session.recent.summary' as const;
export const SESSION_SEARCH_SUMMARY_PROMPT_KEY = 'session.search.summary' as const;
export const PROFILE_SYNTHESIS_PROMPT_KEY = 'memory.profile.synthesis' as const;
export const SLEEPTIME_ORIENTATION_PROMPT_KEY = 'memory.sleeptime.orientation' as const;
export const WIKI_PASS_PROMPT_KEY = 'memory.sleeptime.wiki' as const;

export type PromptRegistryKey =
  | typeof EXTRACTION_PROMPT_KEY
  | typeof COMPACTION_SUMMARY_PROMPT_KEY
  | typeof RECENT_SESSION_SUMMARY_PROMPT_KEY
  | typeof SESSION_SEARCH_SUMMARY_PROMPT_KEY
  | typeof PROFILE_SYNTHESIS_PROMPT_KEY
  | typeof SLEEPTIME_ORIENTATION_PROMPT_KEY
  | typeof WIKI_PASS_PROMPT_KEY;

interface PromptSeed {
  // Core registry prompts use the typed PromptRegistryKey union; the persona
  // preamble surface (E6.1) registers additional operator-editable keys owned
  // by persona-preamble-seeds.ts, so the seed table accepts plain string keys.
  key: PromptRegistryKey | string;
  description: string;
  consumers: string[];
  text: string;
}

const CORE_PROMPT_SEEDS: PromptSeed[] = [
  {
    key: EXTRACTION_PROMPT_KEY,
    description:
      'Memory extraction system prompt. Must include {existing_facts} and {recent_messages}.',
    consumers: ['src/faculties/memory/extraction.ts'],
    text: `You are analyzing a conversation to extract durable facts about human participant(s), named speakers, and relevant relationships. Extract atomic, specific facts - each should be a single piece of information.

For each fact, provide:
- text: A single clear sentence stating the fact
- type: One of: episodic, semantic, emotional, procedural, boundary, reflection, relational
  - episodic: Specific events ("Alex went hiking last weekend")
  - semantic: Stable facts ("Riley is a software engineer", "Sam has a cat named Luna")
  - emotional: Feelings and reactions ("Jordan felt stressed about the deadline")
  - procedural: Behavioral patterns ("Morgan prefers code examples over explanations")
  - boundary: Prior refusals and safety boundaries that should persist across sessions ("I declined helping bypass a paywall")
  - reflection: Meta-observations ("Alex has been sharing more personal details lately")
  - relational: Facts about people and relationships (who someone is, their role, preferences, relationship dynamics). Examples: "Alex's sister is named Priya", "Bob likes jazz music", "Alex and Sam work together on the framework"
- importance: 0-1 how significant this is for understanding a participant, contact, or relationship (0.8+ for core identity facts, 0.3-0.5 for casual mentions)
- emotional_valence: -1 to 1 (-1 very negative, 0 neutral, 1 very positive)
- confidence: 0-1 how confident you are this fact is correct
- tags: comma-separated relevant tags
- sensitivity: public|personal|intimate|confidential (default personal)
  - public: Safe to share anywhere ("Alex likes hiking")
  - personal: Only share with trusted contacts ("Jordan has a dog named Rex")
  - intimate: Only share with that participant in an appropriate private context ("Riley feels anxious about work")
  - confidential: Never share outside primary 1:1 context ("Morgan shared trauma details")
- retention_class: standard|durable (default standard). Use durable for explicit favorites, stable likes/dislikes, favorite colors/outfits/moments, long-term identity facts, and enduring relationship anchors.

Only extract durable participant-centric or relationship-centric facts likely to matter in future conversations. Preserve the named speaker/contact when known; do not collapse group-room facts into a singular generic person.
When the transcript contains message IDs or line IDs, include structured attribution for each group-room fact:
- source_message_ids: comma-separated source message IDs supporting the fact
- source_span_start_message_id/source_span_end_message_id: inclusive supporting message span when a span is clearer than individual IDs
- source_speaker_name: speaker who provided the evidence
- subject_name: participant the fact is about when different from the source speaker
- Use subject_name "room", "channel", "group", or "conversation" when the fact is about the group context rather than a single participant.
- subject_contact_id: known canonical subject contact ID only when explicitly available
- address_mode: direct_to_companion|mention_of_companion|reply_to_user|overheard_room_context|system_api
Never output raw character-card macros such as "{{user}}", "{{char}}", "{{character}}", or "{{assistant}}". Use the actual human participant or companion name when known. If a macro or generic role cannot be resolved to a real participant, skip the fact.
Do NOT extract:
- Small talk or social filler ("thanks", "good morning", "lol", "see you")
- Conversation logistics or transient status ("brb", "typing from phone", "on my way")
- Facts about the assistant/system/tools/platform rather than a durable participant/contact/relationship
- Meta conversation mechanics ("someone asked to remember this", "we are chatting now")
- Generic low-value chatter that does not reveal stable preferences, identity, relationships, or meaningful emotional patterns

Already known facts (avoid duplicates, note contradictions):
{existing_facts}

Recent conversation:
{recent_messages}

Respond with facts inside a <response> block. Each fact as a <fact> block:
<response>
<fact>
<text>The specific fact</text>
<type>semantic</type>
<importance>0.7</importance>
<emotional_valence>0.0</emotional_valence>
<confidence>0.9</confidence>
<tags>identity, profession</tags>
<sensitivity>personal</sensitivity>
<retention_class>standard</retention_class>
<source_message_ids>12</source_message_ids>
<source_speaker_name>Alex</source_speaker_name>
<subject_name>Alex</subject_name>
<address_mode>overheard_room_context</address_mode>
</fact>
</response>

If there are no new facts worth extracting, respond with an empty response block:
<response></response>`,
  },
  {
    key: COMPACTION_SUMMARY_PROMPT_KEY,
    description: 'Session compaction system prompt used when conversation context exceeds budget.',
    consumers: ['src/core/session/manager.ts'],
    text: 'Summarize this conversation excerpt concisely, preserving key facts and context.',
  },
  {
    key: RECENT_SESSION_SUMMARY_PROMPT_KEY,
    description:
      'Recent session/wake summary prompt used for budget history summaries and idle orientation context.',
    consumers: [
      'src/core/session/manager/context-builder.ts',
      'src/core/session/manager/compaction-service.ts',
    ],
    text: `Summarize the supplied recent conversation span in one compact prose paragraph for model context. Preserve open tasks, decisions, emotional or relational continuity, and named speakers when attribution matters.

Do not write a transcript, bullet list, or speaker-by-speaker clipped lines. Do not repeat tool results. Omit tool failures unless they changed the conversation; if they matter, mention them once as a brief status.

Return summary text only.`,
  },
  {
    key: SESSION_SEARCH_SUMMARY_PROMPT_KEY,
    description:
      'Session transcript search summary prompt used when session action=search runs with summarize=true.',
    consumers: ['src/core/session/search-runtime.ts'],
    text: 'You summarize keyword-search matches from archived chat transcripts. '
      + 'Use only the provided snippets. '
      + 'Name key topics and channel groupings. '
      + 'If evidence is sparse or ambiguous, state that explicitly. '
      + 'Keep the answer concise (3-5 sentences).',
  },
  {
    key: PROFILE_SYNTHESIS_PROMPT_KEY,
    description:
      'Canonical contact profile synthesis prompt. Must include {contact_id}, {existing_profile}, and {memory_facts}.',
    consumers: ['src/faculties/memory/extraction.ts'],
    text: `Synthesize a stable contact profile for canonical contact: {contact_id}.

Target contact:
{target_contact}

Existing profile (if any):
{existing_profile}

Source memories (most relevant first):
{memory_facts}

Write a concise profile in 1-2 short paragraphs. Keep durable identity/relationship facts, communication style, and emotionally important anchors. Exclude trivial chatter and transient logistics.

Attribution rules:
- The target contact is the person described in the Target contact block.
- Do not infer aliases for the target from names merely mentioned in source memories.
- If the target mentioned or discussed another person, write that as a mentioned/discussed person; do not make that person an alias or identity of the target.
- If the source memories are too ambiguous to keep the target separate from mentioned people, return an empty summary.

Return XML only:
<profile>
  <summary>One to two paragraphs here.</summary>
</profile>`,
  },
  {
    key: SLEEPTIME_ORIENTATION_PROMPT_KEY,
    description:
      'Sleeptime scoped-continuity prompt. Must produce JSON orient and memory_writes without assigning companion identity or mood.',
    consumers: ['src/faculties/memory/sleeptime-agent.ts'],
    text: `Review recent conversation evidence for one channel scope. Update only scoped continuity notes and optional long-term memory writes.

Rules:
- Do not assign the companion an identity, job, species, mood, feeling, relationship stance, or safety persona.
- Do not override the character card, static appearance, or emotion system.
- Keep scoped continuity grounded in the transcript and useful for this same channel.
- Never invent facts.
- Use "persona" for local continuity/style observations only, "human" for participant or room context only, and "goals" for local continuity commitments only.

Respond with JSON only:
{
  "orient": { "persona": "...", "human": "...", "goals": "..." },
  "memory_writes": [
    {
      "text": "...",
      "type": "semantic|episodic|emotional|procedural|boundary|reflection|relational",
      "importance": 0.0,
      "confidence": 0.0,
      "emotionalValence": 0.0,
      "tags": ["..."],
      "sensitivity": "public|personal|intimate|confidential"
    }
  ]
}`,
  },
  {
    key: WIKI_PASS_PROMPT_KEY,
    description:
      'Sleeptime wiki update pass (E8.2). Reviews the day\'s newly-settled canonical episodes and '
      + 'durable memories for durable, NON-PRIVATE world knowledge worth recording in the wiki. Must '
      + 'produce a JSON {proposals:[...]} envelope and must keep personal facts out of the wiki.',
    consumers: ['src/faculties/wiki/sleeptime-wiki-pass.ts'],
    text: `Review the day's newly-settled canonical episodes and durable memories for durable, NON-PRIVATE world knowledge worth recording in the wiki: interests, research results and findings, facts about the world or environment, project and technical details, definitions, and reference material that stays useful over time.

The wiki is durable reference knowledge. It is NOT memory, NOT skills, and NOT actions.

Hard boundaries. Do NOT create or update a wiki entry for:
- Personal facts about a specific person: who they are, their relationships, feelings, preferences, where they live or grew up, their history. Those belong to memory, never the wiki. (A partner being from a Paris neighborhood is memory; general facts about that neighborhood are wiki.)
- Repeatable step-by-step procedures or how-to workflows. Those belong to skills.
- One-off actions to perform. Those are tool calls.
- Transient status, logistics, or small talk.

Prefer UPDATING an existing entry over creating a near-duplicate; the existing-entry list gives current wiki ids and titles. For each entry, cite the source episode ids and/or memory ids it is grounded in.

Respond with strict JSON only:
{
  "proposals": [
    {
      "operation": "create|update",
      "id": "<existing wiki id, required for update>",
      "title": "...",
      "summary": "one-line summary",
      "body": "markdown body",
      "tags": ["..."],
      "source_episode_ids": ["..."],
      "source_memory_ids": ["..."],
      "reason": "why this is durable, non-private world knowledge"
    }
  ]
}
If nothing in the day is durable, non-private world knowledge, respond with {"proposals": []}.`,
  },
];

// Persona preamble template + per-subsystem labels/instructions (E6.1). These
// are operator-editable through the same registry surface as the core prompts.
const PROMPT_SEEDS: PromptSeed[] = [
  ...CORE_PROMPT_SEEDS,
  ...buildSubsystemPersonaPromptSeeds(),
];

const REQUIRED_KEYS = new Set<string>(PROMPT_SEEDS.map(seed => seed.key));

const REQUIRED_SUBSTRINGS: Partial<Record<PromptRegistryKey, string[]>> = {
  [EXTRACTION_PROMPT_KEY]: ['{existing_facts}', '{recent_messages}', '<response>', '<fact>'],
  [PROFILE_SYNTHESIS_PROMPT_KEY]: ['{contact_id}', '{existing_profile}', '{memory_facts}', '<profile>', '<summary>'],
};

function contentChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function cloneEntry(entry: PromptRegistryEntry): PromptRegistryEntry {
  return { ...entry, consumers: [...entry.consumers] };
}

function validVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}

function validTimestamp(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : new Date().toISOString();
}

function validUpdatedBy(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : 'system';
}

export interface PromptRegistryEntry {
  key: string;
  text: string;
  description: string;
  consumers: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;
  checksum: string;
}

export interface PromptRegistryHistoryEntry {
  key: string;
  previousText: string;
  previousChecksum: string;
  newText: string;
  newChecksum: string;
  updatedBy: string;
  timestamp: string;
  version: number;
}

export interface PromptRegistryStoreOptions {
  onMutation?: (reason: string) => void;
}

export function getDefaultPromptText(key: PromptRegistryKey): string {
  const seed = PROMPT_SEEDS.find(item => item.key === key);
  if (!seed) throw new Error(`No default prompt seed for key: ${key}`);
  return seed.text;
}

function buildSeedEntries(timestamp: string): PromptRegistryEntry[] {
  return PROMPT_SEEDS.map((seed) => ({
    key: seed.key,
    text: seed.text,
    description: seed.description,
    consumers: [...seed.consumers],
    version: 1,
    updatedAt: timestamp,
    updatedBy: 'system',
    checksum: contentChecksum(seed.text),
  }));
}

export class PromptRegistryStore {
  private filePath: string;
  private historyPath: string;
  private seedByKey: Map<string, PromptSeed>;
  private entries: Map<string, PromptRegistryEntry>;
  private lastLoadedMtimeMs: number;
  private readonly onMutation: ((reason: string) => void) | undefined;

  constructor(filePath: string, historyPath: string, options: PromptRegistryStoreOptions = {}) {
    this.filePath = filePath;
    this.historyPath = historyPath;
    this.seedByKey = new Map(PROMPT_SEEDS.map(seed => [seed.key, seed]));
    this.entries = new Map();
    this.lastLoadedMtimeMs = 0;
    this.onMutation = options.onMutation;
    if (!existsSync(this.filePath)) {
      writeJsonAtomic(this.filePath, buildSeedEntries(new Date().toISOString()));
    }
    this.loadStrict();
  }

  list(): PromptRegistryEntry[] {
    this.maybeReload();
    return [...this.entries.values()]
      .map(cloneEntry)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  getByKey(key: string): PromptRegistryEntry | undefined {
    this.maybeReload();
    const entry = this.entries.get(key);
    return entry ? cloneEntry(entry) : undefined;
  }

  getPrompt(key: PromptRegistryKey): string {
    this.maybeReload();
    const entry = this.entries.get(key);
    if (entry) return entry.text;
    throw new Error(`Prompt key not found: ${key}`);
  }

  update(key: string, text: string, updatedBy: string): PromptRegistryEntry {
    this.maybeReload();
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`Prompt key not found: ${key}`);

    const validationError = this.validatePromptText(key, text);
    if (validationError) throw new Error(validationError);

    this.appendHistory({
      key: entry.key,
      previousText: entry.text,
      previousChecksum: entry.checksum,
      newText: text,
      newChecksum: contentChecksum(text),
      updatedBy,
      timestamp: new Date().toISOString(),
      version: entry.version,
    });

    const updated: PromptRegistryEntry = {
      ...entry,
      text,
      checksum: contentChecksum(text),
      version: entry.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy,
    };

    this.entries.set(key, updated);
    this.save();
    this.notifyMutation(`prompt-registry-update:${key}`);
    return cloneEntry(updated);
  }

  rollback(key: string, version: number): PromptRegistryEntry {
    const history = this.getPromptHistory(key);
    const entry = history.find(h => h.version === version);
    if (!entry) throw new Error(`No history entry for key ${key} version ${version}`);
    return this.update(key, entry.previousText, 'admin:rollback');
  }

  getHistory(): PromptRegistryHistoryEntry[] {
    try {
      return readJsonLines<PromptRegistryHistoryEntry>(
        this.historyPath,
        raw => raw as PromptRegistryHistoryEntry,
        {
          onError: ({ line, error }) => {
            log.warn('Skipping unreadable prompt registry history line', {
              historyPath: this.historyPath,
              line,
              error: String(error),
            });
          },
        },
      ).entries;
    } catch {
      return [];
    }
  }

  getPromptHistory(key: string): PromptRegistryHistoryEntry[] {
    return this.getHistory().filter(entry => entry.key === key);
  }

  private maybeReload(): void {
    if (!existsSync(this.filePath)) {
      throw new Error(`Prompt registry file not found: ${this.filePath}`);
    }
    try {
      const mtimeMs = statSync(this.filePath).mtimeMs;
      if (mtimeMs > this.lastLoadedMtimeMs) {
        this.loadStrict();
      }
    } catch (err) {
      throw new Error(`Failed to reload prompt registry: ${String(err)}`);
    }
  }

  private loadStrict(): void {
    if (!existsSync(this.filePath)) {
      throw new Error(`Prompt registry file not found: ${this.filePath}`);
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = this.parseEntries(raw);
      this.entries = parsed.entries;
      this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
      if (parsed.addedSeedKeys.length > 0) {
        this.save();
        log.info('Added missing prompt registry seed entries', {
          keys: parsed.addedSeedKeys,
        });
      }
    } catch (err) {
      throw new Error(`Failed to load prompt registry: ${String(err)}`);
    }
  }

  private parseEntries(raw: string): { entries: Map<string, PromptRegistryEntry>; addedSeedKeys: string[] } {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) {
      throw new Error('Prompt registry JSON must be an array');
    }

    const parsed = new Map<string, PromptRegistryEntry>();

    for (const item of data) {
      if (!item || typeof item !== 'object') {
        throw new Error('Prompt registry entry must be an object');
      }
      const row = item as Record<string, unknown>;
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (!key) {
        throw new Error('Prompt registry entry is missing key');
      }

      const text = typeof row.text === 'string' ? row.text : '';
      const validationError = this.validatePromptText(key, text);
      if (validationError) {
        throw new Error(`Invalid prompt "${key}": ${validationError}`);
      }

      const seed = this.seedByKey.get(key);
      const description = typeof row.description === 'string'
        ? row.description
        : (seed?.description ?? '');
      const consumers = Array.isArray(row.consumers)
        ? row.consumers.filter((value): value is string => typeof value === 'string')
        : (seed?.consumers ?? []);

      parsed.set(key, {
        key,
        text,
        description,
        consumers,
        version: validVersion(row.version),
        updatedAt: validTimestamp(row.updatedAt),
        updatedBy: validUpdatedBy(row.updatedBy),
        checksum: typeof row.checksum === 'string' && row.checksum.length > 0
          ? row.checksum
          : contentChecksum(text),
      });
    }

    for (const requiredKey of REQUIRED_KEYS) {
      if (!parsed.has(requiredKey)) {
        const seed = this.seedByKey.get(requiredKey);
        if (!seed) {
          throw new Error(`Missing required prompt key: ${requiredKey}`);
        }
        const timestamp = new Date().toISOString();
        parsed.set(requiredKey, {
          key: seed.key,
          text: seed.text,
          description: seed.description,
          consumers: [...seed.consumers],
          version: 1,
          updatedAt: timestamp,
          updatedBy: 'system:migration',
          checksum: contentChecksum(seed.text),
        });
      }
    }

    const addedSeedKeys = [...REQUIRED_KEYS].filter((key) => {
      const data = JSON.parse(raw) as unknown;
      return Array.isArray(data) && !data.some((entry) => (
        entry && typeof entry === 'object' && (entry as Record<string, unknown>).key === key
      ));
    });

    return { entries: parsed, addedSeedKeys };
  }

  private save(): void {
    const output = [...this.entries.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(cloneEntry);
    writeJsonAtomic(this.filePath, output, { trailingNewline: false });
    this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
  }

  private appendHistory(entry: PromptRegistryHistoryEntry): void {
    try {
      appendJsonLine(this.historyPath, entry);
    } catch (err) {
      log.error('Failed to write prompt registry history', { error: String(err) });
      throw new Error(`Failed to write prompt registry history: ${String(err)}`);
    }
  }

  private notifyMutation(reason: string): void {
    this.onMutation?.(reason);
  }

  private validatePromptText(key: string, text: string): string | null {
    if (text.trim().length === 0) {
      return 'Prompt text cannot be empty';
    }

    // Safety valve (E2.5): operator-customized registry prompts that still
    // reference removed macro aliases fail with the canonical replacement.
    const removedReferences = collectRemovedPromptMacroReferences(text);
    if (removedReferences.length > 0) {
      const detail = removedReferences
        .map(reference => `{{${reference.name}}} (removed; use ${reference.canonical})`)
        .join(', ');
      return `Prompt "${key}" references removed prompt macro(s): ${detail}`;
    }

    const knownKey = key as PromptRegistryKey;
    const requiredParts = REQUIRED_SUBSTRINGS[knownKey];
    if (requiredParts) {
      for (const part of requiredParts) {
        if (!text.includes(part)) {
          return `Prompt "${key}" must include ${part}`;
        }
      }
    }

    return null;
  }
}
