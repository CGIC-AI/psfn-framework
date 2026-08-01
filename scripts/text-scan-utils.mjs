import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.md',
  '.mjs',
  '.mmd',
  '.svelte',
  '.ts',
  '.tsx',
]);

/** @param {string} file */
export function toPosixPath(file) {
  return file.split(path.sep).join('/');
}

/** @param {string} file */
export function isTestSourceFile(file) {
  const normalized = toPosixPath(file);
  return normalized.includes('/__tests__/')
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

/**
 * @param {string} text
 * @param {number} index
 */
export function lineInfoForIndex(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = text.indexOf('\n', index);
  const boundedLineEnd = lineEnd === -1 ? text.length : lineEnd;
  let line = 1;
  for (let cursor = 0; cursor < lineStart; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }

  return {
    line,
    column: index - lineStart + 1,
    lineText: text.slice(lineStart, boundedLineEnd),
  };
}

export function listTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map(toPosixPath);
}

/**
 * @param {string[]} files
 * @param {(file: string) => boolean} shouldScan
 * @param {{ skipMissing?: boolean }} [options]
 */
export function readTextEntriesFromFiles(files, shouldScan, options = {}) {
  return files
    .map(toPosixPath)
    .filter(shouldScan)
    .filter(file => !(options.skipMissing === true && !existsSync(file)))
    .map(file => ({ path: file, text: readFileSync(file, 'utf8') }));
}
