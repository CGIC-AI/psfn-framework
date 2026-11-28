import { MESSAGE_CLASSES } from './message-classes.js';
import type { SystemNoteMessage } from './messages.js';

// ── Pseudo tool-call detection (psfn-framework-mv4xr) ──
//
// Some models (Kimi, GLM) occasionally write a tool call into their reply text
// instead of emitting a structured call. The runtime never executes text: a
// serialized call in the final reply means the intended action did not run,
// and a reply that reads as if it did is a fabrication. This module only
// recognizes such text; the turn runtime decides what to do with it.
//
// Recognized shape: an explicit tool-call tag followed directly by a
// registered tool name. Tags are the provider tag family seen in live
// replies and model chat templates:
//   <tool_call>identity.rollback_layer({...})</tool_call>
//   <tool_call>{"name": "identity", "args": {...}}</tool_call>
//   <tool_call>get_weather <arg_key>city</arg_key>...         (GLM template)
//   <|tool_call|> session complete_focus
//   <|tool_call_begin|>functions.north_star:0<|tool_call_argument_begin|>{...}  (Kimi)
// Prose that merely names a tool, bare JSON (a structured reply is data), and
// tags not followed by a registered tool name are not pseudo calls.

const TOOL_CALL_TAG = /<\|?\s*tool_calls?((?:_[a-z]+)*)\s*\|?>/giu;
const NAMED_JSON_CALL = /^\{\s*"name"\s*:\s*"([^"\\]+)"/u;
const IDENTIFIER_CALL = /^(?:functions\.)?([A-Za-z][A-Za-z0-9_-]*)/u;

function isClosingTagSuffix(suffix: string): boolean {
  return suffix.endsWith('_end');
}

function firstCalledName(afterTag: string): string | undefined {
  const rest = afterTag.trimStart();
  return NAMED_JSON_CALL.exec(rest)?.[1] ?? IDENTIFIER_CALL.exec(rest)?.[1];
}

/**
 * Registered tool names written as a serialized call in reply text, in order
 * of first appearance. Empty when the text contains no pseudo call.
 */
export function detectPseudoToolCalls(
  responseText: string,
  registeredToolNames: readonly string[],
): string[] {
  if (responseText.length === 0 || registeredToolNames.length === 0) return [];
  const registered = new Set(registeredToolNames);
  const detected: string[] = [];
  for (const tag of responseText.matchAll(TOOL_CALL_TAG)) {
    if (isClosingTagSuffix(tag[1] ?? '')) continue;
    const name = firstCalledName(responseText.slice(tag.index + tag[0].length));
    if (name !== undefined && registered.has(name) && !detected.includes(name)) {
      detected.push(name);
    }
  }
  return detected;
}

/**
 * The one corrective note fed back to the model after a pseudo call. It
 * continues the same turn, so tool calls that already ran are not replayed.
 */
export function buildPseudoToolCallCorrectionNote(toolNames: readonly string[]): SystemNoteMessage {
  return {
    role: 'custom',
    type: 'systemNote',
    messageClass: MESSAGE_CLASSES.systemNote,
    content: `Runtime correction: your last reply wrote a call to ${toolNames.join(', ')} as text. `
      + 'Text in a reply is never executed, so that action did not run. If it is still needed, '
      + 'make a real tool call now through the tool-calling interface. Otherwise reply normally, '
      + 'without tool-call markup, and do not claim the action happened.',
    timestamp: Date.now(),
  };
}

/** Non-fabricating reply when the corrective retry still wrote a call as text. */
export const PSEUDO_TOOL_CALL_CORRECTION =
  'I wrote a tool call as text instead of running it, so that action was not carried out.';
