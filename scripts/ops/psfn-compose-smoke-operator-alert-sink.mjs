#!/usr/bin/env node

import { createServer } from 'node:http';
import process from 'node:process';

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const host = requireEnvironment('PSFN_SMOKE_OPERATOR_ALERT_HOST');
const portValue = requireEnvironment('PSFN_SMOKE_OPERATOR_ALERT_PORT');
const topic = requireEnvironment('PSFN_SMOKE_OPERATOR_ALERT_TOPIC');
if (!/^[1-9]\d*$/.test(portValue) || Number(portValue) > 65_535) {
  throw new Error('PSFN_SMOKE_OPERATOR_ALERT_PORT must be an integer from 1 through 65535');
}

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?', 1)[0];
  request.resume();

  if (request.method === 'GET' && path === '/health') {
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'POST' && path === `/${encodeURIComponent(topic)}`) {
    response.writeHead(204, { 'x-message-id': 'compose-smoke' }).end();
    return;
  }
  response.writeHead(404).end();
});

server.listen(Number(portValue), host, () => {
  console.log('[operator-alert-sink] ready; request bodies are discarded');
});

function close() {
  server.close(() => process.exit(0));
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
