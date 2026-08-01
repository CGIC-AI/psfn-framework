import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const TUNING_TOKENS = new Set([
  'TIMEOUT',
  'LIMIT',
  'MAX',
  'MIN',
  'THRESHOLD',
  'INTERVAL',
  'BUDGET',
  'CAP',
  'COOLDOWN',
  'DELAY',
  'BACKOFF',
  'CONCURRENCY',
  'CADENCE',
  'RETRY',
  'RETRIES',
  'LIMITS',
  'THRESHOLDS',
  'INTERVALS',
  'BUDGETS',
  'CAPS',
  'COOLDOWNS',
  'DELAYS',
  'BACKOFFS',
  'CONCURRENCIES',
  'CADENCES',
  'POLICY',
  'POLICIES',
]);

const REGEX_NAME_TOKENS = new Set([
  'MARKER',
  'MARKERS',
  'PATTERN',
  'PATTERNS',
  'REGEX',
  'REGEXES',
  'REGEXP',
]);
// A regex-shaped name alone describes syntax, not mutable policy. Marker names
// are policy-shaped by themselves; other regex names need a second security,
// persona, tuning, or policy token. This keeps ordinary parsers out of the debt
// inventory while still covering conformance and refusal marker expressions.
const REGEX_POLICY_TOKENS = new Set([
  'ALLOW',
  'ALLOWED',
  'ASSISTANT',
  'ATTACK',
  'BLOCK',
  'BLOCKED',
  'CONTROL',
  'CREDENTIAL',
  'DENY',
  'DENIED',
  'DIRECTIONAL',
  'FORBIDDEN',
  'IDENTITY',
  'INJECTION',
  'MARKER',
  'MARKERS',
  'MUTATION',
  'PERSONA',
  'PII',
  'POLICY',
  'PROMPT',
  'REDACT',
  'SAFETY',
  'SEALED',
  'SECRET',
  'SECURITY',
  'TRUST',
  'UNSAFE',
]);

// Bare `min`/`max` members dominate validation-schema objects. A containing
// policy-shaped declaration is still detected as an object, but these weak
// leaf names need a stronger sibling token to avoid drowning the baseline.
const WEAK_OBJECT_MEMBER_TOKENS = new Set(['MAX', 'MIN']);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '__tests__',
  '__fixtures__',
  '__mocks__',
  'fixtures',
]);

const ARITHMETIC_OPERATORS = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
]);

function normalizePath(root, path) {
  return relative(root, path).split('\\').join('/');
}

function segmentTokens(name) {
  return name
    .replace(/^#/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .split(/_+/u)
    .filter(Boolean)
    .map(token => token.toUpperCase());
}

function isTuningName(name) {
  return segmentTokens(name).some(token => TUNING_TOKENS.has(token));
}

function isPolicyRegexName(name) {
  const tokens = segmentTokens(name);
  return tokens.some(token => REGEX_NAME_TOKENS.has(token))
    && tokens.some(token => (
      TUNING_TOKENS.has(token) || REGEX_POLICY_TOKENS.has(token)
    ));
}

function isObjectMemberTuningName(name) {
  const tokens = segmentTokens(name);
  if (tokens.length === 1 && WEAK_OBJECT_MEMBER_TOKENS.has(tokens[0])) return false;
  return tokens.some(token => TUNING_TOKENS.has(token));
}

function isPolicyValueName(name, valueKind) {
  return valueKind === 'regex' ? isPolicyRegexName(name) : isTuningName(name);
}

function collectSourceFiles(directory, files) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      collectSourceFiles(path, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!/\.tsx?$/u.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/u.test(name)) continue;
    if (name.endsWith('.d.ts')) continue;
    files.push(path);
  }
}

function unwrapExpression(node) {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function isNumericExpression(node) {
  const expression = unwrapExpression(node);
  if (ts.isNumericLiteral(expression)) return true;
  if (ts.isPrefixUnaryExpression(expression)) {
    return (
      expression.operator === ts.SyntaxKind.PlusToken
      || expression.operator === ts.SyntaxKind.MinusToken
    ) && isNumericExpression(expression.operand);
  }
  return ts.isBinaryExpression(expression)
    && ARITHMETIC_OPERATORS.has(expression.operatorToken.kind)
    && isNumericExpression(expression.left)
    && isNumericExpression(expression.right);
}

function isStringExpression(node) {
  const expression = unwrapExpression(node);
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression);
}

