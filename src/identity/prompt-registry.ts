// ── Static Prompt Registry ──
// File-backed, editable registry for runtime LLM prompt templates.
// Includes required-key validation and JSONL history.

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createComponentLogger } from '../shared/logger.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { writeJsonAtomic } from '../shared/utils/fs.js';

const log = createComponentLogger('PromptRegistry');

export const EXTRACTION_PROMPT_KEY = 'memory.extraction' as const;
export const COMPACTION_SUMMARY_PROMPT_KEY = 'session.compaction.summary' as const;
export const PROFILE_SYNTHESIS_PROMPT_KEY = 'memory.profile.synthesis' as const;

export type PromptRegistryKey =
  | typeof EXTRACTION_PROMPT_KEY
  | typeof COMPACTION_SUMMARY_PROMPT_KEY
  | typeof PROFILE_SYNTHESIS_PROMPT_KEY;

interface PromptSeed {
  key: PromptRegistryKey;
  description: string;
  consumers: string[];
  text: string;
}

const PROMPT_SEEDS: PromptSeed[] = [
  {
    key: EXTRACTION_PROMPT_KEY,
    description:
      'Memory extraction system prompt. Must include {existing_facts} and {recent_messages}.',
    consumers: ['src/memory/extraction.ts'],
    text: `You are analyzing a conversation to extract important facts about the user. Extract atomic, specific facts - each should be a single piece of information.

For each fact, provide:
- text: A single clear sentence stating the fact
- type: One of: episodic, semantic, emotional, procedural, boundary, reflection, relational
  - episodic: Specific events ("User went hiking last weekend")
  - semantic: Stable facts ("User is a software engineer", "User has a cat named Luna")
  - emotional: Feelings and reactions ("User felt stressed about the deadline")
  - procedural: Behavioral patterns ("User prefers code examples over explanations")
  - boundary: Prior refusals and safety boundaries that should persist across sessions ("I declined helping bypass a paywall")
  - reflection: Meta-observations ("User has been sharing more personal details lately")
  - relational: Facts about people and relationships (who someone is, their role, preferences, relationship dynamics). Examples: "the primary user's sister is named Alex", "Bob likes jazz music", "the primary user and Sam work together on the framework"
- importance: 0-1 how significant this is for understanding the user (0.8+ for core identity facts, 0.3-0.5 for casual mentions)
- emotional_valence: -1 to 1 (-1 very negative, 0 neutral, 1 very positive)
- confidence: 0-1 how confident you are this fact is correct
- tags: comma-separated relevant tags
- sensitivity: public|personal|intimate|confidential (default personal)
  - public: Safe to share anywhere ("User likes hiking")
  - personal: Only share with trusted contacts ("User has a dog named Rex")
  - intimate: Only share with primary user ("User feels anxious about job")
  - confidential: Never share outside primary 1:1 context ("User shared trauma details")

Only extract durable, user-centric facts likely to matter in future conversations.
Do NOT extract:
- Small talk or social filler ("thanks", "good morning", "lol", "see you")
- Conversation logistics or transient status ("brb", "typing from phone", "on my way")
- Facts about the assistant/system/tools/platform rather than the user
- Meta conversation mechanics ("user asked to remember this", "we are chatting now")
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
</fact>
</response>

If there are no new facts worth extracting, respond with an empty response block:
<response></response>`,
  },
  {
    key: COMPACTION_SUMMARY_PROMPT_KEY,
    description: 'Session compaction system prompt used when conversation context exceeds budget.',
    consumers: ['src/session/manager.ts'],
    text: 'Summarize this conversation excerpt concisely, preserving key facts and context.',
  },
  {
    key: PROFILE_SYNTHESIS_PROMPT_KEY,
    description:
      'Canonical contact profile synthesis prompt. Must include {contact_id}, {existing_profile}, and {memory_facts}.',
    consumers: ['src/memory/extraction.ts'],
    text: `Synthesize a stable contact profile for canonical contact: {contact_id}.

Existing profile (if any):
{existing_profile}

Source memories (most relevant first):
{memory_facts}

Write a concise profile in 1-2 short paragraphs. Keep durable identity/relationship facts, communication style, and emotionally important anchors. Exclude trivial chatter and transient logistics.

Return XML only:
<profile>
  <summary>One to two paragraphs here.</summary>
</profile>`,
  },
];

const REQUIRED_KEYS = new Set<PromptRegistryKey>(PROMPT_SEEDS.map(seed => seed.key));

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

export function getDefaultPromptText(key: PromptRegistryKey): string {
  const seed = PROMPT_SEEDS.find(item => item.key === key);
  if (!seed) throw new Error(`No default prompt seed for key: ${key}`);
  return seed.text;
}

export class PromptRegistryStore {
  private filePath: string;
  private historyPath: string;
  private seedByKey: Map<PromptRegistryKey, PromptSeed>;
  private entries: Map<string, PromptRegistryEntry>;
  private lastLoadedMtimeMs: number;

  constructor(filePath: string, historyPath: string) {
    this.filePath = filePath;
    this.historyPath = historyPath;
    this.seedByKey = new Map(PROMPT_SEEDS.map(seed => [seed.key, seed]));
    this.entries = new Map();
    this.lastLoadedMtimeMs = 0;
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
      if (!existsSync(this.historyPath)) return [];
      const raw = readFileSync(this.historyPath, 'utf-8').trim();
      if (!raw) return [];
      return raw
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as PromptRegistryHistoryEntry);
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
      this.entries = parsed;
      this.lastLoadedMtimeMs = statSync(this.filePath).mtimeMs;
    } catch (err) {
      throw new Error(`Failed to load prompt registry: ${String(err)}`);
    }
  }

  private parseEntries(raw: string): Map<string, PromptRegistryEntry> {
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

      const seed = this.seedByKey.get(key as PromptRegistryKey);
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
        throw new Error(`Missing required prompt key: ${requiredKey}`);
      }
    }

    return parsed;
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
    }
  }

  private validatePromptText(key: string, text: string): string | null {
    if (text.trim().length === 0) {
      return 'Prompt text cannot be empty';
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
