#!/usr/bin/env node

import tls from "node:tls";

const TLS_GROUPS = [
  "X25519MLKEM768",
  "SecP256r1MLKEM768",
  "X25519",
  "P-256",
  "P-384",
];

const WEBCRYPTO_ALGORITHMS = [
  { name: "ML-KEM-512", usages: ["encapsulateBits", "decapsulateBits"] },
  { name: "ML-KEM-768", usages: ["encapsulateBits", "decapsulateBits"] },
  { name: "ML-KEM-1024", usages: ["encapsulateBits", "decapsulateBits"] },
  { name: "ML-DSA-44", usages: ["sign", "verify"] },
  { name: "ML-DSA-65", usages: ["sign", "verify"] },
  { name: "ML-DSA-87", usages: ["sign", "verify"] },
];

// Static self-signed certificate used only for loopback TLS handshake probing.
const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUV4P61n3XtlIkzexqJrv+jmw/zYwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDYyNzIwMTUxMVoXDTM2MDYy
NDIwMTUxMVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAzlCaIOWBPItCY+dDK50SmzNtSry94SW5LSBxUup968X9
gkHpt1nLWXjtNgwtwF+THkhxyMZiYIM2TsQHpSPuZZMDx4y+IHb3003Qb9tIf3m9
7zeBDJiVlrVs4yBfpNy4afgOM6EffQSNNtWQ9WMrKuT5EP6N/xDcfSowaHFynrju
gfRQGHVR2pbWJLvjP41l+RGGBYbD/Xv5zF1MO6d3XY+MM1cfAoCXLKEksYKDRLjO
mgNuvL6bYp1jqnrE6okbpbTWKGwoaevI08b6eQJVAvC1MwOyxjSCMp8/DjdIUY9Z
x9W7hmUJd0eJ8opBboq5mxA3vwMdIIPemMEucm3UoQIDAQABo28wbTAdBgNVHQ4E
FgQUKmsPeINxemVthC+5VR990KscVuIwHwYDVR0jBBgwFoAUKmsPeINxemVthC+5
VR990KscVuIwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBACKfLwqWxVOZWDZJGZVqBRqj2Y/z+3AH
a2hVwQdhYf8Q2L81Pt3adUFSql4X/mNaBBVeylRhco8/PGdB1gL5rvywJZAn++uh
8Bmw7+WOINX07gpGFq2dqUBUHbJQkq0TywwyuoNJdg4IKsavONWU3nix/IIdA3E+
3Ew1XUjBBUYr/ewzy/ItALX/j2EhlfrNtiA5Iwgq6MpbvlHXO7LY9dzvVxl2bIEJ
lxL7AqS1q4m/HZ5CGobk9dT63T1miug7LE/gwMxuvBLJCWNs7xn17QA+D1DcFQCi
VWehGKtekAcSEvEpDRuUANJAet498Zs/IGa06nPhc+jxy3ifjU71kXQ=
-----END CERTIFICATE-----
`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDOUJog5YE8i0Jj
50MrnRKbM21KvL3hJbktIHFS6n3rxf2CQem3WctZeO02DC3AX5MeSHHIxmJggzZO
xAelI+5lkwPHjL4gdvfTTdBv20h/eb3vN4EMmJWWtWzjIF+k3Lhp+A4zoR99BI02
1ZD1Yysq5PkQ/o3/ENx9KjBocXKeuO6B9FAYdVHaltYku+M/jWX5EYYFhsP9e/nM
XUw7p3ddj4wzVx8CgJcsoSSxgoNEuM6aA268vptinWOqesTqiRultNYobChp68jT
xvp5AlUC8LUzA7LGNIIynz8ON0hRj1nH1buGZQl3R4nyikFuirmbEDe/Ax0gg96Y
wS5ybdShAgMBAAECggEAErqZGJ4ST/9e/4K27kv2rHAhXm9+go8ncu6cWv0+gRtw
GqsGdHE1AeJLEQ+kokS1g5eVUgya/E1CWNQi0t2i0/Bh9MjUrvhzIZN8IIC04XLu
cxDZfjM7y8/xxTc4d4GHRtdl3U9QdHY9UNpXq8Rc3tVPvDiKMLrEc/hTJ1K6fP39
gKUe6lFJE7Rzp5yXf3IraAcJViLdadngymJWbJIen/on5P8CcogAejT5qMQtehS7
8tzEPIVbz8OlhzHk3WgikhfxcqkU21bxrKGiTKI4WIbR2e103YBqXbpyiBgv1lV3
jaICOdqWzKD2HvrZbg/TkHg3n5iHqIHuumdz/mrroQKBgQD8Qx63XSRG1oVS44w2
RrzaHGhF3PuTqhVyhdD1xi0V1VeMxkjLvbKe/2qI7ccRbOwMf3fDD9pOFG82To1z
Xl5pFEwNUIsU9p0an70dcTSkD4r2XOKXAD+kfTtpL/bcZG1KPd7xOhR0F51kTsx5
YC45J68VQqy4LTHNfb2+a5v8ZwKBgQDRXzHfNduC04Wp+ps7UEtunyqgUrRYSMJx
D5CMb9UCFls7BBwea0ELtAkd/A0a8JrQPCK3Uvn5jKA8ukYSlObiF44KIwtS1HL0
RkFyY/rqqjmUk9Xi9gmkEiCyiBMZfK63ZRAnw+c3xiTOx2LFCJHnXaTyL3NXtb90
D2M0kJABtwKBgQCSb/Q4xVz1sjoa7/TI3S9r/emaBLoV8joZDQ1MXwp1Di+QjNpd
S3WRTvvtGPriZrRwXN6M4Xr8sGgOwnLicfmkTiAH6qWSOcbhWbFSkhDY3Bzy/uCa
f45yUjBW030eWz4GRvxQVELjUYIQZJ3WJ7stepfsY5QYJkQu4btv+s/GKQJ/GivM
EBqrVa8bBiRNQxzGUQ2URnYQFPkDVR6c8vEHrzscLERXP3Yoq03V1emrubJZp63c
qQ22MXtijDS8jZYPRjOrjZjT0Ya818vwYlwdAThF+kyAb95RVjDt5WMdABKVxFbd
rhrOzCn4b+B8eCSaGFGcTKmhwVT2mYtS2z82wQKBgQD3W6oYbUXSisL4B9xYNACH
QN/XgtMFSj7uVLhCHagscZjK9wgG35DIW0f4azpDCwz2avn+OUjasAERL2LWtIGm
iPdmg4zsX9ZM7WfCz3pp8e05pQwAGyIDYU346C2v+AHsVAylNsObNsYvy+u0aR4Z
Zfv7C28c5whNXHsQcMX2tQ==
-----END PRIVATE KEY-----
`;

