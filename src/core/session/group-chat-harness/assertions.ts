/**
 * Reusable prompt-shape assertion helpers for group-chat regression tests.
 *
 * These helpers operate on rendered prompt strings and assembled history
 * messages produced by the REAL prompt-assembly path (session manager
 * `buildContext`, substrate-agent runtime-context rendering, and memory
 * retrieval). They deliberately contain no framework coupling: each helper
 * throws a descriptive `Error` on failure so it can be used inside vitest
 * `it(...)` and `it.fails(...)` blocks alike, or by any future test suite.
 *
 * Vocabulary:
 * - "block" means an XML-ish runtime section such as `<speaking_with>`,
 *   `<conversation_state>`, or `<core_memory ...>` that prompt assembly
 *   renders. Blocks may carry attributes.
 * - "scope" means the conversation a memory/block belongs to, e.g.
 *   `room:townsquare` or `dm:alice`.
 */
import {
  formatMemoryWithheldReasonLabel,
  type MemoryWithheldReasonTag,
} from '../../../faculties/memory/withheld-summary.js';

export interface HistoryMessageLike {
  role: string;
  content: string;
}

/**
 * Assert that the rendered retrieval output cites the given withheld-reason
 * tag's human-readable label (`formatMemoryWithheldReasonLabel`), the same
 * label the real `<memory_context_note>` rendering path
 * (`retrieval/formatting.ts` renderWithheldSummary) emits. Tying the
 * assertion to the labeling function itself (rather than a hand-copied
 * string) means a reason-tag/label drift fails this test instead of the two
 * silently diverging.
 */
export function expectWithheldReason(output: string, reasonTag: MemoryWithheldReasonTag): void {
  const label = formatMemoryWithheldReasonLabel(reasonTag);
  if (!output.includes(label)) {
    throw new Error(
      `expectWithheldReason: assembled output does not cite the withheld-reason label `
      + `${JSON.stringify(label)} for reason tag "${reasonTag}".`,
    );
  }
}

export interface AttributionParticipant {
  /** Stable attribution id as rendered in history, e.g. `room:user-alice`. */
  id: string;
  name: string;
}

function findBlockOpenTag(prompt: string, blockName: string): number {
  // Match `<blockName>` or `<blockName attr="...">` but not `<blockName_other>`.
  const pattern = new RegExp(`<${blockName}(?=[\\s/>])`, 'u');
  const match = pattern.exec(prompt);
  return match ? match.index : -1;
}

function locateBlock(prompt: string, blockName: string): { start: number; end: number } | null {
  const start = findBlockOpenTag(prompt, blockName);
  if (start < 0) return null;
  const close = `</${blockName}>`;
  const end = prompt.indexOf(close, start);
  if (end < 0) {
    // Self-closing block (`<blockName ... />`).
    const selfCloseEnd = prompt.indexOf('/>', start);
    if (selfCloseEnd < 0) return null;
    return { start, end: selfCloseEnd + 2 };
  }
  return { start, end: end + close.length };
}

/**
 * Assert that a runtime block is NOT present in the rendered prompt.
 * Used to prove the `speaking_with` (one-on-one) block is suppressed on
 * multi-human group turns.
 */
export function expectNoBlock(prompt: string, blockName: string): void {
  if (findBlockOpenTag(prompt, blockName) >= 0) {
    throw new Error(
      `expectNoBlock: prompt unexpectedly contains a <${blockName}> block.`,
    );
  }
}

/** Assert that a runtime block IS present in the rendered prompt. */
export function expectBlock(prompt: string, blockName: string): void {
  if (findBlockOpenTag(prompt, blockName) < 0) {
    throw new Error(
      `expectBlock: prompt is missing the expected <${blockName}> block.`,
    );
  }
}

/**
 * Assert that a block is present AND its content (including its open-tag
 * attributes) is scoped to `expectedScopeId`. Proves, for example, that a
 * group-room `core_memory` block is keyed to the room it belongs to rather
 * than presenting an unqualified single-human identity.
 */
export function expectBlockScope(prompt: string, blockName: string, expectedScopeId: string): void {
  const location = locateBlock(prompt, blockName);
  if (location === null) {
    throw new Error(
      `expectBlockScope: prompt is missing the <${blockName}> block, so it cannot be scoped to "${expectedScopeId}".`,
    );
  }
  const body = prompt.slice(location.start, location.end);
  if (!body.includes(expectedScopeId)) {
    throw new Error(
      `expectBlockScope: <${blockName}> block is not scoped to "${expectedScopeId}"; `
      + `the scope identifier is absent from the block body.`,
    );
  }
}

function attributionPrefixes(participants: readonly AttributionParticipant[]): string[] {
  return participants.map(participant => `${participant.name} (${participant.id}):`);
}

