import { describe, expect, it } from 'vitest';
import {
  classifyVoiceControlIntent,
  normalizeVoiceControlText,
  type VoiceControlIntent,
} from './control-intent.js';

describe('classifyVoiceControlIntent (mmo9.7.5)', () => {
  const cases: Array<[string, VoiceControlIntent]> = [
    ['stop', 'stop'],
    ['Stop.', 'stop'],
    ['STOP!', 'stop'],
    ['stop talking', 'stop'],
    ['please stop', 'stop'],
    ['hey stop please', 'stop'],
    ['be quiet', 'stop'],
    ['shut up', 'stop'],
    ['cancel that', 'stop'],
    ["that's enough", 'stop'],
    ['never mind', 'stop'],
    // d8vq.1: bare 'wait'/'pause' dropped; deictic/multi-word interrupt forms
    // still classify.
    ['wait a second', 'interrupt'],
    ['wait wait', 'interrupt'],
    ['pause that', 'interrupt'],
    ['hold on', 'interrupt'],
    ['hang on', 'interrupt'],
    ['one moment', 'interrupt'],
    ['repeat', 'repeat'],
    ['repeat that', 'repeat'],
    ['say that again', 'repeat'],
    ['say again', 'repeat'],
    ['can you repeat that', 'repeat'],
    ['what did you say', 'repeat'],
    ['one more time', 'repeat'],
    ['pardon', 'repeat'],
  ];

  it.each(cases)('classifies %j as %s', (text, expected) => {
    expect(classifyVoiceControlIntent(text)).toBe(expected);
  });

  // d8vq.1: bare single words that double as ordinary semantic verbs are NOT
  // controls — a lone "wait" / "pause" / "cancel" / "again" must reach the
  // model as a conversational turn. Only their unambiguous deictic/multi-word
  // forms classify (asserted in `cases` above).
  const droppedBareVerbs = ['wait', 'pause', 'cancel', 'again'];

  it.each(droppedBareVerbs)('does not classify bare semantic verb %j as a control', (text) => {
    expect(classifyVoiceControlIntent(text)).toBeNull();
  });

  const nonControls = [
    '',
    '   ',
    'stop by the store on your way home',
    'can you say hi to her again for me',
    'what time is it',
    'tell me a story about a cat',
    'i need you to wait for the delivery tomorrow',
    'repeat the recipe steps but slower and add butter',
    'that movie was not enough action for me',
  ];

  it.each(nonControls)('does not classify ordinary speech %j', (text) => {
    expect(classifyVoiceControlIntent(text)).toBeNull();
  });

  it('normalizes casing, punctuation, apostrophes, and edge fillers', () => {
    expect(normalizeVoiceControlText("  Hey, STOP!!  ")).toBe('stop');
    expect(normalizeVoiceControlText("that's enough")).toBe('thats enough');
    expect(normalizeVoiceControlText('repeat that please')).toBe('repeat that');
  });
});
