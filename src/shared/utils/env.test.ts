import { delimiter as pathDelimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseBooleanEnv,
  parseEnvList,
  parseOptionalPositiveIntEnv,
  parseOptionalStringEnv,
  parsePathListEnv,
  parsePositiveIntEnv,
} from './env.js';

describe('env utils', () => {
  describe('parsePositiveIntEnv', () => {
    it('returns parsed positive integers and falls back on invalid values', () => {
      expect(parsePositiveIntEnv('42', 5)).toBe(42);
      expect(parsePositiveIntEnv('0', 5)).toBe(5);
      expect(parsePositiveIntEnv('-7', 5)).toBe(5);
      expect(parsePositiveIntEnv('abc', 5)).toBe(5);
      expect(parsePositiveIntEnv(undefined, 5)).toBe(5);
    });
  });

  describe('parseOptionalPositiveIntEnv', () => {
    it('returns undefined when value is missing or invalid', () => {
      expect(parseOptionalPositiveIntEnv('17')).toBe(17);
      expect(parseOptionalPositiveIntEnv('0')).toBeUndefined();
      expect(parseOptionalPositiveIntEnv('-2')).toBeUndefined();
      expect(parseOptionalPositiveIntEnv('x')).toBeUndefined();
      expect(parseOptionalPositiveIntEnv(undefined)).toBeUndefined();
    });
  });

  describe('parseBooleanEnv', () => {
    it('accepts canonical true variants', () => {
      expect(parseBooleanEnv('true')).toBe(true);
      expect(parseBooleanEnv(' TRUE ')).toBe(true);
      expect(parseBooleanEnv('1')).toBe(true);
      expect(parseBooleanEnv('yes')).toBe(true);
      expect(parseBooleanEnv('on')).toBe(true);
    });

    it('accepts canonical false variants', () => {
      expect(parseBooleanEnv('false')).toBe(false);
      expect(parseBooleanEnv(' FALSE ')).toBe(false);
      expect(parseBooleanEnv('0')).toBe(false);
      expect(parseBooleanEnv('no')).toBe(false);
      expect(parseBooleanEnv('off')).toBe(false);
    });

    it('fails closed for invalid values', () => {
      expect(parseBooleanEnv('enabled')).toBeUndefined();
      expect(parseBooleanEnv('')).toBeUndefined();
      expect(parseBooleanEnv('   ')).toBeUndefined();
      expect(parseBooleanEnv(undefined)).toBeUndefined();
    });
  });

  describe('parseOptionalStringEnv', () => {
    it('returns trimmed strings and drops empty values', () => {
      expect(parseOptionalStringEnv('  token  ')).toBe('token');
      expect(parseOptionalStringEnv('')).toBeUndefined();
      expect(parseOptionalStringEnv('   ')).toBeUndefined();
      expect(parseOptionalStringEnv(undefined)).toBeUndefined();
    });
  });

  describe('parseEnvList', () => {
    it('splits, trims, and deduplicates comma-separated values by default', () => {
      expect(parseEnvList(' a, b ,, c ,a ')).toEqual(['a', 'b', 'c']);
    });

    it('supports custom separators and optional duplicate retention', () => {
      expect(parseEnvList('alpha|beta||alpha|gamma', { separators: ['|'] })).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
      expect(parseEnvList('alpha|beta||alpha|gamma', { separators: ['|'], dedupe: false })).toEqual([
        'alpha',
        'beta',
        'alpha',
        'gamma',
      ]);
    });

    it('returns undefined for missing or empty values', () => {
      expect(parseEnvList(undefined)).toBeUndefined();
      expect(parseEnvList('')).toBeUndefined();
      expect(parseEnvList(' , , ')).toBeUndefined();
    });
  });

  describe('parsePathListEnv', () => {
    it('splits on platform path delimiter with trimming and dedupe', () => {
      const raw = [' /tmp/a ', '/tmp/b', '/tmp/a', '', ' /tmp/c '].join(pathDelimiter);
      expect(parsePathListEnv(raw)).toEqual(['/tmp/a', '/tmp/b', '/tmp/c']);
    });

    it('returns undefined for missing path-list values', () => {
      expect(parsePathListEnv(undefined)).toBeUndefined();
      expect(parsePathListEnv('')).toBeUndefined();
      expect(parsePathListEnv(` ${pathDelimiter} `)).toBeUndefined();
    });
  });
});
