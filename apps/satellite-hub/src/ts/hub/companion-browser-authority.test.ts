import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import { admitBrowserRequest, resolveBrowserSessionCookie } from "./companion-browser-authority.js";
import type { CompanionBrowserConfig } from "./companion-browser-config.js";

const COMPANION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = "s".repeat(43);
const config = {
  canonicalOrigin: "https://fleet.example.test",
  guestMode: "disabled",
} as unknown as CompanionBrowserConfig;

function request(cookies: string[]): IncomingMessage {
  const rawHeaders = ["Host", "fleet.example.test", "Origin", "https://fleet.example.test",
    ...cookies.flatMap(value => ["Cookie", value])];
  return {
    url: `/companion-ui/companions/${COMPANION_ID}/ws`,
    method: "GET",
    rawHeaders,
    headers: {
      host: "fleet.example.test",
      origin: "https://fleet.example.test",
      ...(cookies.length > 0 ? { cookie: cookies.join("; ") } : {}),
    },
  } as unknown as IncomingMessage;
}

test("admits the session cookie alongside unrelated cookies and forwards only the session", () => {
  const req = request([`__Host-psfn_preauth=abc; __Host-psfn_session=${SESSION}; psfn_token=zzz`]);
  assert.equal(admitBrowserRequest(req, config), COMPANION_ID);
  assert.deepEqual(resolveBrowserSessionCookie(req), {
    state: "valid",
    cookie: `__Host-psfn_session=${SESSION}`,
  });
});

test("still denies a malformed, duplicated, or missing session cookie without guest mode", () => {
  for (const cookies of [
    [`__Host-psfn_session=${SESSION}x; other=1`],
    [`__Host-psfn_session=${SESSION}; __Host-psfn_session=${SESSION}`],
    ["other=1"],
    [`__Host-psfn_session=${SESSION}`, "other=1"],
  ]) {
    assert.throws(() => admitBrowserRequest(request(cookies), config), /upgrade denied/u);
  }
});

test("explicit guest mode ignores unrelated cookies and forwards none", () => {
  const guest = { ...config, guestMode: "explicit" } as CompanionBrowserConfig;
  const req = request(["other=1; psfn_token=zzz"]);
  assert.equal(admitBrowserRequest(req, guest), COMPANION_ID);
  assert.deepEqual(resolveBrowserSessionCookie(req), { state: "absent" });
  assert.throws(() => admitBrowserRequest(request([`__Host-psfn_session=short; other=1`]), guest));
});