function isRegexExpression(node) {
  const expression = unwrapExpression(node);
  if (expression.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  return (
    ts.isCallExpression(expression) || ts.isNewExpression(expression)
  ) && ts.isIdentifier(expression.expression) && expression.expression.text === 'RegExp';
}

function isLiteralArrayExpression(node) {
  const expression = unwrapExpression(node);
  return ts.isArrayLiteralExpression(expression)
    && expression.elements.length > 0
    && expression.elements.every(element => (
      !ts.isSpreadElement(element)
      && (isNumericExpression(element) || isStringExpression(element))
    ));
}

function isLiteralObjectExpression(node) {
  const expression = unwrapExpression(node);
  if (!ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some(property => (
    ts.isPropertyAssignment(property) && policyValueKind(property.initializer) !== null
  ));
}

function policyValueKind(node) {
  if (isNumericExpression(node)) return 'number';
  if (isStringExpression(node)) return 'string';
  if (isRegexExpression(node)) return 'regex';
  if (isLiteralArrayExpression(node)) return 'array';
  if (isLiteralObjectExpression(node)) return 'object';
  return null;
}

function propertyNameText(name) {
  if (
    ts.isIdentifier(name)
    || ts.isPrivateIdentifier(name)
    || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression);
    if (
      ts.isStringLiteral(expression)
      || ts.isNoSubstitutionTemplateLiteral(expression)
      || ts.isNumericLiteral(expression)
    ) {
      return expression.text;
    }
  }
  return null;
}

function sourceValue(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/gu, ' ').trim();
}

function sourceLine(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isModuleConstNumber(node, valueKind) {
  if (valueKind !== 'number') return false;
  const declarationList = node.parent;
  const statement = declarationList?.parent;
  return ts.isVariableDeclarationList(declarationList)
    && (declarationList.flags & ts.NodeFlags.Const) !== 0
    && ts.isVariableStatement(statement)
    && ts.isSourceFile(statement.parent);
}

function entryForm(node, valueKind) {
  return isModuleConstNumber(node, valueKind) ? undefined : valueKind;
}

function addEntry(found, sourceFile, file, node, name, valueNode, form) {
  found.push({
    file,
    name,
    value: sourceValue(valueNode, sourceFile),
    line: sourceLine(node, sourceFile),
    ...(form ? { form } : {}),
  });
}

function scanNamedInitializer(
  found,
  sourceFile,
  file,
  node,
  name,
  initializer,
  scope,
  declarationForm,
  containerIsPolicy = false,
) {
  const qualifiedName = [...scope, name].join('.');
  const valueKind = policyValueKind(initializer);
  const shouldAdd = valueKind !== null
    && (isPolicyValueName(name, valueKind) || containerIsPolicy)
    && (valueKind !== 'object' || !objectContainsTuningMember(initializer));
  if (shouldAdd) {
    addEntry(
      found,
      sourceFile,
      file,
      node,
      qualifiedName,
      initializer,
      declarationForm === 'variable' ? entryForm(node, valueKind) : declarationForm,
    );
  }
  return qualifiedName;
}

function objectContainsTuningMember(initializer) {
  const object = unwrapExpression(initializer);
  if (!ts.isObjectLiteralExpression(object)) return false;
  return object.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const propertyName = propertyNameText(property.name);
    const valueKind = policyValueKind(property.initializer);
    return (
      Boolean(propertyName)
      && valueKind !== null
      && isObjectMemberTuningName(propertyName)
    ) || objectContainsTuningMember(property.initializer);
  });
}

function anonymousObjectRootName(node, sourceFile, scope) {
  let contextualNode = node;
  let parent = contextualNode.parent;
  while (
    parent
    && (
      ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isTypeAssertionExpression(parent)
      || ts.isSatisfiesExpression(parent)
    )
    && parent.expression === contextualNode
  ) {
    contextualNode = parent;
    parent = contextualNode.parent;
  }
  if (ts.isCallExpression(parent)) {
    const argumentIndex = parent.arguments.indexOf(contextualNode);
    return [...scope, `${sourceValue(parent.expression, sourceFile)}.arg${argumentIndex}`].join('.');
  }
  if (ts.isBinaryExpression(parent) && parent.right === contextualNode) {
    return [...scope, sourceValue(parent.left, sourceFile)].join('.');
  }
  if (scope.length > 0) return scope.join('.');
  return `object@L${sourceLine(node, sourceFile)}`;
}

function embeddedExecutableSource(node, sourceFile) {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return null;
  if (!/(?:CHILD|WORKER)_SOURCE$/u.test(node.name.text) || !node.initializer) return null;
  const initializer = unwrapExpression(node.initializer);
  let template;
  if (ts.isNoSubstitutionTemplateLiteral(initializer)) {
    template = initializer;
  } else if (
    ts.isTaggedTemplateExpression(initializer)
    && sourceValue(initializer.tag, sourceFile) === 'String.raw'
    && ts.isNoSubstitutionTemplateLiteral(initializer.template)
  ) {
    template = initializer.template;
  } else {
    return null;
  }
  const templateText = template.getText(sourceFile);
  return {
    text: templateText.slice(1, -1),
    lineOffset: sourceLine(template, sourceFile) - 1,
  };
}

