import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const storageKey = 'star-rank-github-session-v1';
const proofKey = 'star-rank-oauth-proof-v1';
let sequence = 0;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const response = () => Response.json({ user: { id: 1, login: 'fixture', avatar_url: '' }, expires_at: new Date(Date.now() + 3600_000).toISOString() });

async function setup(t, { token = 'old', fetcher = async () => response(), initialize = true } = {}) {
  const values = new Map();
  const timers = new Map();
  t.mock.method(globalThis, 'setTimeout', (callback) => { const id = {}; timers.set(id, callback); return id; });
  t.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));
  t.mock.method(globalThis, 'fetch', fetcher);
  class ElementMock {}
  for (const name of ['HTMLElement', 'HTMLButtonElement', 'HTMLImageElement', 'HTMLDialogElement']) globalThis[name] = ElementMock;
  const authStatus = new ElementMock();
  globalThis.document = { documentElement: { dataset: { authApiUrl: 'https://worker.example' } }, querySelector: (selector) => selector === '[data-auth-status]' ? authStatus : null };
  const events = new Map();
  const locations = [];
  globalThis.window = {
    sessionStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    dispatchEvent() {}, addEventListener(name, callback) { events.set(name, callback); },
    location: { pathname: '/app/', search: '', hash: '', assign: (value) => locations.push(value) },
  };
  if (token) values.set(storageKey, JSON.stringify({ token, expiresAt: Date.now() + 3600_000 }));
  values.set(proofKey, JSON.stringify({ verifier: 'v'.repeat(43), expiresAt: Date.now() + 600_000 }));
  await import(`../src/scripts/github-auth.ts?test=${++sequence}`);
  const auth = window.starRankAuth;
  if (initialize) await auth.initialize;
  return { auth, values, timers, events, locations, authStatus };
}

test('login stores the browser verifier locally and sends only its challenge', async (t) => {
  const { auth, values, locations } = await setup(t, { token: null });
  await auth.login();
  const { verifier } = JSON.parse(values.get(proofKey));
  const url = new URL(locations[0]);
  assert.equal(url.searchParams.get('browser_challenge'), Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url'));
  assert.equal(locations[0].includes(verifier), false);
});

test('handoff waits for old initialization and survives focus without an existing session', async (t) => {
  const old = deferred();
  const exchanged = deferred();
  let exchangeCalls = 0;
  const { auth, values } = await setup(t, { initialize: false, fetcher: async (url, init) => {
    if (url.endsWith('/auth/exchange')) { exchangeCalls++; return exchanged.promise; }
    if (init.headers.authorization === 'Bearer old') return old.promise;
    return response();
  } });
  const pending = auth.exchangeHandoff('h'.repeat(43));
  await Promise.resolve();
  assert.equal(exchangeCalls, 0);
  old.resolve(new Response('{}', { status: 401 }));
  await auth.initialize;
  // A focus or online listener calls this same method during the exchange.
  await auth.refreshSession();
  exchanged.resolve(Response.json({ session_token: 'new', expires_in: 28800, return_to: '/app/' }));
  await pending;
  assert.equal(JSON.parse(values.get(storageKey)).token, 'new');
  assert.equal(auth.state.authenticated, true);
});

test('late 401 from an old request cannot delete a newly logged-in session', async (t) => {
  const old = deferred();
  const { auth, values } = await setup(t, { fetcher: async (url) => {
    if (url.includes('/api/star/')) return old.promise;
    if (url.endsWith('/auth/exchange')) return Response.json({ session_token: 'new', expires_in: 3600, return_to: '/app/' });
    return response();
  } });
  const pending = auth.starStatus('owner/repo');
  await auth.exchangeHandoff('h'.repeat(43));
  old.resolve(new Response('{}', { status: 401 }));
  await assert.rejects(pending);
  assert.equal(JSON.parse(values.get(storageKey)).token, 'new');
  assert.equal(auth.state.authenticated, true);
});

test('late successful session refresh cannot restore UI after logout', async (t) => {
  const old = deferred();
  let first = true;
  const { auth, values } = await setup(t, { fetcher: async (url) => {
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    if (first) { first = false; return response(); }
    return old.promise;
  } });
  const pending = auth.refreshSession();
  await auth.logout();
  old.resolve(response());
  await pending;
  assert.equal(auth.state.authenticated, false);
  assert.equal(values.has(storageKey), false);
});

for (const failure of ['503', 'offline']) test(`${failure} preserves valid session for recovery`, async (t) => {
  const { auth, values } = await setup(t, { fetcher: async () => {
    if (failure === 'offline') throw new TypeError('offline');
    return new Response('{}', { status: 503 });
  } });
  assert.equal(JSON.parse(values.get(storageKey)).token, 'old');
  assert.ok(auth.state.error);
  t.mock.method(globalThis, 'fetch', async () => response());
  await auth.refreshSession();
  assert.equal(auth.state.authenticated, true);
});

test('natural expiry clears both storage and authenticated UI without an action', async (t) => {
  const { auth, values, timers } = await setup(t);
  assert.equal(auth.state.authenticated, true);
  const expiry = JSON.parse(values.get(storageKey)).expiresAt;
  t.mock.method(Date, 'now', () => expiry + 1);
  for (const callback of [...timers.values()]) callback();
  assert.equal(values.has(storageKey), false);
  assert.equal(auth.state.authenticated, false);
});

for (const failure of ['503', 'offline']) test(`logout reports unconfirmed revocation on ${failure}`, async (t) => {
  const { auth, values, authStatus } = await setup(t, { fetcher: async (url) => {
    if (!url.endsWith('/auth/logout')) return response();
    if (failure === 'offline') throw new TypeError('offline');
    return new Response('{}', { status: 503 });
  } });
  await auth.logout();
  assert.equal(values.has(storageKey), false);
  assert.equal(auth.state.authenticated, false);
  assert.match(auth.state.error, /服务端撤销未确认/u);
  assert.equal(authStatus.hidden, false);
  assert.match(authStatus.textContent, /服务端撤销未确认/u);
});

test('a late logout failure cannot change a newer login', async (t) => {
  const logout = deferred();
  const { auth, values } = await setup(t, { fetcher: async (url) => {
    if (url.endsWith('/auth/logout')) return logout.promise;
    if (url.endsWith('/auth/exchange')) return Response.json({ session_token: 'new', expires_in: 3600, return_to: '/app/' });
    return response();
  } });
  const pending = auth.logout();
  values.set(proofKey, JSON.stringify({ verifier: 'v'.repeat(43), expiresAt: Date.now() + 600_000 }));
  await auth.exchangeHandoff('h'.repeat(43));
  logout.resolve(new Response('{}', { status: 503 }));
  await pending;
  assert.equal(auth.state.authenticated, true);
  assert.equal(auth.state.error, undefined);
});