const warnings = [];

process.emitWarning = (warning, ...args) => {
  if (warning instanceof Error) {
    warnings.push({
      name: warning.name,
      message: warning.message,
    });
    return;
  }

  const [type] = args;
  warnings.push({
    name: typeof type === "string" ? type : "Warning",
    message: String(warning),
  });
};

function summarizeError(error) {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    code: typeof error.code === "string" ? error.code : null,
    message: error.message,
  };
}

function normalizeEphemeralKeyInfo(info) {
  if (!info || typeof info !== "object") {
    return null;
  }

  return {
    type: info.type ?? null,
    name: info.name ?? null,
    size: info.size ?? null,
    exposed: Boolean(info.type ?? info.name ?? info.size),
  };
}

function probeTlsContext(group) {
  try {
    tls.createSecureContext({ ecdhCurve: group });
    return { accepted: true };
  } catch (error) {
    return {
      accepted: false,
      error: summarizeError(error),
    };
  }
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve) => {
    server.close(resolve);
  });
}

async function probeTlsHandshake(group) {
  let server;
  let client;
  let timeout;
  let settled = false;

  return await new Promise((resolve) => {
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      client?.destroy();

      if (!server) {
        resolve(result);
        return;
      }

      closeServer(server).then(() => resolve(result));
    };

    try {
      server = tls.createServer(
        {
          cert: TEST_TLS_CERT,
          key: TEST_TLS_KEY,
          ecdhCurve: group,
          minVersion: "TLSv1.3",
          maxVersion: "TLSv1.3",
        },
        (socket) => {
          socket.end();
        },
      );
    } catch (error) {
      finish({
        ok: false,
        stage: "serverContext",
        error: summarizeError(error),
      });
      return;
    }

    timeout = setTimeout(() => {
      finish({
        ok: false,
        stage: "timeout",
        error: { message: "TLS handshake timed out" },
      });
    }, 5000);

    server.on("error", (error) => {
      finish({
        ok: false,
        stage: "server",
        error: summarizeError(error),
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        finish({
          ok: false,
          stage: "serverListen",
          error: { message: "TLS probe server did not expose a TCP port" },
        });
        return;
      }

      try {
        client = tls.connect(
          {
            host: "127.0.0.1",
            port: address.port,
            ecdhCurve: group,
            rejectUnauthorized: false,
            minVersion: "TLSv1.3",
            maxVersion: "TLSv1.3",
          },
          () => {
            const ephemeralKeyInfo = normalizeEphemeralKeyInfo(
              client.getEphemeralKeyInfo?.(),
            );

            finish({
              ok: true,
              protocol: client.getProtocol(),
              cipher: client.getCipher(),
              ephemeralKeyInfo,
              groupNameExposed: Boolean(ephemeralKeyInfo?.exposed),
            });
          },
        );
      } catch (error) {
        finish({
          ok: false,
          stage: "clientContext",
          error: summarizeError(error),
        });
        return;
      }

      client.on("error", (error) => {
        finish({
          ok: false,
          stage: "client",
          error: summarizeError(error),
        });
      });
    });
  });
}

