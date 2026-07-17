export const FLEET_PORTAL_CLIENT_SOURCE = `(() => {
  'use strict';
  const content = document.getElementById('fleet-portal-content');
  const summary = document.getElementById('fleet-portal-summary');
  const logout = document.getElementById('fleet-logout');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const availability = new Set(['online', 'degraded', 'offline', 'unknown']);
  const safety = Object.freeze({ requestTimeoutMs: 10_000 });
  if (!content || !summary || !(logout instanceof HTMLButtonElement)) return;

  function setSummary(message, busy) {
    summary.textContent = message;
    content.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function text(parent, tag, value) {
    const child = document.createElement(tag);
    child.textContent = value;
    parent.append(child);
    return child;
  }

  function canonicalGardenPath(companion) {
    if (!uuid.test(companion.companionId)) return null;
    const expected = '/companions/' + companion.companionId + '/garden';
    return companion.gardenPath === expected ? expected : null;
  }

  function renderCompanions(companions) {
    content.replaceChildren();
    if (companions.length === 0) {
      text(content, 'p', 'No companions are available for this account.');
      setSummary('No companion access is currently available.', false);
      return;
    }
    const list = document.createElement('ul');
    let unavailable = false;
    let available = false;
    for (const companion of companions) {
      if (!companion || typeof companion !== 'object' || !uuid.test(companion.companionId)
          || !availability.has(companion.availability) || typeof companion.headless !== 'boolean') {
        throw new Error('invalid projection');
      }
      const item = document.createElement('li');
      const heading = text(item, 'h2', companion.companionId);
      heading.className = 'companion-id';
      const label = companion.availability[0].toUpperCase() + companion.availability.slice(1);
      text(item, 'p', 'Status: ' + label);
      const gardenPath = canonicalGardenPath(companion);
      if (companion.headless) {
        text(item, 'p', 'Headless companion — Garden is not configured.');
        unavailable = true;
      } else if (!gardenPath) {
        text(item, 'p', 'Garden access unavailable.');
        unavailable = true;
      } else if (companion.availability === 'offline' || companion.availability === 'unknown') {
        const disabled = text(item, 'span', companion.availability === 'offline'
          ? 'Garden is offline' : 'Garden is not ready');
        disabled.setAttribute('aria-disabled', 'true');
        unavailable = true;
      } else {
        const link = text(item, 'a', 'Open Garden');
        link.setAttribute('href', gardenPath);
        available = true;
        if (companion.availability === 'degraded') unavailable = true;
      }
      list.append(item);
    }
    content.append(list);
    setSummary(unavailable && available
      ? 'Some companions are unavailable.'
      : unavailable ? 'Companion access is currently unavailable.' : 'All companions are online.', false);
  }

  async function loadProjection() {
    setSummary('Loading companion access…', true);
    try {
      const response = await fetch('/v1/fleet/portal', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(safety.requestTimeoutMs),
      });
      if (response.status === 401 || response.status === 403) {
        content.replaceChildren();
        text(content, 'p', 'Access unavailable. Sign in again or ask an administrator for access.');
        setSummary('Fleet portal access is unavailable.', false);
        return;
      }
      if (!response.ok) throw new Error('projection unavailable');
      const payload = await response.json();
      if (!payload || payload.schemaVersion !== 1 || !payload.session
          || payload.session.state !== 'authenticated' || !Array.isArray(payload.companions)
          || payload.companions.length > 256) throw new Error('invalid projection');
      renderCompanions(payload.companions);
    } catch {
      content.replaceChildren();
      text(content, 'p', 'Fleet status is temporarily unavailable. You can still sign out.');
      setSummary('Fleet portal status is unavailable.', false);
    }
  }

  async function prepareLogout() {
    try {
      const response = await fetch('/v1/fleet-auth/session/csrf', {
        cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(safety.requestTimeoutMs),
      });
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload || typeof payload.csrfToken !== 'string'
          || !/^[A-Za-z0-9_-]{43}$/.test(payload.csrfToken)) return;
      logout.disabled = false;
      logout.onclick = () => {
        const performLogout = async () => {
          try {
            const result = await fetch('/v1/fleet-auth/logout', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'X-PSFN-CSRF': payload.csrfToken },
              signal: AbortSignal.timeout(safety.requestTimeoutMs),
            });
            if (result.ok) {
              window.location.assign('/fleet/login');
              return;
            }
          } catch {
            // The fixed status below is deliberately independent of error details.
          }
          logout.disabled = false;
          setSummary('Sign out failed. Please try again.', false);
        };
        logout.disabled = true;
        void performLogout();
      };
    } catch {
      logout.disabled = true;
    }
  }

  void loadProjection();
  void prepareLogout();
})();`;