function scanSourceFile(sourceFile, file) {
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const line = diagnostic.start === undefined
      ? 1
      : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    throw new Error(`cannot parse ${file}:${line}: ${message}`);
  }

  const found = [];

  function visit(node, scope, objectRootName) {
    if (ts.isFunctionDeclaration(node)) {
      const nextScope = node.name ? [...scope, node.name.text] : scope;
      if (node.body) visit(node.body, nextScope);
      return;
    }

    if (
      ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
    ) {
      const name = propertyNameText(node.name);
      const nextScope = name ? [...scope, name] : scope;
      if (node.body) visit(node.body, nextScope);
      return;
    }

    if (ts.isConstructorDeclaration(node)) {
      if (node.body) visit(node.body, [...scope, 'constructor']);
      return;
    }

    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const nextScope = node.name ? [...scope, node.name.text] : scope;
      for (const member of node.members) visit(member, nextScope);
      return;
    }

    if (ts.isPropertyDeclaration(node)) {
      const name = propertyNameText(node.name);
      if (!name || !node.initializer) return;
      const qualifiedName = scanNamedInitializer(
        found,
        sourceFile,
        file,
        node,
        name,
        node.initializer,
        scope,
        'class-field',
        scope.length > 0 && isTuningName(scope.at(-1)),
      );
      visit(node.initializer, scope, qualifiedName);
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      const enumName = node.name.text;
      const enumIsPolicy = isTuningName(enumName);
      for (const member of node.members) {
        const memberName = propertyNameText(member.name);
        if (!memberName || (!enumIsPolicy && !isTuningName(memberName))) continue;
        if (member.initializer && policyValueKind(member.initializer) === null) continue;
        found.push({
          file,
          name: [...scope, enumName, memberName].join('.'),
          value: member.initializer ? sourceValue(member.initializer, sourceFile) : '<implicit>',
          line: sourceLine(member, sourceFile),
          form: 'enum-member',
        });
      }
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      const qualifiedName = scanNamedInitializer(
        found,
        sourceFile,
        file,
        node,
        name,
        node.initializer,
        scope,
        'variable',
      );
      const embedded = embeddedExecutableSource(node, sourceFile);
      if (embedded) {
        const embeddedSourceFile = ts.createSourceFile(
          file,
          embedded.text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        );
        found.push(...scanSourceFile(embeddedSourceFile, file).map(entry => ({
          ...entry,
          line: entry.line + embedded.lineOffset,
        })));
      }
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        visit(node.initializer.body, [...scope, name]);
      } else {
        visit(node.initializer, scope, qualifiedName);
      }
      return;
    }

    if (ts.isObjectLiteralExpression(node)) {
      const rootName = objectRootName ?? anonymousObjectRootName(node, sourceFile, scope);
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) {
          visit(property, scope);
          continue;
        }
        const propertyName = propertyNameText(property.name);
        if (!propertyName) {
          visit(property.initializer, scope);
          continue;
        }
        const qualifiedName = `${rootName}.${propertyName}`;
        const valueKind = policyValueKind(property.initializer);
        if (
          valueKind !== null
          && isObjectMemberTuningName(propertyName)
          && (valueKind !== 'object' || !objectContainsTuningMember(property.initializer))
        ) {
          addEntry(
            found,
            sourceFile,
            file,
            property,
            qualifiedName,
            property.initializer,
            'object-member',
          );
        }
        visit(property.initializer, scope, qualifiedName);
      }
      return;
    }

    ts.forEachChild(node, child => visit(child, scope, objectRootName));
  }

  visit(sourceFile, []);
  return found;
}

function entryKey(entry) {
  return `${entry.file}::${entry.name}`;
}

function disambiguateDuplicateNames(found) {
  const counts = new Map();
  for (const entry of found) {
    const key = entryKey(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return found.map(entry => (
    counts.get(entryKey(entry)) > 1
      ? { ...entry, name: `${entry.name}@L${entry.line}` }
      : entry
  ));
}

export function scanHardcodedSettings(root) {
  const sourceRoot = join(root, 'src');
  const files = [];
  collectSourceFiles(sourceRoot, files);
  files.sort((left, right) => left.localeCompare(right));

  let found = [];
  for (const file of files) {
    const relativePath = normalizePath(root, file);
    const sourceFile = ts.createSourceFile(
      relativePath,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    found.push(...scanSourceFile(sourceFile, relativePath));
  }
  found = disambiguateDuplicateNames(found);
  found.sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.name.localeCompare(right.name)
    || left.line - right.line
  ));
  return found;
}
