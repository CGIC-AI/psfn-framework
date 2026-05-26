import http from "node:http";
import net from "node:net";
import process from "node:process";

const options = parseArgs(process.argv.slice(2));
const listenHost = options.listenHost ?? process.env.VOXTA_BRIDGE_LISTEN_HOST ?? "127.0.0.1";
const listenPort = Number.parseInt(options.listenPort ?? process.env.VOXTA_BRIDGE_LISTEN_PORT ?? "8791", 10);
const signalrTarget = new URL(options.signalr ?? process.env.VOXTA_SIGNALR_TARGET ?? "http://127.0.0.1:8789");
const apiTarget = new URL(options.api ?? process.env.VOXTA_API_TARGET ?? "http://purrsephone.local.vega.nyc:8789");

if (!Number.isInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
  throw new Error("Listen port must be a valid TCP port");
}

const server = http.createServer((request, response) => {
  const target = isApiRequest(request.url || "/") ? apiTarget : signalrTarget;
  proxyHttp(request, response, target);
});

server.on("upgrade", (request, socket, head) => {
  const target = isApiRequest(request.url || "/") ? apiTarget : signalrTarget;
  proxyUpgrade(request, socket, head, target);
});

server.listen(listenPort, listenHost, () => {
  console.log(`Voxta local REST bridge listening on http://${listenHost}:${listenPort}`);
  console.log(`  /hub -> ${signalrTarget.origin}`);
  console.log(`  /api -> ${apiTarget.origin}`);
});

function isApiRequest(rawPath) {
  return rawPath.startsWith("/api/") || rawPath.startsWith("/ws/audio/");
}

function proxyHttp(request, response, targetBase) {
  const targetUrl = targetUrlFor(request.url || "/", targetBase);
  const upstream = http.request(
    targetUrl,
    {
      method: request.method,
      headers: rewriteHeaders(request.headers, targetUrl),
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "application/json" });
    }
    response.end(JSON.stringify({ error: error.message }));
  });
  request.pipe(upstream);
}

function proxyUpgrade(request, socket, head, targetBase) {
  const targetUrl = targetUrlFor(request.url || "/", targetBase);
  const upstream = net.connect(resolvePort(targetUrl), targetUrl.hostname, () => {
    upstream.write(`${request.method} ${targetUrl.pathname}${targetUrl.search} HTTP/${request.httpVersion}\r\n`);
    const headers = rewriteHeaders(request.headers, targetUrl);
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          upstream.write(`${name}: ${item}\r\n`);
        }
      } else if (value !== undefined) {
        upstream.write(`${name}: ${value}\r\n`);
      }
    }
    upstream.write("\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => {
    socket.destroy();
  });
}

function targetUrlFor(rawPath, targetBase) {
  const target = new URL(targetBase.href);
  const requestUrl = new URL(rawPath, targetBase);
  target.pathname = joinUrlPath(target.pathname, requestUrl.pathname);
  target.search = requestUrl.search;
  return target;
}

function joinUrlPath(basePath, requestPath) {
  const normalizedBase = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  return `${normalizedBase}${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`;
}

function rewriteHeaders(headers, targetUrl) {
  return {
    ...headers,
    host: targetUrl.host,
  };
}

function resolvePort(url) {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--listen" && next) {
      const [host, port] = splitHostPort(next);
      parsed.listenHost = host;
      parsed.listenPort = port;
      index += 1;
    } else if (arg === "--signalr" && next) {
      parsed.signalr = next;
      index += 1;
    } else if (arg === "--api" && next) {
      parsed.api = next;
      index += 1;
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function splitHostPort(value) {
  const separator = value.lastIndexOf(":");
  if (separator === -1) {
    return [value, undefined];
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function printHelp() {
  console.log(`Usage:
  node scripts/voxta-local-rest-bridge.mjs \\
    --listen 127.0.0.1:8791 \\
    --signalr http://127.0.0.1:8789 \\
    --api http://purrsephone.local.vega.nyc:8789

Point the VaM plugin at the bridge listen port. Keep the official Voxta proxy
on --signalr for the SignalR session; REST, vision, and audio websocket routes
go to --api.`);
}
