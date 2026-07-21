export interface Env {
  AUTH_DB: D1Database;
  SITE_ORIGIN: string;
  SITE_BASE_PATH: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
}

interface SessionRow {
  id_hash: string;
  github_user_id: number;
  login: string;
  avatar_url: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  access_expires_at: number;
  refresh_expires_at: number | null;
  session_expires_at: number;
}

const API_VERSION = '2022-11-28';
const SESSION_SECONDS = 8 * 60 * 60;
const OAUTH_STATE_SECONDS = 10 * 60;
const HANDOFF_SECONDS = 5 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});

const base64url = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

const fromBase64url = (value: string) => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const randomToken = (bytes = 32) => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
};

const digest = async (value: string) => base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));

const encryptionKey = async (env: Env) => {
  const raw = fromBase64url(env.TOKEN_ENCRYPTION_KEY);
  if (raw.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

const encrypt = async (env: Env, value: string) => {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), encoder.encode(value)));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  return base64url(packed);
};

const decrypt = async (env: Env, value: string) => {
  const packed = fromBase64url(value);
  if (packed.byteLength < 29) throw new Error('Invalid encrypted token');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.slice(0, 12) },
    await encryptionKey(env),
    packed.slice(12),
  );
  return decoder.decode(plaintext);
};

export const normalizeBasePath = (value: string) => {
  const normalized = `/${value.trim().replace(/^\/+|\/+$/gu, '')}`;
  return normalized === '/' ? '' : normalized;
};

export const safeReturnTo = (value: string | null, basePath: string) => {
  const base = normalizeBasePath(basePath);
  const fallback = `${base}/` || '/';
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback;
  try {
    const parsed = new URL(value, 'https://site.invalid');
    if (parsed.origin !== 'https://site.invalid') return fallback;
    if (base && parsed.pathname !== base && !parsed.pathname.startsWith(`${base}/`)) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
};

export const parseRepositoryPath = (pathname: string) => {
  const match = pathname.match(/^\/api\/star\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u);
  return match ? { owner: match[1], repository: match[2] } : null;
};

const cors = (request: Request, env: Env) => {
  const origin = request.headers.get('origin');
  if (origin !== env.SITE_ORIGIN) return null;
  return {
    'access-control-allow-origin': env.SITE_ORIGIN,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
};

const callbackUrl = (request: Request) => `${new URL(request.url).origin}/auth/callback`;

const githubToken = async (env: Env, parameters: Record<string, string>) => {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...parameters }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== 'string') {
    throw new Error(`GitHub token exchange failed: ${String(payload.error_description ?? payload.error ?? response.status)}`);
  }
  return payload;
};