async function probeWebCryptoAlgorithm(algorithm) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return {
      name: algorithm.name,
      ok: false,
      error: { message: "globalThis.crypto.subtle is unavailable" },
    };
  }

  try {
    const keyPair = await subtle.generateKey(
      { name: algorithm.name },
      false,
      algorithm.usages,
    );

    return {
      name: algorithm.name,
      ok: true,
      publicKey: {
        type: keyPair.publicKey.type,
        algorithm: keyPair.publicKey.algorithm,
        usages: keyPair.publicKey.usages,
      },
      privateKey: {
        type: keyPair.privateKey.type,
        algorithm: keyPair.privateKey.algorithm,
        usages: keyPair.privateKey.usages,
      },
    };
  } catch (error) {
    return {
      name: algorithm.name,
      ok: false,
      error: summarizeError(error),
    };
  }
}

function relevantCiphers() {
  return tls.getCiphers().filter((cipher) => {
    return /tls_aes|tls_chacha|chacha20|mlkem|kyber|pqc/i.test(cipher);
  });
}

const tlsGroups = [];
for (const group of TLS_GROUPS) {
  const context = probeTlsContext(group);
  tlsGroups.push({
    name: group,
    context,
    handshake: context.accepted ? await probeTlsHandshake(group) : null,
  });
}

const webcryptoAlgorithms = [];
for (const algorithm of WEBCRYPTO_ALGORITHMS) {
  webcryptoAlgorithms.push(await probeWebCryptoAlgorithm(algorithm));
}

const report = {
  probe: "node-pqc-surface",
  image: process.env.NODE_PQC_PROBE_IMAGE ?? null,
  runtime: {
    node: process.version,
    openssl: process.versions.openssl,
    modules: process.versions.modules,
    napi: process.versions.napi,
    platform: process.platform,
    arch: process.arch,
  },
  tls: {
    defaultEcdhCurve: tls.DEFAULT_ECDH_CURVE,
    defaultMinVersion: tls.DEFAULT_MIN_VERSION,
    defaultMaxVersion: tls.DEFAULT_MAX_VERSION,
    ciphers: relevantCiphers(),
    note: "TLS PQC hybrids are supported groups, not cipher suites; Node does not list supported TLS groups directly.",
    groups: tlsGroups,
  },
  webcrypto: {
    subtleAvailable: Boolean(globalThis.crypto?.subtle),
    algorithms: webcryptoAlgorithms,
    warnings,
  },
};

console.log(JSON.stringify(report, null, 2));
