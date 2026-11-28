import { describe, expect, it } from 'vitest';

import { buildPseudoToolCallCorrectionNote, detectPseudoToolCalls } from './pseudo-tool-call-guard.js';
import { convertToLlm } from './messages.js';

// Invented samples that keep the exact shapes models wrote into replies in
// live shakedown rounds (Kimi and GLM primaries); identifiers are fictional.
const REGISTERED = ['identity', 'session', 'north_star', 'image_edit', 'notify'];

describe('detectPseudoToolCalls (psfn-framework-mv4xr)', () => {
  it('detects a tagged dotted call with JSON arguments', () => {
    const reply = 'Finishing the sequence now. <tool_call>identity.rollback_layer({"layer_id":"layer-demo-1","version":1})</tool_call>';
    expect(detectPseudoToolCalls(reply, REGISTERED)).toEqual(['identity']);
  });

  it('detects a tagged JSON object that names a registered tool', () => {
    const reply = 'Emitting the call: <tool_call>{"name": "identity", "args": {"action": "rollback_layer", "version": 1}}</tool_call>';
    expect(detectPseudoToolCalls(reply, REGISTERED)).toEqual(['identity']);
  });

  it('detects the GLM chat-template argument form', () => {
    const reply = '<tool_call>image_edit\n<arg_key>prompt</arg_key>\n<arg_value>add a red scarf</arg_value>\n</tool_call>';
    expect(detectPseudoToolCalls(reply, REGISTERED)).toEqual(['image_edit']);
  });

  it('detects a Kimi special-token call, including the functions. prefix and section wrapper', () => {
    expect(detectPseudoToolCalls('Real call: <|tool_call|> session complete_focus', REGISTERED)).toEqual(['session']);
    const kimi = '<|tool_calls_section_begin|><|tool_call_begin|>functions.north_star:0'
      + '<|tool_call_argument_begin|>{"action": "create", "title": "Demo"}<|tool_call_end|><|tool_calls_section_end|>';
    expect(detectPseudoToolCalls(kimi, REGISTERED)).toEqual(['north_star']);
  });

  it('reports each tool once, in order of first appearance', () => {
    const reply = '<tool_call>north_star.list({})</tool_call> then <tool_call>identity.get_layer({})</tool_call>'
      + ' and again <tool_call>north_star.list({})</tool_call>';
    expect(detectPseudoToolCalls(reply, REGISTERED)).toEqual(['north_star', 'identity']);
  });

  it('ignores markers that are not followed by a registered tool name', () => {
    expect(detectPseudoToolCalls('<tool_call> retry, use a structured call.', REGISTERED)).toEqual([]);
    expect(detectPseudoToolCalls('<tool_call>\n\n<rollback>\n\n<invoke>', REGISTERED)).toEqual([]);
    expect(detectPseudoToolCalls('<tool_call>weather_lookup({"city":"Oslo"})</tool_call>', REGISTERED)).toEqual([]);
    expect(detectPseudoToolCalls('<|tool_call_end|> session ended', REGISTERED)).toEqual([]);
  });

  it('does not misfire on prose, structured data replies, or empty text', () => {
    expect(detectPseudoToolCalls('I used north_star and identity earlier; both worked.', REGISTERED)).toEqual([]);
    expect(detectPseudoToolCalls('{"name": "identity", "created": true}', REGISTERED)).toEqual([]);
    // A toolCall-only assistant message has no text blocks, so its extracted
    // reply text is empty; a real call with empty arguments never reaches text.
    expect(detectPseudoToolCalls('', REGISTERED)).toEqual([]);
    expect(detectPseudoToolCalls('<tool_call>identity.list_layers({})</tool_call>', [])).toEqual([]);
  });
});

describe('buildPseudoToolCallCorrectionNote', () => {
  it('names the tools and reaches the model as a runtime note', () => {
    const note = buildPseudoToolCallCorrectionNote(['identity']);
    expect(note.content).toContain('identity');
    expect(note.content).toContain('never executed');
    const [llmMessage] = convertToLlm([note]);
    expect(llmMessage?.role).toBe('user');
    expect(JSON.stringify(llmMessage?.content)).toContain('make a real tool call now');
  });
});
