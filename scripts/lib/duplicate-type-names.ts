import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';
import { isRecord } from '../../src/shared/utils/types.js';

const require = createRequire(import.meta.url);
const ts = require('typescript') as typeof TypeScript;

export type DuplicateClassification = 'identical' | 'collision';

export interface ExportedTypeDeclaration {
  name: string;
  declarationKind: 'interface' | 'type' | 'enum';
  shape: string;
}

export interface DuplicateFinding {
  name: string;
  classification: DuplicateClassification;
  declarationKinds: string[];
  files: string[];
}

export interface DuplicateTypeBaselineEntry {
  name: string;
  kind: DuplicateClassification;
  files: string[];
  note: string;
}

export interface DuplicateTypeBaseline {
  schemaVersion: 1;
  entries: DuplicateTypeBaselineEntry[];
}

export interface BaselineComparison {
  newFindings: DuplicateFinding[];
  staleEntries: DuplicateTypeBaselineEntry[];
  kindChanges: Array<{
    name: string;
    baselineKind: DuplicateClassification;
    currentKind: DuplicateClassification;
  }>;
  fileChanges: Array<{
    name: string;
    added: string[];
    removed: string[];
  }>;
  matchedCount: number;
}

export interface BaselineUpdateResult {
  baseline: DuplicateTypeBaseline;
  refusals: string[];
  removedNames: string[];
  rewrittenNames: string[];
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeTypeNode(node: TypeScript.TypeNode): string {
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    const separator = ts.isUnionTypeNode(node) ? ' | ' : ' & ';
    return node.types.map(member => normalizeTypeNode(member)).sort().join(separator);
  }
  return collapseWhitespace(node.getText());
}

function normalizeTypeParameters(
  declaration: TypeScript.InterfaceDeclaration | TypeScript.TypeAliasDeclaration,
): string {
  if (!declaration.typeParameters || declaration.typeParameters.length === 0) {
    return '';
  }
  return `<${declaration.typeParameters.map(parameter => collapseWhitespace(parameter.getText())).join(', ')}>`;
}

function describeInterface(declaration: TypeScript.InterfaceDeclaration): string {
  const heritage = (declaration.heritageClauses ?? [])
    .map(clause => collapseWhitespace(clause.getText()))
    .sort();
  const members = declaration.members
    .map(member => collapseWhitespace(member.getText()))
    .sort();
  return [
    `interface${normalizeTypeParameters(declaration)}`,
    ...heritage,
    `{ ${members.join('; ')} }`,
  ].join(' ');
}

function describeTypeAlias(declaration: TypeScript.TypeAliasDeclaration): string {
  return `type${normalizeTypeParameters(declaration)} = ${normalizeTypeNode(declaration.type)}`;
}

function describeEnum(declaration: TypeScript.EnumDeclaration): string {
  const members = declaration.members
    .map(member => collapseWhitespace(member.getText()))
    .sort();
  return `enum { ${members.join('; ')} }`;
}

function hasExportModifier(node: TypeScript.Node): boolean {
  return (ts.getModifiers(node) ?? [])
    .some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/**
 * Extracts top-level exported interface/type-alias/enum definitions from source
 * text. Pure re-exports (`export { X } from`, `export * from`) never appear here
 * because only declarations are inspected. Whitespace, comments, jsdoc, and
 * union member order are normalized away so two spellings of the same shape
 * compare equal.
 */
export function extractDeclarationsFromSource(
  fileName: string,
  sourceText: string,
): ExportedTypeDeclaration[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declarations: ExportedTypeDeclaration[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && hasExportModifier(statement)) {
      declarations.push({
        name: statement.name.text,
        declarationKind: 'interface',
        shape: describeInterface(statement),
      });
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement)) {
      declarations.push({
        name: statement.name.text,
        declarationKind: 'type',
        shape: describeTypeAlias(statement),
      });
      continue;
    }
    if (ts.isEnumDeclaration(statement) && hasExportModifier(statement)) {
      declarations.push({
        name: statement.name.text,
        declarationKind: 'enum',
        shape: describeEnum(statement),
      });
    }
  }

  return declarations;
}

