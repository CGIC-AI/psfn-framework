#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const failures = [];

function addFailure(message) {
  failures.push(message);
}

function requireText(text, pattern, description) {
  if (!pattern.test(text)) {
    addFailure(description);
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getServiceBlock(composeText, serviceName) {
  const lines = composeText.split(/\r?\n/);
  const serviceHeader = new RegExp(`^\\s{2}${escapeRegex(serviceName)}:\\s*$`);
  const startIndex = lines.findIndex((line) => serviceHeader.test(line));
  if (startIndex === -1) {
    return null;
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      endIndex = i;
      break;
    }
    if (/^\s{2}[A-Za-z0-9_.-]+:\s*$/.test(line)) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join("\n");
}

const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const readme = await readFile(path.join(root, "README.md"), "utf8");
const operations = await readFile(path.join(root, "docs", "operations.md"), "utf8");
const setup = await readFile(path.join(root, "docs", "setup.md"), "utf8");
const productionCompose = await readFile(
  path.join(root, "docker", "docker-compose.production.yml"),
  "utf8",
);
const continuousCompose = await readFile(
  path.join(root, "docker", "docker-compose.yml"),
  "utf8",
);

const expectedAgentDockerCommand =
  "docker compose -f docker/docker-compose.production.yml up --build";
if (packageJson.scripts?.["agent:docker"] !== expectedAgentDockerCommand) {
  addFailure(
    `package.json scripts.agent:docker must equal "${expectedAgentDockerCommand}"`,
  );
}

const productionServiceBlock = getServiceBlock(
  productionCompose,
  "psfn-agent-production",
);
if (!productionServiceBlock) {
  addFailure(
    'docker/docker-compose.production.yml must define service "psfn-agent-production"',
  );
} else {
  requireText(
    productionServiceBlock,
    /^\s{4}network_mode:\s*["']?none["']?\s*$/m,
    'docker/docker-compose.production.yml service "psfn-agent-production" must set network_mode: "none"',
  );
  if (/^\s{6}(API_KEY|CONTINUITY_WATCHDOG_API_KEY):/m.test(productionServiceBlock)) {
    addFailure(
      'docker/docker-compose.production.yml service "psfn-agent-production" must not pass API_KEY or CONTINUITY_WATCHDOG_API_KEY into the agent',
    );
  }
}

const continuousServiceBlock = getServiceBlock(continuousCompose, "psfn-agent");
if (!continuousServiceBlock) {
  addFailure('docker/docker-compose.yml must define service "psfn-agent"');
} else {
  requireText(
    continuousServiceBlock,
    /^\s{4}networks:\s*$/m,
    'docker/docker-compose.yml service "psfn-agent" must attach to an isolated network list',
  );
  requireText(
    continuousServiceBlock,
    /^\s{6}-\s*psfn-continuous-net\s*$/m,
    'docker/docker-compose.yml service "psfn-agent" must use "psfn-continuous-net"',
  );
}

const continuousNetworkBlock = getServiceBlock(
  continuousCompose,
  "psfn-continuous-net",
);
if (!continuousNetworkBlock) {
  addFailure(
    'docker/docker-compose.yml must define network "psfn-continuous-net"',
  );
} else {
  requireText(
    continuousNetworkBlock,
    /^\s{4}internal:\s*true\s*$/m,
    'docker/docker-compose.yml network "psfn-continuous-net" must set internal: true',
  );
}

requireText(
  readme,
  /npm run agent:docker\s+# Production profile \(network_mode:\s*"none"\)/,
  'README.md must document "npm run agent:docker" as the production network_mode "none" profile',
);
requireText(
  readme,
  /npm run agent:docker:continuous\s+# Continuous\/dev profile \(isolated internal network\)/,
  'README.md must document "npm run agent:docker:continuous" as the continuous isolated profile',
);
requireText(
  operations,
  /npm run agent:docker\s+# Production profile \(network_mode:\s*"none"\)/,
  'docs/operations.md must document "npm run agent:docker" as the production network_mode "none" profile',
);
requireText(
  operations,
  /npm run agent:docker:continuous\s+# Continuous\/dev profile \(isolated internal network\)/,
  'docs/operations.md must document "npm run agent:docker:continuous" as the continuous isolated profile',
);
requireText(
  operations,
  /npm run verify:agent-docker-isolation/,
  'docs/operations.md must point operators to the Docker isolation verification script',
);
requireText(
  setup,
  /npm run agent:docker\s+# Production profile \(network_mode:\s*"none"\)/,
  'docs/setup.md must document "npm run agent:docker" as the production network_mode "none" profile',
);
requireText(
  setup,
  /npm run agent:docker:continuous\s+# Continuous\/dev profile \(isolated internal network\)/,
  'docs/setup.md must document "npm run agent:docker:continuous" as the continuous isolated profile',
);
requireText(
  setup,
  /npm run verify:agent-docker-isolation/,
  'docs/setup.md must point readers to the Docker isolation verification script',
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`ERROR: ${failure}`);
  }
  process.exit(1);
}

console.log("verify-agent-docker-isolation: OK");
