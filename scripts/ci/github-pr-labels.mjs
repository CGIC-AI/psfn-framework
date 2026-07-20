#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  classifyPullRequest,
  loadRules,
  reconcileManagedLabels,
} from "./pr-label-classifier.mjs";

const CATALOG_PATH = new URL("../../.github/labels.json", import.meta.url);

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function apiClient(env) {
  const token = requiredEnv(env, "GITHUB_TOKEN");
  const root = (env.GITHUB_API_URL ?? "https://api.github.com").replace(
    /\/$/,
    "",
  );

  return async (path, options = {}) => {
    const response = await fetch(`${root}${path}`, {
      ...options,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "repository-pr-labels",
        "x-github-api-version": "2022-11-28",
        ...options.headers,
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1_000);
      throw new Error(
        `${options.method ?? "GET"} ${path} failed (${response.status}): ${detail}`,
      );
    }
    if (response.status === 204) return null;
    return response.json();
  };
}

async function paginated(api, path, maximumPages = 30) {
  const values = [];
  for (let page = 1; page <= maximumPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await api(`${path}${separator}per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  return values;
}

export async function applyLabels(env = process.env) {
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const pullRequest = requiredEnv(env, "PR_NUMBER");
  if (!/^\d+$/.test(pullRequest))
    throw new Error("PR_NUMBER must be an integer");
  const api = apiClient(env);
  const rules = loadRules();
  const files = await paginated(
    api,
    `/repos/${repository}/pulls/${pullRequest}/files`,
  );
  const current = await paginated(
    api,
    `/repos/${repository}/issues/${pullRequest}/labels`,
  );
  const classified = classifyPullRequest(files, rules);
  const changes = reconcileManagedLabels(
    current.map(({ name }) => name),
    classified.labels,
    rules.managedPrefixes,
  );

  if (changes.add.length > 0) {
    await api(`/repos/${repository}/issues/${pullRequest}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: changes.add }),
      headers: { "content-type": "application/json" },
    });
  }
  for (const label of changes.remove) {
    await api(
      `/repos/${repository}/issues/${pullRequest}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE" },
    );
  }

  console.log(
    `PR #${pullRequest}: ${classified.lineCount} counted lines; ` +
      `labels=${classified.labels.join(", ")}; add=${changes.add.join(", ") || "none"}; ` +
      `remove=${changes.remove.join(", ") || "none"}`,
  );
}

export async function syncCatalog(env = process.env) {
  const repository = requiredEnv(env, "GITHUB_REPOSITORY");
  const api = apiClient(env);
  const desired = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const existing = await paginated(api, `/repos/${repository}/labels`, 10);
  const byName = new Map(
    existing.map((label) => [label.name.toLowerCase(), label]),
  );
  let created = 0;
  let updated = 0;

  for (const label of desired) {
    const current = byName.get(label.name.toLowerCase());
    if (!current) {
      await api(`/repos/${repository}/labels`, {
        method: "POST",
        body: JSON.stringify(label),
        headers: { "content-type": "application/json" },
      });
      created += 1;
      continue;
    }
    if (
      current.color.toUpperCase() !== label.color.toUpperCase() ||
      current.description !== label.description
    ) {
      await api(
        `/repos/${repository}/labels/${encodeURIComponent(current.name)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            color: label.color,
            description: label.description,
          }),
          headers: { "content-type": "application/json" },
        },
      );
      updated += 1;
    }
  }

  console.log(
    `Label catalog synchronized: ${created} created, ${updated} updated, ` +
      `${desired.length - created - updated} unchanged; no labels deleted`,
  );
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command] = argv;
  if (command === "apply") return applyLabels(env);
  if (command === "sync") return syncCatalog(env);
  throw new Error("Usage: github-pr-labels.mjs <apply|sync>");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
