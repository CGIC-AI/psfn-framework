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
    ['wait', 'interrupt'],
    ['hold on', 'interrupt'],
    ['hang on', 'interrupt'],
    ['one moment', 'interrupt'],
    ['pause', 'interrupt'],
    ['repeat', 'repeat'],
    ['repeat that', 'repeat'],
    ['say that again', 'repeat'],
    ['can you repeat that', 'repeat'],
    ['what did you say', 'repeat'],
    ['one more time', 'repeat'],
    ['pardon', 'repeat'],
  ];

  it.each(cases)('classifies %j as %s', (text, expected) => {
    expect(classifyVoiceControlIntent(text)).toBe(expected);
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
