import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyPullRequest,
  loadRules,
  reconcileManagedLabels,
} from "./pr-label-classifier.mjs";

const rules = loadRules();
const catalog = JSON.parse(
  readFileSync(new URL("../../.github/labels.json", import.meta.url), "utf8"),
);

const expectedSystems = [
  "agent-tooling",
  "channels",
  "cogsec",
  "companion-ui",
  "docs",
  "emotion",
  "fleet-auth",
  "garden",
  "helm-ops",
  "icp",
  "memory",
  "metacog",
  "persistence",
  "prompts",
  "scheduler",
  "session",
  "shards",
  "testing",
  "voice",
  "world",
];

function file(filename, additions, deletions = 0) {
  return { filename, additions, deletions };
}

test("catalog and classifier cover every repository system label", () => {
  const catalogSystems = catalog
    .map(({ name }) => name)
    .filter((name) => name.startsWith("system:"))
    .map((name) => name.slice("system:".length))
    .sort();
  const ruleSystems = rules.systems
    .map(({ label }) => label.slice("system:".length))
    .sort();

  assert.deepEqual(catalogSystems, expectedSystems);
  assert.deepEqual(ruleSystems, expectedSystems);
});

test("classifies multi-system PRs and excludes lockfile churn from size", () => {
  const result = classifyPullRequest(
    [
      file("admin-ui/src/lib/stores/auth.svelte.ts", 20, 5),
      file("src/faculties/memory/postgres-store.ts", 15, 5),
      file("package-lock.json", 2_000, 1_000),
    ],
    rules,
  );

  assert.equal(result.lineCount, 45);
  assert.deepEqual(result.labels, [
    "size:XS",
    "system:garden",
    "system:memory",
  ]);
});

test("uses exactly one size label at every boundary", () => {
  const cases = [
    [0, "size:XS"],
    [50, "size:XS"],
    [51, "size:S"],
    [200, "size:S"],
    [201, "size:M"],
    [500, "size:M"],
    [501, "size:L"],
    [800, "size:L"],
    [801, "size:XL"],
  ];

  for (const [lines, expected] of cases) {
    const result = classifyPullRequest([file("unmatched.bin", lines)], rules);
    assert.deepEqual(result.labels, [expected]);
  }
});

test("removes stale managed labels without touching judgment labels", () => {
  assert.deepEqual(
    reconcileManagedLabels(
      ["kind:bug", "severity:high", "size:L", "system:docs"],
      ["size:S", "system:memory"],
      rules.managedPrefixes,
    ),
    {
      add: ["size:S", "system:memory"],
      remove: ["size:L", "system:docs"],
    },
  );
});

test("catalog entries have unique names and valid GitHub colors", () => {
  const names = catalog.map(({ name }) => name);
  assert.equal(new Set(names).size, names.length);
  for (const label of catalog) {
    assert.match(label.color, /^[0-9A-F]{6}$/);
    assert.ok(label.description.length > 0);
  }
});
