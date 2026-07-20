#!/usr/bin/env node

import { readFileSync } from "node:fs";

const DEFAULT_RULES_PATH = new URL(
  "../../.github/pr-label-rules.json",
  import.meta.url,
);

export function loadRules(path = DEFAULT_RULES_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function countedLines(file, excludedPaths) {
  if (excludedPaths.has(file.filename)) return 0;
  return Number(file.additions ?? 0) + Number(file.deletions ?? 0);
}

export function classifyPullRequest(files, rules = loadRules()) {
  const exclusions = new Set(rules.lineCountExclusions);
  const lineCount = files.reduce(
    (total, file) => total + countedLines(file, exclusions),
    0,
  );
  const size = rules.sizes.find(
    ({ maximum }) => maximum === null || lineCount <= maximum,
  );
  if (!size) throw new Error(`No size rule covers ${lineCount} changed lines`);

  const labels = new Set([size.label]);
  for (const system of rules.systems) {
    const patterns = system.patterns.map((pattern) => new RegExp(pattern, "i"));
    if (
      files.some(({ filename }) =>
        patterns.some((pattern) => pattern.test(filename)),
      )
    ) {
      labels.add(system.label);
    }
  }

  return { labels: [...labels].sort(), lineCount };
}

export function reconcileManagedLabels(
  currentLabels,
  desiredLabels,
  managedPrefixes,
) {
  const isManaged = (label) =>
    managedPrefixes.some((prefix) => label.startsWith(prefix));
  const current = new Set(currentLabels);
  const desired = new Set(desiredLabels);

  return {
    add: [...desired].filter((label) => !current.has(label)).sort(),
    remove: [...current]
      .filter((label) => isManaged(label) && !desired.has(label))
      .sort(),
  };
}
