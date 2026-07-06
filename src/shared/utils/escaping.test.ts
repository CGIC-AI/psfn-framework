import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  escapeXmlAttribute,
  escapeXmlAttributeWithApostrophe,
  escapeXmlText,
} from './escaping.js';

interface EscapeCase {
  name: string;
  input: string;
  expected: string;
}

interface EscapeHelperCase {
  name: string;
  escape: (value: string) => string;
  cases: EscapeCase[];
}

const alreadyEscapedSequences = '&amp; &lt; &quot; &#39; &apos;';
const doubleEscapedSequences = '&amp;amp; &amp;lt; &amp;quot; &amp;#39; &amp;apos;';
const unicodeText = '\u2603 \u{1F600} cafe\u0301 & text';
const escapedUnicodeText = '\u2603 \u{1F600} cafe\u0301 &amp; text';

const helperCases: EscapeHelperCase[] = [
  {
    name: 'escapeXmlText',
    escape: escapeXmlText,
    cases: [
      { name: 'ordinary text', input: 'plain text', expected: 'plain text' },
      { name: 'XML special chars', input: '&<>"\'', expected: '&amp;&lt;&gt;"\'' },
      {
        name: 'already-escaped sequences',
        input: alreadyEscapedSequences,
        expected: doubleEscapedSequences,
      },
      { name: 'empty string', input: '', expected: '' },
      { name: 'unicode', input: unicodeText, expected: escapedUnicodeText },
    ],
  },
  {
    name: 'escapeXmlAttribute',
    escape: escapeXmlAttribute,
    cases: [
      { name: 'ordinary text', input: 'plain text', expected: 'plain text' },
      { name: 'XML special chars', input: '&<>"\'', expected: '&amp;&lt;&gt;&quot;\'' },
      {
        name: 'already-escaped sequences',
        input: alreadyEscapedSequences,
        expected: doubleEscapedSequences,
      },
      { name: 'empty string', input: '', expected: '' },
      { name: 'unicode', input: unicodeText, expected: escapedUnicodeText },
    ],
  },
  {
    name: 'escapeXmlAttributeWithApostrophe',
    escape: escapeXmlAttributeWithApostrophe,
    cases: [
      { name: 'ordinary text', input: 'plain text', expected: 'plain text' },
      { name: 'XML special chars', input: '&<>"\'', expected: '&amp;&lt;&gt;&quot;&apos;' },
      {
        name: 'already-escaped sequences',
        input: alreadyEscapedSequences,
        expected: doubleEscapedSequences,
      },
      { name: 'empty string', input: '', expected: '' },
      { name: 'unicode', input: unicodeText, expected: escapedUnicodeText },
    ],
  },
  {
    name: 'escapeHtml',
    escape: escapeHtml,
    cases: [
      { name: 'ordinary text', input: 'plain text', expected: 'plain text' },
      { name: 'HTML special chars', input: '&<>"\'', expected: '&amp;&lt;&gt;&quot;&#39;' },
      {
        name: 'already-escaped sequences',
        input: alreadyEscapedSequences,
        expected: doubleEscapedSequences,
      },
      { name: 'empty string', input: '', expected: '' },
      { name: 'unicode', input: unicodeText, expected: escapedUnicodeText },
    ],
  },
];

describe('escaping utils', () => {
  for (const helperCase of helperCases) {
    describe(helperCase.name, () => {
      it.each(helperCase.cases)('$name', ({ input, expected }) => {
        expect(helperCase.escape(input)).toBe(expected);
      });
    });
  }
});
