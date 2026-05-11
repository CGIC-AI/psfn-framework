import { describe, it, expect } from 'vitest';
import { extractCodeBlock, detectFinalInText, detectFinalVar, parseResponse } from './parse.js';

describe('extractCodeBlock', () => {
  it('extracts ```repl blocks', () => {
    const text = 'Here is code:\n```repl\nconst x = 1;\nprint(x);\n```\nDone.';
    expect(extractCodeBlock(text)).toBe('const x = 1;\nprint(x);');
  });

  it('extracts ```javascript blocks', () => {
    const text = '```javascript\nconsole.log("hi");\n```';
    expect(extractCodeBlock(text)).toBe('console.log("hi");');
  });

  it('extracts ```js blocks', () => {
    const text = '```js\nlet a = 2;\n```';
    expect(extractCodeBlock(text)).toBe('let a = 2;');
  });

  it('extracts bare ``` blocks', () => {
    const text = '```\nbare code\n```';
    expect(extractCodeBlock(text)).toBe('bare code');
  });

  it('returns null when no code block present', () => {
    expect(extractCodeBlock('Just some text')).toBeNull();
  });

  it('extracts the last code block when multiple are present', () => {
    const text = '```repl\nfirst\n```\n\n```repl\nsecond\n```';
    expect(extractCodeBlock(text)).toBe('second');
  });
});

describe('detectFinalInText', () => {
  it('detects FINAL with double quotes', () => {
    expect(detectFinalInText('FINAL("the answer")')).toBe('the answer');
  });

  it('detects FINAL with single quotes', () => {
    expect(detectFinalInText("FINAL('the answer')")).toBe('the answer');
  });

  it('detects FINAL with backticks', () => {
    expect(detectFinalInText('FINAL(`the answer`)')).toBe('the answer');
  });

  it('detects FINAL with surrounding text', () => {
    expect(detectFinalInText('Based on my analysis:\nFINAL("result here")\n')).toBe('result here');
  });

  it('ignores FINAL inside code blocks', () => {
    const text = '```repl\nFINAL("inside code")\n```';
    expect(detectFinalInText(text)).toBeNull();
  });

  it('returns null when no FINAL present', () => {
    expect(detectFinalInText('No final here')).toBeNull();
  });

  it('handles multiline answers', () => {
    expect(detectFinalInText('FINAL("line1\nline2")')).toBe('line1\nline2');
  });

  it('detects FINAL with raw structured payloads', () => {
    expect(detectFinalInText('FINAL({"answer":"ok","count":2})')).toBe('{"answer":"ok","count":2}');
  });
});

describe('detectFinalVar', () => {
  it('detects FINAL_VAR with variable name', () => {
    expect(detectFinalVar('FINAL_VAR(result)')).toBe('result');
  });

  it('handles whitespace', () => {
    expect(detectFinalVar('FINAL_VAR( myVar )')).toBe('myVar');
  });

  it('ignores FINAL_VAR inside code blocks', () => {
    const text = '```repl\nFINAL_VAR(x)\n```';
    expect(detectFinalVar(text)).toBeNull();
  });

  it('returns null when no FINAL_VAR present', () => {
    expect(detectFinalVar('No final var here')).toBeNull();
  });
});

describe('parseResponse', () => {
  it('returns final when FINAL in text (even with code block)', () => {
    const text = 'FINAL("answer")\n```repl\ncode\n```';
    const result = parseResponse(text);
    expect(result.type).toBe('final');
    if (result.type === 'final') expect(result.answer).toBe('answer');
  });

  it('returns final_var when FINAL_VAR present', () => {
    const result = parseResponse('FINAL_VAR(summary)');
    expect(result.type).toBe('final_var');
    if (result.type === 'final_var') expect(result.varName).toBe('summary');
  });

  it('returns code when only code block present', () => {
    const text = 'Let me compute:\n```repl\nprint(42);\n```';
    const result = parseResponse(text);
    expect(result.type).toBe('code');
    if (result.type === 'code') expect(result.code).toBe('print(42);');
  });

  it('returns none when no action detected', () => {
    expect(parseResponse('Just thinking out loud...')).toEqual({ type: 'none' });
  });

  it('FINAL takes priority over code', () => {
    // FINAL outside code block + code block both present
    const text = 'Done!\nFINAL("done")\n```repl\nmore code\n```';
    const result = parseResponse(text);
    expect(result.type).toBe('final');
  });
});