export function collectExportedTypeDeclarations(filePath: string): ExportedTypeDeclaration[] {
  return extractDeclarationsFromSource(filePath, readFileSync(filePath, 'utf-8'));
}

/**
 * Groups exported type declarations by name across files. A finding is a name
 * defined in two or more files: `identical` when every definition normalizes to
 * the same shape (consolidation candidate), `collision` when shapes differ.
 */
export function findDuplicateTypeNames(
  declarationsByFile: ReadonlyMap<string, readonly ExportedTypeDeclaration[]>,
): DuplicateFinding[] {
  const byName = new Map<string, Map<string, ExportedTypeDeclaration[]>>();

  for (const [file, declarations] of declarationsByFile) {
    for (const declaration of declarations) {
      let fileMap = byName.get(declaration.name);
      if (!fileMap) {
        fileMap = new Map();
        byName.set(declaration.name, fileMap);
      }
      const existing = fileMap.get(file) ?? [];
      existing.push(declaration);
      fileMap.set(file, existing);
    }
  }

  const findings: DuplicateFinding[] = [];
  for (const [name, fileMap] of byName) {
    if (fileMap.size < 2) {
      continue;
    }
    const shapes = new Set<string>();
    const declarationKinds = new Set<string>();
    for (const declarations of fileMap.values()) {
      for (const declaration of declarations) {
        shapes.add(`${declaration.declarationKind}:${declaration.shape}`);
        declarationKinds.add(declaration.declarationKind);
      }
    }
    findings.push({
      name,
      classification: shapes.size === 1 ? 'identical' : 'collision',
      declarationKinds: [...declarationKinds].sort(),
      files: [...fileMap.keys()].sort(),
    });
  }

  findings.sort((left, right) => left.name.localeCompare(right.name));
  return findings;
}

