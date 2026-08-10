import type { ServerResponse } from 'node:http';
import { formatPossessiveCompanionName } from '../../core/identity/companion-naming.js';
import { resolveCompanionNameFromConfig } from '../../core/identity/companion-runtime.js';
import { sendText } from '../../channels/backplane/http/primitives.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { escapeHtml } from '../../shared/utils/escaping.js';

export function resolveGardenTitle(config: SubstrateConfig): string {
  const companionName = resolveCompanionNameFromConfig(config);
  return `${formatPossessiveCompanionName(companionName)} Garden`;
}

/*
 * Standalone Garden login in the shared Garden/Magic Patterns login language
 * (canvas/sunken/line/ink/gold tokens, serif display heading), kept fully
 * self-contained: no scripts, no remote assets.
 */
const LOGIN_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  min-width: 320px;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 48px 20px;
  background:
    radial-gradient(52% 38% at 82% 12%, rgba(194, 154, 43, 0.08), rgba(194, 154, 43, 0) 72%),
    #faf8f3;
  color: #26231e;
  font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.login {
  width: min(100%, 420px);
  border: 1px solid #e6e0d2;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(38, 35, 30, 0.04), 0 1px 12px rgba(38, 35, 30, 0.03);
  padding: 36px 32px 28px;
}
.brand { display: flex; align-items: center; gap: 12px; }
.mark {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid rgba(223, 195, 114, 0.7);
  border-radius: 12px;
  background: #fbf5e4;
  color: #9e7b1d;
  font-family: "Fraunces", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  font-size: 18px;
}
.wordmark {
  font-family: "Fraunces", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  font-size: 18px;
  line-height: 1.2;
}
.product { margin-top: 2px; color: #7c7364; font-size: 12px; }
.rule {
  height: 1px;
  margin: 24px 0;
  background: linear-gradient(to right, #dfc372, #e6e0d2, rgba(230, 224, 210, 0));
}
h1 {
  margin: 0;
  font-family: "Fraunces", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
  font-size: clamp(24px, 6vw, 30px);
  font-weight: 600;
  line-height: 1.2;
}
.intro { margin: 8px 0 24px; color: #7c7364; font-size: 14px; line-height: 1.6; }
label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
input {
  width: 100%;
  min-height: 44px;
  border: 1px solid #e6e0d2;
  border-radius: 10px;
  background: #ffffff;
  color: #26231e;
  padding: 8px 12px;
  font: inherit;
}
input:focus-visible, button:focus-visible {
  outline: 2px solid #9e7b1d;
  outline-offset: 2px;
}
button {
  display: flex;
  width: 100%;
  min-height: 48px;
  align-items: center;
  justify-content: center;
  margin-top: 20px;
  border: 1px solid #9e7b1d;
  border-radius: 10px;
  background: #9e7b1d;
  color: #ffffff;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 140ms ease;
}
button:hover { background: #c29a2b; border-color: #c29a2b; }
.error {
  margin: 0 0 16px;
  border: 1px solid #da8974;
  border-radius: 10px;
  background: #fbede9;
  padding: 10px 12px;
  color: #7e3526;
  font-size: 14px;
}
.privacy { margin: 16px 0 0; color: #7c7364; font-size: 12px; line-height: 1.5; text-align: center; }
@media (max-width: 420px) {
  body { padding: 24px 14px; }
  .login { padding: 28px 20px 24px; }
}
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
`;

function loginPage(gardenTitle: string, error?: string): string {
  const errorBlock = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';
  const escapedGardenTitle = escapeHtml(gardenTitle);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Login - ${escapedGardenTitle}</title>
    <style>${LOGIN_STYLE}</style>
  </head>
  <body>
    <main>
      <section class="login" aria-labelledby="login-title">
        <div class="brand">
          <span class="mark" aria-hidden="true">P</span>
          <div>
            <div class="wordmark">PSFN</div>
            <div class="product">${escapedGardenTitle}</div>
          </div>
        </div>
        <div class="rule" aria-hidden="true"></div>
        <h1 id="login-title">Welcome back.</h1>
        <p class="intro">Enter your admin token to continue.</p>
        ${errorBlock}
        <form method="POST" action="/login">
          <label for="token">Admin token</label>
          <input id="token" name="token" type="password" autocomplete="current-password">
          <button type="submit">Sign in</button>
        </form>
        <p class="privacy">Access is limited to authorized operators. Failed requests stay on this page without exposing system details.</p>
      </section>
    </main>
  </body>
</html>`;
}

export function sendGardenLoginPage(
  res: ServerResponse,
  config: SubstrateConfig,
  error?: string,
  status: number = 200,
): void {
  sendText(
    res,
    status,
    loginPage(resolveGardenTitle(config), error),
    {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
    },
  );
}
