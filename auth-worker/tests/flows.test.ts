import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

// Execute the shipped SQL migrations/queries against SQLite; never contact D1/GitHub.
let database: DatabaseSync;
let env: Env;
const proof = 'v'.repeat(43);
const hash = async (value: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url');
const request = (path: string, body?: unknown) => new Request(`https://worker.example${path}`, {
  method: body ? 'POST' : 'GET', headers: { origin: 'https://site.example', 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

beforeEach(() => {
  database = new DatabaseSync(':memory:');
  for (const file of ['0001_sessions.sql', '0002_browser_binding.sql']) {
    database.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const adapter = {
    prepare(sql: string) {
      let values: Array<string | number | null> = [];
      return {
        bind(...bindings: typeof values) { values = bindings; return this; },
        async first() { return database.prepare(sql).get(...values) ?? null; },
        async run() { database.prepare(sql).run(...values); return { success: true }; },
      };
    },
    async batch(statements: Array<{ run: () => unknown }>) { return Promise.all(statements.map((item) => item.run())); },
  };
  env = {
    AUTH_DB: adapter as unknown as D1Database, SITE_ORIGIN: 'https://site.example', SITE_BASE_PATH: '/app',
    GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'fixture',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'fixture-access', expires_in: 28800 });
    if (url === 'https://api.github.com/user') return Response.json({ id: 1, login: 'fixture', avatar_url: 'https://example.invalid/avatar' });
    throw new Error(`Unexpected network request: ${url}`);
  }));
});
afterEach(() => { database.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function start() {
  const response = await worker.fetch(request(`/auth/login?browser_challenge=${await hash(proof)}&return_to=/app/repo/1/`), env);
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location')!).searchParams.get('state')!;
}
async function callback(state: string) {
  return worker.fetch(request(`/auth/callback?state=${state}&code=fixture-code`), env);
}
async function handoff() {
  const response = await callback(await start());
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location')!).searchParams.get('handoff')!;
}
const exchange = (token: string, verifier: string = proof) => worker.fetch(request('/auth/exchange', {
  handoff: token, browser_verifier: verifier,
}), env);

describe('bound one-time OAuth flow', () => {
  it('requires the initiating browser challenge', async () => {
    expect((await worker.fetch(request('/auth/login'), env)).status).toBe(400);
    expect(database.prepare('SELECT count(*) AS n FROM oauth_states').get()?.n).toBe(0);
  });
  it('rejects another browser without consuming the legitimate handoff', async () => {
    const token = await handoff();
    expect((await exchange(token, 'x'.repeat(43))).status).toBe(400);
    const valid = await exchange(token);
    expect(valid.status).toBe(200);
    expect(valid.headers.get('access-control-allow-origin')).toBe(env.SITE_ORIGIN);
    const body = await valid.json() as { session_token: string; return_to: string };
    expect(body.return_to).toBe('/app/repo/1/');
    const session = await worker.fetch(new Request('https://worker.example/api/session', {
      headers: { origin: env.SITE_ORIGIN, authorization: `Bearer ${body.session_token}` },
    }), env);
    expect(session.status).toBe(200);
    expect((await exchange(token)).status).toBe(400);
  });
  it('allows exactly one concurrent handoff exchange', async () => {
    const token = await handoff();
    const results = await Promise.all([exchange(token), exchange(token)]);
    expect(results.map((item) => item.status).sort()).toEqual([200, 400]);
  });
  it('allows exactly one concurrent OAuth state consumption', async () => {
    const state = await start();
    const results = await Promise.all([callback(state), callback(state)]);
    expect(results.map((item) => item.status).sort()).toEqual([302, 400]);
    expect(database.prepare('SELECT count(*) AS n FROM sessions').get()?.n).toBe(1);
  });
  it('rejects expiry and returns the actual remaining session lifetime', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const token = await handoff();
    vi.setSystemTime(now + 120_000);
    const body = await (await exchange(token)).json() as { expires_in: number };
    expect(body.expires_in).toBe(28800 - 120);
    const expired = await handoff();
    vi.setSystemTime(now + 600_000);
    expect((await exchange(expired)).status).toBe(400);
  });
  it('upgrades old D1 rows without allowing an unbound handoff', async () => {
    database.prepare('INSERT INTO handoffs (handoff_hash,encrypted_session_token,return_to,expires_at,created_at) VALUES (?,?,?,?,?)')
      .run(await hash('h'.repeat(43)), 'legacy', '/app/', Math.floor(Date.now() / 1000) + 300, 1);
    expect((await exchange('h'.repeat(43))).status).toBe(400);
  });
  it('contains asynchronous database and upstream failures in JSON/CORS responses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await handoff();
    vi.spyOn(env.AUTH_DB, 'prepare').mockImplementation(() => { throw new Error('fixture outage'); });
    const result = await exchange(token);
    expect(result.status).toBe(500);
    expect(result.headers.get('access-control-allow-origin')).toBe(env.SITE_ORIGIN);
    expect(await result.json()).toEqual({ error: 'internal_error' });
  });
  it('contains a rejected promise from login cleanup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(env.AUTH_DB, 'batch').mockRejectedValue(new Error('fixture outage'));
    const response = await worker.fetch(request(`/auth/login?browser_challenge=${await hash(proof)}`), env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });
});
