import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';
import { runEpisodicJudgment } from './judgment-runner.js';

/**
 * Contextual topic cutting for candidate-episode synthesis (E5.4).
 *
 * Deterministic pre-cuts (UTC day boundary, long-gap split, entry cap) remain
 * the outer bounds; within one gated chunk an LLM proposes contiguous topic
 * segments via schema-bound structured output.
 *
 * Parsing repairs only defects whose correction is unambiguous (iu7v0): an
 * uncovered leading or trailing tail joins its adjacent segment, a final
 * segment that runs past the chunk is clamped to it, an over-long label is
 * cut to the label cap, and an "open" status on a non-final segment is closed
 * (a later segment already started). Every repair is reported. Anything else
 * (interior gaps or overlaps, missing labels, malformed JSON) gets one
 * corrective retry that names the violation; a second violation fails closed
 * and the synthesizer writes nothing for that chunk.
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

/** A deterministic correction applied to an otherwise valid proposal. */
export type TopicSegmentRepair =
  | 'leading_gap_extended'
  | 'trailing_gap_extended'
  | 'final_segment_clamped'
  | 'topic_truncated'
  | 'non_final_open_closed';

export interface TopicSegmentProposal {
  segments: TopicSegment[];
  repairs: TopicSegmentRepair[];
}

export interface TopicSegmentationResult extends TopicSegmentProposal {
  /** True when the first proposal was rejected and the corrective retry succeeded. */
  correctiveRetry: boolean;
}

/**
 * A model proposal that violates the segmentation schema in a way no
 * deterministic repair can settle. Provider/transport errors are not this
 * type: they propagate unchanged and never trigger the corrective retry.
 */
export class TopicSegmentationValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TopicSegmentationValidationError';
  }
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

function invalid(message: string): TopicSegmentationValidationError {
  return new TopicSegmentationValidationError(message);
}

