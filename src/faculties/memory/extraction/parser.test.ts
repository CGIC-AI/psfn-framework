import { describe, expect, it } from 'vitest';
import { parseFactsXml } from './parser.js';

describe('parseFactsXml', () => {
  it('parses structured group attribution fields', () => {
    const facts = parseFactsXml(`<response>
<fact>
<text>Morgan is helping run moderation tonight.</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.95</confidence>
<source_message_ids>12, 14 14</source_message_ids>
<source_span>12-14</source_span>
<source_speaker_name>Example Partner</source_speaker_name>
<subject_name>Morgan</subject_name>
<subject_contact_id>contact-morgan</subject_contact_id>
<address_mode>overheard_room_context</address_mode>
</fact>
</response>`);

    expect(facts).toHaveLength(1);
    expect(facts[0].attribution).toEqual({
      sourceMessageIds: [12, 14],
      sourceSpanStartMessageId: 12,
      sourceSpanEndMessageId: 14,
      sourceSpeakerName: 'Example Partner',
      subjectName: 'Morgan',
      subjectContactId: 'contact-morgan',
      addressMode: 'overheard_room_context',
    });
  });

  it('ignores malformed attribution values without rejecting the fact', () => {
    const facts = parseFactsXml(`<response>
<fact>
<text>Example Partner likes jasmine tea.</text>
<type>semantic</type>
<importance>0.9</importance>
<confidence>0.95</confidence>
<source_message_ids>zero, -1, 5</source_message_ids>
<source_span>9-2</source_span>
<address_mode>not_real</address_mode>
</fact>
</response>`);

    expect(facts).toHaveLength(1);
    expect(facts[0].attribution).toEqual({
      sourceMessageIds: [5],
    });
  });

  it('parses durable retention metadata for extracted preference facts', () => {
    const facts = parseFactsXml(`<response>
<fact>
<text>Morgan's favorite color is teal.</text>
<type>semantic</type>
<importance>0.82</importance>
<confidence>0.95</confidence>
<tags>preference, favorite</tags>
<retention_class>durable</retention_class>
</fact>
</response>`);

    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      text: "Morgan's favorite color is teal.",
      retentionClass: 'durable',
      tags: ['preference', 'favorite'],
    });
  });
});
