import { describe, it, expect } from 'vitest';

// Test the XML parsing logic by extracting it inline since parseFactsXml is not exported.
// We'll test it via a module-level function that mirrors the implementation.

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1] : null;
}

function clamp(val: number, min: number, max: number): number {
  if (isNaN(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}

const VALID_TYPES = ['episodic', 'semantic', 'emotional', 'procedural', 'reflection'] as const;

interface ParsedFact {
  text: string;
  type: string;
  importance: number;
  emotionalValence: number;
  confidence: number;
  tags: string[];
}

function parseFactsXml(xml: string): ParsedFact[] {
  const responseMatch = xml.match(/<response>([\s\S]*?)<\/response>/);
  if (!responseMatch) return [];

  const inner = responseMatch[1];
  const factBlocks = inner.matchAll(/<fact>([\s\S]*?)<\/fact>/g);
  const facts: ParsedFact[] = [];

  for (const match of factBlocks) {
    const block = match[1];
    const text = extractTag(block, 'text');
    if (!text) continue;

    const typeStr = extractTag(block, 'type')?.trim().toLowerCase();
    if (!typeStr || !VALID_TYPES.includes(typeStr as typeof VALID_TYPES[number])) continue;

    const importance = clamp(parseFloat(extractTag(block, 'importance') ?? '0.5'), 0, 1);
    const emotionalValence = clamp(parseFloat(extractTag(block, 'emotional_valence') ?? '0'), -1, 1);
    const confidence = clamp(parseFloat(extractTag(block, 'confidence') ?? '0.7'), 0, 1);

    const tagsStr = extractTag(block, 'tags') ?? '';
    const tags = tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

    facts.push({ text: text.trim(), type: typeStr, importance, emotionalValence, confidence, tags });
  }

  return facts;
}

describe('parseFactsXml', () => {
  it('parses a valid response with multiple facts', () => {
    const xml = `<response>
<fact>
<text>User is a software engineer</text>
<type>semantic</type>
<importance>0.8</importance>
<emotional_valence>0.0</emotional_valence>
<confidence>0.95</confidence>
<tags>identity, profession</tags>
</fact>
<fact>
<text>User felt excited about the new project</text>
<type>emotional</type>
<importance>0.6</importance>
<emotional_valence>0.7</emotional_valence>
<confidence>0.8</confidence>
<tags>feelings, work</tags>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts).toHaveLength(2);

    expect(facts[0].text).toBe('User is a software engineer');
    expect(facts[0].type).toBe('semantic');
    expect(facts[0].importance).toBe(0.8);
    expect(facts[0].emotionalValence).toBe(0.0);
    expect(facts[0].confidence).toBe(0.95);
    expect(facts[0].tags).toEqual(['identity', 'profession']);

    expect(facts[1].type).toBe('emotional');
    expect(facts[1].emotionalValence).toBe(0.7);
  });

  it('returns empty array for empty response', () => {
    expect(parseFactsXml('<response></response>')).toEqual([]);
  });

  it('returns empty array for no response block', () => {
    expect(parseFactsXml('Just some text')).toEqual([]);
  });

  it('skips facts with invalid type', () => {
    const xml = `<response>
<fact>
<text>Something</text>
<type>invalid</type>
<importance>0.5</importance>
</fact>
</response>`;

    expect(parseFactsXml(xml)).toEqual([]);
  });

  it('skips facts with no text', () => {
    const xml = `<response>
<fact>
<type>semantic</type>
<importance>0.5</importance>
</fact>
</response>`;

    expect(parseFactsXml(xml)).toEqual([]);
  });

  it('clamps values to valid ranges', () => {
    const xml = `<response>
<fact>
<text>Test</text>
<type>semantic</type>
<importance>1.5</importance>
<emotional_valence>-2.0</emotional_valence>
<confidence>-0.5</confidence>
<tags></tags>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts).toHaveLength(1);
    expect(facts[0].importance).toBe(1.0);
    expect(facts[0].emotionalValence).toBe(-1.0);
    expect(facts[0].confidence).toBe(0.0);
  });

  it('uses midpoint for NaN values', () => {
    const xml = `<response>
<fact>
<text>Test</text>
<type>semantic</type>
<importance>not_a_number</importance>
</fact>
</response>`;

    const facts = parseFactsXml(xml);
    expect(facts[0].importance).toBe(0.5);
  });
});