function requireNonEmptyString(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${description} must be a non-empty string.`);
  }
  return value;
}

function parseBaselineEntry(value: unknown, index: number): DuplicateTypeBaselineEntry {
  if (!isRecord(value)) {
    throw new Error(`Baseline entry at index ${index} must be an object.`);
  }
  const name = requireNonEmptyString(value.name, `Baseline entry at index ${index} name`);
  if (value.kind !== 'identical' && value.kind !== 'collision') {
    throw new Error(
      `Baseline entry "${name}" kind must be "identical" or "collision".`,
    );
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`Baseline entry "${name}" files must be a non-empty array.`);
  }
  const files = value.files.map((file, fileIndex) => requireNonEmptyString(
    file,
    `Baseline entry "${name}" file at index ${fileIndex}`,
  ));
  if (new Set(files).size !== files.length) {
    throw new Error(`Baseline entry "${name}" contains duplicate files.`);
  }
  const sortedFiles = [...files].sort();
  if (JSON.stringify(sortedFiles) !== JSON.stringify(files)) {
    throw new Error(`Baseline entry "${name}" files must be sorted.`);
  }
  // The note is the reviewed justification for accepting the duplicate; the
  // gate refuses entries without one, mirroring the hardcoded-settings
  // extended-baseline convention.
  const note = requireNonEmptyString(value.note, `Baseline entry "${name}" note`);
  return { name, kind: value.kind, files, note };
}

export function parseDuplicateTypeBaseline(raw: unknown): DuplicateTypeBaseline {
  if (!isRecord(raw)) {
    throw new Error('Duplicate-type baseline must be a JSON object.');
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(
      `Unsupported duplicate-type baseline schemaVersion: ${String(raw.schemaVersion)}`,
    );
  }
  if (!Array.isArray(raw.entries)) {
    throw new Error('Duplicate-type baseline entries must be an array.');
  }
  const entries = raw.entries.map(parseBaselineEntry);
  const names = entries.map(entry => entry.name);
  if (new Set(names).size !== names.length) {
    throw new Error('Duplicate-type baseline contains duplicate entry names.');
  }
  const sortedNames = [...names].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(sortedNames) !== JSON.stringify(names)) {
    throw new Error('Duplicate-type baseline entries must be sorted by name.');
  }
  return { schemaVersion: 1, entries };
}

export function readDuplicateTypeBaseline(baselinePath: string): DuplicateTypeBaseline {
  let rawText: string;
  try {
    rawText = readFileSync(baselinePath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Unable to read baseline file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Baseline file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseDuplicateTypeBaseline(parsed);
}

export function compareFindingsToBaseline(
  baseline: DuplicateTypeBaseline,
  findings: readonly DuplicateFinding[],
): BaselineComparison {
  const baselineByName = new Map(baseline.entries.map(entry => [entry.name, entry]));
  const findingsByName = new Map(findings.map(finding => [finding.name, finding]));

  const newFindings: DuplicateFinding[] = [];
  const kindChanges: BaselineComparison['kindChanges'] = [];
  const fileChanges: BaselineComparison['fileChanges'] = [];
  let matchedCount = 0;

  for (const finding of findings) {
    const entry = baselineByName.get(finding.name);
    if (!entry) {
      newFindings.push(finding);
      continue;
    }
    if (entry.kind !== finding.classification) {
      kindChanges.push({
        name: finding.name,
        baselineKind: entry.kind,
        currentKind: finding.classification,
      });
      continue;
    }
    const baselineFiles = new Set(entry.files);
    const currentFiles = new Set(finding.files);
    const added = finding.files.filter(file => !baselineFiles.has(file));
    const removed = entry.files.filter(file => !currentFiles.has(file));
    if (added.length > 0 || removed.length > 0) {
      fileChanges.push({ name: finding.name, added, removed });
      continue;
    }
    matchedCount += 1;
  }

  const staleEntries = baseline.entries.filter(entry => !findingsByName.has(entry.name));

  return { newFindings, staleEntries, kindChanges, fileChanges, matchedCount };
}

/**
 * Reduction-only baseline update. Carries reviewed notes forward by name and
 * refuses anything that would grow the accepted debt: new names, classifications
 * worsening from identical to collision, or a footprint growing to more files.
 * Shrinking footprints, dropped entries, and collision-to-identical improvements
 * are accepted.
 */
export function buildUpdatedBaseline(
  existing: DuplicateTypeBaseline,
  findings: readonly DuplicateFinding[],
): BaselineUpdateResult {
  const existingByName = new Map(existing.entries.map(entry => [entry.name, entry]));
  const refusals: string[] = [];
  const entries: DuplicateTypeBaselineEntry[] = [];
  const rewrittenNames: string[] = [];

  for (const finding of findings) {
    const entry = existingByName.get(finding.name);
    if (!entry) {
      refusals.push(
        `"${finding.name}" (${finding.classification}, ${finding.files.join(', ')}) is new; `
        + 'add a reviewed entry with a note to the baseline file by hand.',
      );
      continue;
    }
    if (entry.kind === 'identical' && finding.classification === 'collision') {
      refusals.push(
        `"${finding.name}" worsened from identical to collision; `
        + 'rename or consolidate the colliding declarations instead of baselining.',
      );
      continue;
    }
    const baselineFiles = new Set(entry.files);
    const added = finding.files.filter(file => !baselineFiles.has(file));
    if (added.length > 0) {
      refusals.push(
        `"${finding.name}" spread to new file(s): ${added.join(', ')}; `
        + 'review the new declaration(s) and update the entry by hand.',
      );
      continue;
    }
    if (
      entry.kind !== finding.classification
      || JSON.stringify(entry.files) !== JSON.stringify(finding.files)
    ) {
      rewrittenNames.push(finding.name);
    }
    entries.push({
      name: finding.name,
      kind: finding.classification,
      files: [...finding.files],
      note: entry.note,
    });
  }

  const findingNames = new Set(findings.map(finding => finding.name));
  const removedNames = existing.entries
    .filter(entry => !findingNames.has(entry.name))
    .map(entry => entry.name);

  entries.sort((left, right) => left.name.localeCompare(right.name));
  return {
    baseline: { schemaVersion: 1, entries },
    refusals,
    removedNames,
    rewrittenNames,
  };
}

export function serializeBaseline(baseline: DuplicateTypeBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}
