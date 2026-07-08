import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import { runEpisodicJudgment } from './judgment-runner.js';

/**
 * Contextual topic cutting for candidate-episode synthesis (E5.4).
 *
 * Deterministic pre-cuts (UTC day boundary, long-gap split, entry cap) remain
 * the outer bounds; within one gated chunk an LLM proposes contiguous topic
 * segments via schema-bound structured output. Parsing is fail-closed: any
 * schema violation throws, and the synthesizer writes nothing for that chunk.
 */

export type TopicSegmentStatus = 'closed' | 'open';

export interface TopicSegment {
  /** Inclusive chunk-local index of the first entry in the segment. */
  startIndex: number;
  /** Inclusive chunk-local index of the last entry in the segment. */
  endIndex: number;
  /** Short clinical topic label. */
  topic: string;
  /**
   * 'open' marks an unfinished trailing topic; only the final segment of a
   * chunk may be open. Open trailing segments of the newest chunk are held
   * back (not claimed, no episode) and roll into the next synthesis pass.
   */
  status: TopicSegmentStatus;
}

const MAX_TOPIC_LABEL_CHARS = 80;
const MAX_ENTRY_CONTENT_CHARS = 400;

export const TOPIC_SEGMENTATION_SYSTEM_PROMPT = [
  'You segment one chunk of a chat transcript into contiguous topic segments.',
  'Input: numbered transcript entries in chronological order (index, timestamp, role, content).',
  'Return strict JSON only, no commentary and no markdown:',
  '{',
  '  "segments": [',
  '    { "start_index": 0, "end_index": 7, "topic": "short clinical label", "status": "closed" }',
  '  ]',
  '}',
  'Rules:',
  '- Segments must cover every entry exactly once, in order, with no gaps and no overlaps.',
  '- "start_index" and "end_index" are inclusive entry indices from the input.',
  '- Prefer fewer, coherent segments; split only where the conversation genuinely changes topic.',
  `- "topic" is a short clinical label of at most ${MAX_TOPIC_LABEL_CHARS} characters.`,
  '- "status" is "closed" for a finished topic.',
  '- "status" may be "open" ONLY on the final segment, and only when that topic is clearly',
  '  unfinished at the end of the transcript (the conversation appears to continue past the last entry).',
  '- A single segment covering the whole chunk is a valid answer.',
].join('\n');

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

export function formatSegmentationTranscript(entries: readonly SessionEntry[]): string {
  return entries
    .map((entry, index) => {
      const content = normalizeContent(entry.content);
      const clipped = content.length > MAX_ENTRY_CONTENT_CHARS
        ? `${content.slice(0, MAX_ENTRY_CONTENT_CHARS - 3)}...`
        : content;
      return `[${index}] ${new Date(entry.timestamp).toISOString()} ${entry.role}: ${clipped}`;
    })
    .join('\n');
}

function extractJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('segmentation response contains no JSON object');
  }
  const parsed: unknown = JSON.parse(content.slice(start, end + 1));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('segmentation response JSON is not an object');
  }
  return parsed as Record<string, unknown>;
}

function parseSegmentEntry(entry: unknown, entryCount: number, position: number): TopicSegment {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`segment ${position} must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const startIndex = record.start_index;
  const endIndex = record.end_index;
  if (typeof startIndex !== 'number' || !Number.isInteger(startIndex) || startIndex < 0 || startIndex >= entryCount) {
    throw new Error(`segment ${position} start_index must be an integer in [0, ${entryCount - 1}]`);
  }
  if (typeof endIndex !== 'number' || !Number.isInteger(endIndex) || endIndex < 0 || endIndex >= entryCount) {
    throw new Error(`segment ${position} end_index must be an integer in [0, ${entryCount - 1}]`);
  }
  if (startIndex > endIndex) {
    throw new Error(`segment ${position} start_index must not exceed end_index`);
  }
  const topic = typeof record.topic === 'string' ? record.topic.trim() : '';
  if (!topic || topic.length > MAX_TOPIC_LABEL_CHARS) {
    throw new Error(`segment ${position} topic must be a non-empty string up to ${MAX_TOPIC_LABEL_CHARS} chars`);
  }
  const status = record.status;
  if (status !== 'closed' && status !== 'open') {
    throw new Error(`segment ${position} status must be "closed" or "open"`);
  }
  return { startIndex, endIndex, topic, status };
}

/**
 * Schema-bound parse of the segmentation output. Fail closed: any violation
 * (non-contiguous cover, out-of-range indices, open non-final segment, bad
 * labels) throws — no partial acceptance for a malformed chunk proposal.
 */
export function parseTopicSegments(content: string, entryCount: number): TopicSegment[] {
  if (!Number.isInteger(entryCount) || entryCount < 1) {
    throw new Error('segmentation requires a non-empty chunk');
  }
  const raw = extractJsonObject(content);
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw new Error('segmentation response must contain a non-empty segments array');
  }
  const segments = raw.segments.map((entry, position) => parseSegmentEntry(entry, entryCount, position));

  if (segments[0].startIndex !== 0) {
    throw new Error('segments must start at entry index 0');
  }
  for (let index = 1; index < segments.length; index++) {
    if (segments[index].startIndex !== segments[index - 1].endIndex + 1) {
      throw new Error(`segments must be contiguous; segment ${index} leaves a gap or overlap`);
    }
  }
  if (segments[segments.length - 1].endIndex !== entryCount - 1) {
    throw new Error(`segments must cover every entry through index ${entryCount - 1}`);
  }
  for (let index = 0; index < segments.length - 1; index++) {
    if (segments[index].status === 'open') {
      throw new Error(`segment ${index} is marked open but only the final segment may be open`);
    }
  }
  return segments;
}

export interface TopicSegmentationRequest {
  sessionId: string;
  channelId: string;
  entries: readonly SessionEntry[];
}

/**
 * One schema-bound LLM call proposing topic boundaries inside one chunk.
 * Provider and parse errors propagate to the caller — the synthesizer owns
 * the fail-closed handling (typed error event, nothing claimed, watermark
 * not advanced past the chunk).
 */
export async function proposeTopicSegments(
  llmProvider: Pick<LLMProviderPort, 'complete'>,
  request: TopicSegmentationRequest,
  personaPreamble?: PersonaPreamblePort | null,
): Promise<TopicSegment[]> {
  if (request.entries.length === 0) {
    throw new Error('segmentation requires a non-empty chunk');
  }
  const first = request.entries[0];
  const last = request.entries[request.entries.length - 1];
  const requestPrompt = [
    'Transcript chunk:',
    formatSegmentationTranscript(request.entries),
    '',
    'Return the segments JSON only.',
  ].join('\n');

  // E6.1: soft persona framing precedes the strict task instructions and JSON
  // schema; the schema/format sections stay byte-identical.
  return runEpisodicJudgment({
    llmProvider,
    personaPreamble,
    personaSubsystem: 'topic_segmentation',
    systemPrompt: TOPIC_SEGMENTATION_SYSTEM_PROMPT,
    requestPrompt,
    correlation: {
      requestId: `episode-segmentation:${request.sessionId}:${String(first.id)}-${String(last.id)}`,
      channelId: request.channelId,
      callType: 'memory',
      purpose: 'memory.episode_synthesis.segmentation',
      originType: 'memory',
      originStage: 'memory.episode_synthesis.topic_cutting',
    },
    parse: content => parseTopicSegments(content, request.entries.length),
  });
}