function extractJsonObject(content: string): Record<string, unknown> {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw invalid('segmentation response contains no JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch (error) {
    throw new TopicSegmentationValidationError('segmentation response JSON is malformed', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('segmentation response JSON is not an object');
  }
  return parsed as Record<string, unknown>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseSegmentEntry(
  entry: unknown,
  entryCount: number,
  position: number,
  isFinal: boolean,
  repairs: Set<TopicSegmentRepair>,
): TopicSegment {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalid(`segment ${position} must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const startIndex = record.start_index;
  const proposedEndIndex = record.end_index;
  if (!isNonNegativeInteger(startIndex) || startIndex >= entryCount) {
    throw invalid(`segment ${position} start_index must be an integer in [0, ${entryCount - 1}]`);
  }
  if (!isNonNegativeInteger(proposedEndIndex)) {
    throw invalid(`segment ${position} end_index must be an integer in [0, ${entryCount - 1}]`);
  }
  let endIndex = proposedEndIndex;
  if (endIndex >= entryCount) {
    if (!isFinal) {
      throw invalid(`segment ${position} end_index must be an integer in [0, ${entryCount - 1}]`);
    }
    endIndex = entryCount - 1;
    repairs.add('final_segment_clamped');
  }
  if (startIndex > endIndex) {
    throw invalid(`segment ${position} start_index must not exceed end_index`);
  }
  let topic = typeof record.topic === 'string' ? record.topic.replace(/\s+/gu, ' ').trim() : '';
  if (!topic) {
    throw invalid(`segment ${position} topic must be a non-empty string up to ${MAX_TOPIC_LABEL_CHARS} chars`);
  }
  if (topic.length > MAX_TOPIC_LABEL_CHARS) {
    topic = topic.slice(0, MAX_TOPIC_LABEL_CHARS).trimEnd();
    repairs.add('topic_truncated');
  }
  const proposedStatus = record.status;
  if (proposedStatus !== 'closed' && proposedStatus !== 'open') {
    throw invalid(`segment ${position} status must be "closed" or "open"`);
  }
  let status: TopicSegmentStatus = proposedStatus;
  if (status === 'open' && !isFinal) {
    status = 'closed';
    repairs.add('non_final_open_closed');
  }
  return { startIndex, endIndex, topic, status };
}

/**
 * Schema-bound parse of the segmentation output with deterministic repair of
 * unambiguous boundary/label defects (see the module header). Any other
 * violation throws {@link TopicSegmentationValidationError}.
 */
export function parseTopicSegments(content: string, entryCount: number): TopicSegmentProposal {
  if (!Number.isInteger(entryCount) || entryCount < 1) {
    throw invalid('segmentation requires a non-empty chunk');
  }
  const raw = extractJsonObject(content);
  if (!Array.isArray(raw.segments) || raw.segments.length === 0) {
    throw invalid('segmentation response must contain a non-empty segments array');
  }
  const repairs = new Set<TopicSegmentRepair>();
  const lastPosition = raw.segments.length - 1;
  const segments = raw.segments.map((entry, position) => (
    parseSegmentEntry(entry, entryCount, position, position === lastPosition, repairs)
  ));
  const firstSegment = segments[0];
  const lastSegment = segments[lastPosition];
  if (firstSegment === undefined || lastSegment === undefined) {
    throw invalid('segmentation response must contain a non-empty segments array');
  }
  if (firstSegment.startIndex !== 0) {
    firstSegment.startIndex = 0;
    repairs.add('leading_gap_extended');
  }
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const segment = segments[index];
    if (!previous || !segment || segment.startIndex !== previous.endIndex + 1) {
      throw invalid(`segments must be contiguous; segment ${index} leaves a gap or overlap`);
    }
  }
  if (lastSegment.endIndex !== entryCount - 1) {
    lastSegment.endIndex = entryCount - 1;
    repairs.add('trailing_gap_extended');
  }
  return { segments, repairs: [...repairs] };
}

export interface TopicSegmentationRequest {
  sessionId: string;
  channelId: string;
  entries: readonly SessionEntry[];
}

function correctiveRequestPrompt(
  requestPrompt: string,
  entryCount: number,
  rejection: TopicSegmentationValidationError,
): string {
  return [
    requestPrompt,
    '',
    `Your previous answer was rejected: ${rejection.message}.`,
    `Return corrected segments JSON only. Cover every entry index from 0 through ${entryCount - 1}`
      + ' exactly once, in order, with no gaps or overlaps, and give every segment a non-empty topic.',
  ].join('\n');
}

/**
 * Schema-bound LLM topic proposal for one chunk, with one corrective retry
 * when the proposal violates the schema in a way repair cannot settle.
 * Provider and transport errors propagate unchanged on either attempt; the
 * synthesizer owns the fail-closed handling (typed event, nothing claimed,
 * watermark not advanced past the chunk) and the lane bounds its retries.
 */
export async function proposeTopicSegments(
  llmProvider: Pick<LLMProviderPort, 'complete'>,
  request: TopicSegmentationRequest,
  personaPreamble?: PersonaPreamblePort | null,
): Promise<TopicSegmentationResult> {
  if (request.entries.length === 0) {
    throw invalid('segmentation requires a non-empty chunk');
  }
  const first = request.entries[0];
  const last = request.entries[request.entries.length - 1];
  if (first === undefined || last === undefined) {
    throw invalid('segmentation requires a non-empty chunk');
  }
  const entryCount = request.entries.length;
  const requestPrompt = [
    'Transcript chunk:',
    formatSegmentationTranscript(request.entries),
    '',
    'Return the segments JSON only.',
  ].join('\n');
  const requestIdBase = `episode-segmentation:${request.sessionId}:${String(first.id)}-${String(last.id)}`;

  // E6.1: soft persona framing precedes the strict task instructions and JSON
  // schema; the schema/format sections stay byte-identical.
  const propose = (prompt: string, requestId: string) => runEpisodicJudgment({
    llmProvider,
    personaPreamble,
    personaSubsystem: 'topic_segmentation',
    systemPrompt: TOPIC_SEGMENTATION_SYSTEM_PROMPT,
    requestPrompt: prompt,
    correlation: {
      requestId,
      channelId: request.channelId,
      callType: 'memory',
      purpose: 'memory.episode_synthesis.segmentation',
      originType: 'memory',
      originStage: 'memory.episode_synthesis.topic_cutting',
    },
    parse: content => parseTopicSegments(content, entryCount),
  });

  try {
    return { ...(await propose(requestPrompt, requestIdBase)), correctiveRetry: false };
  } catch (error) {
    if (!(error instanceof TopicSegmentationValidationError)) throw error;
    try {
      const corrected = await propose(
        correctiveRequestPrompt(requestPrompt, entryCount, error),
        `${requestIdBase}:corrective`,
      );
      return { ...corrected, correctiveRetry: true };
    } catch (retryError) {
      if (!(retryError instanceof TopicSegmentationValidationError)) throw retryError;
      throw new TopicSegmentationValidationError(
        `${retryError.message} (after one corrective retry; first rejection: ${error.message})`,
        { cause: retryError },
      );
    }
  }
}
