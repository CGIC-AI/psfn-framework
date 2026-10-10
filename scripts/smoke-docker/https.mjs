import { request } from 'node:https';
import { Readable } from 'node:stream';

// Verify the disposable origin with its exact generated certificate. Never
// disable TLS verification process-wide, including for external model fetches.
export async function fixtureFetch({ gardenCa }, url, init = {}) {
  if (!url.startsWith('https:')) return fetch(url, init);
  if (!gardenCa) throw new Error('Disposable HTTPS certificate is required');
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers, signal: init.signal, ca: gardenCa }, res => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      resolve(new Response([204, 304].includes(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    req.once('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}