/**
 * Assert that the human turns in an assembled group history carry per-speaker
 * attribution prefixes of the form `Name (stable-id): ...`.
 *
 * Two guarantees:
 * 1. every user-role history message BEGINS with a known participant prefix
 *    (consecutive user turns are merged into one message, so only the first
 *    line of a merged message is checked for the start-of-message guarantee);
 * 2. every expected participant appears as a line-start prefix somewhere in
 *    the assembled user history (nobody's speech is left unattributed or
 *    silently dropped).
 */
export function expectAttributedHistory(
  messages: readonly HistoryMessageLike[],
  participants: readonly AttributionParticipant[],
): void {
  const userMessages = messages.filter(message => message.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('expectAttributedHistory: no user-role history messages were assembled.');
  }
  const prefixes = attributionPrefixes(participants);

  for (const message of userMessages) {
    const firstLine = message.content.trimStart().split('\n', 1)[0] ?? '';
    if (!prefixes.some(prefix => firstLine.startsWith(prefix))) {
      throw new Error(
        `expectAttributedHistory: group history message is not speaker-attributed with a `
        + `"Name (id):" prefix. First line: ${JSON.stringify(firstLine.slice(0, 100))}. `
        + `Expected one of: ${prefixes.join(' | ')}`,
      );
    }
  }

  const allUserLines = userMessages
    .flatMap(message => message.content.split('\n'))
    .map(line => line.trimStart());
  for (const participant of participants) {
    const prefix = `${participant.name} (${participant.id}):`;
    if (!allUserLines.some(line => line.startsWith(prefix))) {
      throw new Error(
        `expectAttributedHistory: no history line is attributed to `
        + `"${participant.name} (${participant.id})". Attribution prefix "${prefix}" not found.`,
      );
    }
  }
}

/**
 * Assert that the user turns in a one-on-one DM history are NOT group-attributed:
 * private DMs must keep raw partner speech without "Name (id):" prefixes.
 */
export function expectUnattributedHistory(
  messages: readonly HistoryMessageLike[],
  participants: readonly AttributionParticipant[],
): void {
  const userMessages = messages.filter(message => message.role === 'user');
  if (userMessages.length === 0) {
    throw new Error('expectUnattributedHistory: no user-role history messages were assembled.');
  }
  const prefixes = attributionPrefixes(participants);
  for (const message of userMessages) {
    for (const prefix of prefixes) {
      if (message.content.trimStart().startsWith(prefix)) {
        throw new Error(
          `expectUnattributedHistory: DM history line unexpectedly carries a group attribution `
          + `prefix "${prefix}".`,
        );
      }
    }
  }
}

/**
 * Assert that none of the `forbiddenTexts` (memory sentinels that belong to a
 * different conversation scope) appear in the assembled output. This is the
 * core leak assertion: DM-only content must never surface in a room prompt,
 * room-A content must never surface in room-B, etc.
 */
export function expectNoMemoryFrom(
  output: string,
  scopeLabel: string,
  forbiddenTexts: readonly string[],
): void {
  for (const forbidden of forbiddenTexts) {
    if (output.includes(forbidden)) {
      throw new Error(
        `expectNoMemoryFrom: memory scoped to "${scopeLabel}" leaked into the assembled `
        + `output: ${JSON.stringify(forbidden)}.`,
      );
    }
  }
}

/** Assert that every expected in-scope memory sentinel is present in the output. */
export function expectMemoryPresent(output: string, expectedTexts: readonly string[]): void {
  for (const expected of expectedTexts) {
    if (!output.includes(expected)) {
      throw new Error(
        `expectMemoryPresent: expected in-scope memory is missing from the assembled `
        + `output: ${JSON.stringify(expected)}.`,
      );
    }
  }
}

/**
 * Assert that the core-memory `<participant_context ...>` element binds to the
 * expected canonical DM partner (name and, when provided, id attributes).
 * Encodes the "core memory follows an arbitrary history speaker instead of the
 * canonical contact" defect when used with a polluted DM window.
 */
export function expectParticipantContextBinding(
  prompt: string,
  expected: { name: string; id?: string },
): void {
  const location = locateBlock(prompt, 'participant_context');
  if (location === null) {
    throw new Error(
      'expectParticipantContextBinding: prompt is missing the <participant_context> element.',
    );
  }
  const openTagEnd = prompt.indexOf('>', location.start);
  const openTag = prompt.slice(location.start, openTagEnd + 1);
  const nameAttribute = `name="${expected.name}"`;
  if (!openTag.includes(nameAttribute)) {
    throw new Error(
      `expectParticipantContextBinding: <participant_context> is not bound to `
      + `${JSON.stringify(expected.name)}. Open tag: ${openTag}`,
    );
  }
  if (expected.id !== undefined) {
    const idAttribute = `id="${expected.id}"`;
    if (!openTag.includes(idAttribute)) {
      throw new Error(
        `expectParticipantContextBinding: <participant_context> id is not `
        + `${JSON.stringify(expected.id)}. Open tag: ${openTag}`,
      );
    }
  }
}