const github = async (path: string, accessToken: string, init: RequestInit = {}) => fetch(`https://api.github.com${path}`, {
  ...init,
  headers: {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${accessToken}`,
    'x-github-api-version': API_VERSION,
    'user-agent': 'open-source-star-rank-auth',
    ...init.headers,
  },
});

const purgeExpired = async (env: Env, now: number) => {
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now),
    env.AUTH_DB.prepare('DELETE FROM handoffs WHERE expires_at <= ?').bind(now),
    env.AUTH_DB.prepare('DELETE FROM sessions WHERE session_expires_at <= ?').bind(now),
  ]);
};

const authorize = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const state = randomToken();
  const verifier = randomToken(48);
  const challenge = await digest(verifier);
  const now = Math.floor(Date.now() / 1000);
  const returnTo = safeReturnTo(url.searchParams.get('return_to'), env.SITE_BASE_PATH);
  await purgeExpired(env, now);
  await env.AUTH_DB.prepare(
    'INSERT INTO oauth_states (state_hash, encrypted_verifier, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(await digest(state), await encrypt(env, verifier), returnTo, now + OAUTH_STATE_SECONDS, now).run();
  const target = new URL('https://github.com/login/oauth/authorize');
  target.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  target.searchParams.set('redirect_uri', callbackUrl(request));
  target.searchParams.set('state', state);
  target.searchParams.set('code_challenge', challenge);
  target.searchParams.set('code_challenge_method', 'S256');
  return Response.redirect(target.toString(), 302);
};

const oauthCallback = async (request: Request, env: Env) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return json({ error: 'missing_oauth_parameters' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const stateHash = await digest(state);
  const saved = await env.AUTH_DB.prepare(
    'SELECT encrypted_verifier, return_to, expires_at FROM oauth_states WHERE state_hash = ?',
  ).bind(stateHash).first<{ encrypted_verifier: string; return_to: string; expires_at: number }>();
  await env.AUTH_DB.prepare('DELETE FROM oauth_states WHERE state_hash = ?').bind(stateHash).run();
  if (!saved || saved.expires_at <= now) return json({ error: 'invalid_or_expired_oauth_state' }, 400);
  const token = await githubToken(env, {
    code,
    redirect_uri: callbackUrl(request),
    code_verifier: await decrypt(env, saved.encrypted_verifier),
  });
  const userResponse = await github('/user', String(token.access_token));
  if (!userResponse.ok) return json({ error: 'github_user_lookup_failed' }, 502);
  const user = await userResponse.json() as { id?: number; login?: string; avatar_url?: string };
  if (!Number.isInteger(user.id) || !user.login || !user.avatar_url) return json({ error: 'invalid_github_user' }, 502);

  const sessionToken = randomToken();
  const sessionHash = await digest(sessionToken);
  const accessExpiresAt = now + Math.min(Number(token.expires_in ?? SESSION_SECONDS), SESSION_SECONDS);
  const refreshExpiresAt = typeof token.refresh_token_expires_in === 'number' ? now + token.refresh_token_expires_in : null;
  await env.AUTH_DB.prepare(
    `INSERT INTO sessions (
      id_hash, github_user_id, login, avatar_url, encrypted_access_token, encrypted_refresh_token,
      access_expires_at, refresh_expires_at, session_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    sessionHash, user.id, user.login, user.avatar_url,
    await encrypt(env, String(token.access_token)),
    typeof token.refresh_token === 'string' ? await encrypt(env, token.refresh_token) : null,
    accessExpiresAt, refreshExpiresAt, now + SESSION_SECONDS, now, now,
  ).run();
  const handoff = randomToken();
  await env.AUTH_DB.prepare(
    'INSERT INTO handoffs (handoff_hash, encrypted_session_token, return_to, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(await digest(handoff), await encrypt(env, sessionToken), saved.return_to, now + HANDOFF_SECONDS, now).run();
  const callback = new URL(`${env.SITE_ORIGIN}${normalizeBasePath(env.SITE_BASE_PATH)}/auth/callback/`);
  callback.searchParams.set('handoff', handoff);
  return Response.redirect(callback.toString(), 302);
};

const exchangeHandoff = async (request: Request, env: Env, headers: HeadersInit) => {
  const body = await request.json().catch(() => null) as { handoff?: unknown } | null;
  if (typeof body?.handoff !== 'string') return json({ error: 'missing_handoff' }, 400, headers);
  const handoffHash = await digest(body.handoff);
  const row = await env.AUTH_DB.prepare(
    'SELECT encrypted_session_token, return_to, expires_at FROM handoffs WHERE handoff_hash = ?',
  ).bind(handoffHash).first<{ encrypted_session_token: string; return_to: string; expires_at: number }>();
  await env.AUTH_DB.prepare('DELETE FROM handoffs WHERE handoff_hash = ?').bind(handoffHash).run();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.expires_at <= now) return json({ error: 'invalid_or_expired_handoff' }, 400, headers);
  return json({
    session_token: await decrypt(env, row.encrypted_session_token),
    expires_in: SESSION_SECONDS,
    return_to: row.return_to,
  }, 200, headers);
};

const bearer = (request: Request) => {
  const value = request.headers.get('authorization') ?? '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : null;
};

const authenticated = async (request: Request, env: Env) => {
  const token = bearer(request);
  if (!token) return null;
  const row = await env.AUTH_DB.prepare('SELECT * FROM sessions WHERE id_hash = ?').bind(await digest(token)).first<SessionRow>();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.session_expires_at <= now) return null;
  if (row.access_expires_at > now + 60) return { row, accessToken: await decrypt(env, row.encrypted_access_token) };
  if (!row.encrypted_refresh_token || (row.refresh_expires_at ?? 0) <= now) return null;
  const refreshed = await githubToken(env, {
    grant_type: 'refresh_token',
    refresh_token: await decrypt(env, row.encrypted_refresh_token),
  });
  const accessToken = String(refreshed.access_token);
  const accessExpiresAt = now + Math.min(Number(refreshed.expires_in ?? SESSION_SECONDS), SESSION_SECONDS);
  const refreshToken = typeof refreshed.refresh_token === 'string'
    ? await encrypt(env, refreshed.refresh_token)
    : row.encrypted_refresh_token;
  const refreshExpiresAt = typeof refreshed.refresh_token_expires_in === 'number'
    ? now + refreshed.refresh_token_expires_in
    : row.refresh_expires_at;
  await env.AUTH_DB.prepare(
    'UPDATE sessions SET encrypted_access_token = ?, encrypted_refresh_token = ?, access_expires_at = ?, refresh_expires_at = ?, updated_at = ? WHERE id_hash = ?',
  ).bind(await encrypt(env, accessToken), refreshToken, accessExpiresAt, refreshExpiresAt, now, row.id_hash).run();
  return { row: { ...row, access_expires_at: accessExpiresAt, refresh_expires_at: refreshExpiresAt }, accessToken };
};

const githubFailure = async (response: Response, headers: HeadersInit) => {
  const requestId = response.headers.get('x-github-request-id');
  if (response.status === 401) return json({ error: 'github_session_expired', request_id: requestId }, 401, headers);
  if (response.status === 403) return json({ error: 'github_permission_or_rate_limit', request_id: requestId }, 403, headers);
  if (response.status === 404) return json({ error: 'repository_not_found', request_id: requestId }, 404, headers);
  return json({ error: 'github_api_error', status: response.status, request_id: requestId }, 502, headers);
};

const sessionResponse = async (auth: NonNullable<Awaited<ReturnType<typeof authenticated>>>, headers: HeadersInit) => json({
  authenticated: true,
  user: { id: auth.row.github_user_id, login: auth.row.login, avatar_url: auth.row.avatar_url },
  expires_at: new Date(auth.row.session_expires_at * 1000).toISOString(),
}, 200, headers);

const repositoryStar = async (
  request: Request,
  env: Env,
  auth: NonNullable<Awaited<ReturnType<typeof authenticated>>>,
  repository: { owner: string; repository: string },
  headers: HeadersInit,
) => {
  const path = `/user/starred/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`;
  const response = await github(path, auth.accessToken, { method: request.method });
  if (request.method === 'GET' && response.status === 404) return json({ starred: false }, 200, headers);
  if (request.method === 'GET' && response.status === 204) return json({ starred: true }, 200, headers);
  if ((request.method === 'PUT' || request.method === 'DELETE') && response.status === 204) {
    return json({ starred: request.method === 'PUT' }, 200, headers);
  }
  return githubFailure(response, headers);
};

const syncStars = async (
  request: Request,
  auth: NonNullable<Awaited<ReturnType<typeof authenticated>>>,
  headers: HeadersInit,
) => {
  const body = await request.json().catch(() => null) as { repositories?: unknown } | null;
  if (!Array.isArray(body?.repositories) || body.repositories.length < 1 || body.repositories.length > 25) {
    return json({ error: 'repositories_must_contain_1_to_25_items' }, 400, headers);
  }
  const repositories = [...new Set(body.repositories.filter((item): item is string =>
    typeof item === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item),
  ))];
  if (repositories.length !== body.repositories.length) return json({ error: 'invalid_repository_name' }, 400, headers);
  const results = [] as Array<{ full_name: string; starred: boolean; status?: number }>;
  for (const fullName of repositories) {
    const response = await github(`/user/starred/${fullName.split('/').map(encodeURIComponent).join('/')}`, auth.accessToken, { method: 'PUT' });
    results.push({ full_name: fullName, starred: response.status === 204, status: response.status === 204 ? undefined : response.status });
  }
  return json({ results, succeeded: results.filter((item) => item.starred).length }, 200, headers);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/auth/login' && request.method === 'GET') return authorize(request, env);
      if (url.pathname === '/auth/callback' && request.method === 'GET') return oauthCallback(request, env);

      const corsHeaders = cors(request, env);
      if (!corsHeaders) return json({ error: 'origin_not_allowed' }, 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
      if (url.pathname === '/auth/exchange' && request.method === 'POST') return exchangeHandoff(request, env, corsHeaders);

      const auth = await authenticated(request, env);
      if (!auth) return json({ error: 'authentication_required' }, 401, corsHeaders);
      if (url.pathname === '/api/session' && request.method === 'GET') return sessionResponse(auth, corsHeaders);
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        await env.AUTH_DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(auth.row.id_hash).run();
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const repository = parseRepositoryPath(url.pathname);
      if (repository && ['GET', 'PUT', 'DELETE'].includes(request.method)) {
        return repositoryStar(request, env, auth, repository, corsHeaders);
      }
      if (url.pathname === '/api/stars/sync' && request.method === 'POST') return syncStars(request, auth, corsHeaders);
      return json({ error: 'not_found' }, 404, corsHeaders);
    } catch (error) {
      console.error(error);
      return json({ error: 'internal_error' }, 500, cors(request, env) ?? {});
    }
  },
} satisfies ExportedHandler<Env>;
