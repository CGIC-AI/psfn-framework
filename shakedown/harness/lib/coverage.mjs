// Coverage-appendix parser for the shakedown scorecard.
//
// docs/shakedown.md carries a per-sprint coverage appendix: an "In scope"
// markdown table of the surfaces that must be exercised this round. The
// scorecard cross-checks every one of those rows against the executed cases —
// a green scorecard whose coverage rows are untouched is itself a failure
// (docs/shakedown.md, "Standing scripted components": the Sprint-9 failure
// mode). This module turns the appendix table into structured rows.

import { readFileSync } from 'node:fs';

function splitTableRow(line) {
  // Trim the leading/trailing pipe, then split on unescaped pipes.
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

/**
 * Parse the markdown pipe-table that immediately follows the first heading
 * matching `headingPattern`. Returns { columns, rows } where each row is an
 * object keyed by the (lowercased, slugged) column headers, plus `_cells`.
 */
export function parseSectionTable(markdown, headingPattern) {
  const lines = markdown.split('\n');
  let index = lines.findIndex((line) => headingPattern.test(line));
  if (index < 0) {
    throw new Error(`Coverage appendix section not found: ${headingPattern}`);
  }
  // Advance to the first table row (a line starting with '|').
  index += 1;
  while (index < lines.length && !lines[index].trim().startsWith('|')) {
    if (/^#{1,6}\s/.test(lines[index])) {
      throw new Error(`No coverage table under section ${headingPattern}`);
    }
    index += 1;
  }
  if (index >= lines.length) {
    throw new Error(`No coverage table under section ${headingPattern}`);
  }

  const header = splitTableRow(lines[index]);
  const columns = header.map((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  index += 1;

  const rows = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim().startsWith('|')) break;
    const cells = splitTableRow(line);
    if (isSeparatorRow(cells)) continue;
    const row = { _cells: cells };
    columns.forEach((col, colIndex) => {
      row[col] = cells[colIndex] ?? '';
    });
    rows.push(row);
  }
  return { columns, rows };
}

/**
 * Extract the in-scope coverage surfaces from docs/shakedown.md. Each returned
 * entry has a stable `key` (slug of the surface name) plus the raw columns.
 */
export function parseCoverageAppendix(docPath) {
  const markdown = readFileSync(docPath, 'utf8');
  const { rows } = parseSectionTable(markdown, /^###\s+In scope/i);
  return rows.map((row) => {
    const surface = row.surface ?? row._cells[0] ?? '';
    return {
      key: slugifySurface(surface),
      surface,
      lane: row.lane_tier ?? row._cells[1] ?? '',
      howExercised: row.how_exercised ?? row._cells[2] ?? '',
      notes: row.notes ?? row._cells[3] ?? '',
    };
  }).filter((entry) => entry.surface.length > 0);
}

export function slugifySurface(surface) {
  return surface
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
