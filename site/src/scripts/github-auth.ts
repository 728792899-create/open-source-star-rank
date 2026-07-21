type GitHubUser = { id: number; login: string; avatar_url: string };
type StoredSession = { token: string; expiresAt: number };
type AuthState = { configured: boolean; authenticated: boolean; user: GitHubUser | null; expiresAt: number | null };
type FavoriteChoice = 'github' | 'local' | 'cancel';

const storageKey = 'star-rank-github-session-v1';
const apiBase = document.documentElement.dataset.authApiUrl?.replace(/\/$/u, '') ?? '';
let state: AuthState = { configured: Boolean(apiBase), authenticated: false, user: null, expiresAt: null };

const readSession = (): StoredSession | null => {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(storageKey) || 'null') as Partial<StoredSession> | null;
    if (!value || typeof value.token !== 'string' || typeof value.expiresAt !== 'number' || value.expiresAt <= Date.now()) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    return value as StoredSession;
  } catch {
    return null;
  }
};

const saveSession = (token: string, expiresIn: number) => {
  const expiresAt = Date.now() + Math.min(Math.max(1, expiresIn), 8 * 60 * 60) * 1000;
  window.sessionStorage.setItem(storageKey, JSON.stringify({ token, expiresAt } satisfies StoredSession));
};

const clearSession = () => {
  try { window.sessionStorage.removeItem(storageKey); } catch {}
  state = { ...state, authenticated: false, user: null, expiresAt: null };
};

const request = async (path: string, init: RequestInit = {}, requiresSession = true) => {
  if (!apiBase) throw new Error('GitHub 登录同步尚未配置');
  const session = readSession();
  if (requiresSession && !session) throw new Error('authentication_required');
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401 && requiresSession) {
    clearSession();
    render();
    window.dispatchEvent(new CustomEvent('starrankauthchange', { detail: state }));
  }
  return response;
};

const errorMessage = async (response: Response) => {
  const payload = await response.json().catch(() => ({})) as { error?: string };
  const messages: Record<string, string> = {
    authentication_required: '登录已过期，请重新登录。',
    github_session_expired: 'GitHub 授权已过期，请重新登录。',
    github_permission_or_rate_limit: 'GitHub 权限不足或请求额度已用尽。请确认应用拥有 Starring 读写权限。',
    repository_not_found: '仓库不存在或当前账号无权访问。',
    invalid_or_expired_handoff: '登录回传已过期，请重新发起登录。',
  };
  return messages[payload.error ?? ''] ?? `请求失败（HTTP ${response.status}）`;
};

const currentReturnTo = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

const login = (returnTo = currentReturnTo()) => {
  if (!apiBase) throw new Error('GitHub 登录同步尚未配置');
  window.location.assign(`${apiBase}/auth/login?return_to=${encodeURIComponent(returnTo)}`);
};

const loadSession = async () => {
  if (!apiBase || !readSession()) {
    clearSession();
    return state;
  }
  const response = await request('/api/session');
  if (!response.ok) {
    clearSession();
    return state;
  }
  const payload = await response.json() as { user: GitHubUser; expires_at: string };
  state = { configured: true, authenticated: true, user: payload.user, expiresAt: new Date(payload.expires_at).getTime() };
  return state;
};

const exchangeHandoff = async (handoff: string) => {
  const response = await request('/auth/exchange', {
    method: 'POST', body: JSON.stringify({ handoff }),
  }, false);
  if (!response.ok) throw new Error(await errorMessage(response));
  const payload = await response.json() as { session_token: string; expires_in: number; return_to: string };
  saveSession(payload.session_token, payload.expires_in);
  await loadSession();
  render();
  window.dispatchEvent(new CustomEvent('starrankauthchange', { detail: state }));
  return payload.return_to;
};

const logout = async () => {
  if (readSession()) await request('/auth/logout', { method: 'POST' }).catch(() => null);
  clearSession();
  render();
  window.dispatchEvent(new CustomEvent('starrankauthchange', { detail: state }));
};

const splitName = (fullName: string) => {
  const [owner, repository, ...rest] = fullName.split('/');
  if (!owner || !repository || rest.length) throw new Error('无效的 GitHub 仓库名');
  return `${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
};

const starStatus = async (fullName: string) => {
  const response = await request(`/api/star/${splitName(fullName)}`);
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json() as { starred: boolean }).starred;
};

const setStar = async (fullName: string, starred: boolean) => {
  const response = await request(`/api/star/${splitName(fullName)}`, { method: starred ? 'PUT' : 'DELETE' });
  if (!response.ok) throw new Error(await errorMessage(response));
  return (await response.json() as { starred: boolean }).starred;
};

const syncFavorites = async (fullNames: string[], onProgress?: (completed: number, total: number) => void) => {
  const unique = [...new Set(fullNames.filter((item) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item)))];
  let completed = 0;
  const failed: string[] = [];
  for (let offset = 0; offset < unique.length; offset += 25) {
    const chunk = unique.slice(offset, offset + 25);
    const response = await request('/api/stars/sync', { method: 'POST', body: JSON.stringify({ repositories: chunk }) });
    if (!response.ok) throw new Error(await errorMessage(response));
    const payload = await response.json() as { results: Array<{ full_name: string; starred: boolean }> };
    failed.push(...payload.results.filter((item) => !item.starred).map((item) => item.full_name));
    completed += chunk.length;
    onProgress?.(completed, unique.length);
  }
  return { total: unique.length, succeeded: unique.length - failed.length, failed };
};

const chooseFavoriteMode = () => new Promise<FavoriteChoice>((resolve) => {
  if (state.authenticated) return resolve('github');
  const dialog = document.querySelector('[data-auth-choice]');
  if (!(dialog instanceof HTMLDialogElement)) return resolve('local');
  const github = dialog.querySelector('[data-auth-choice-github]');
  const local = dialog.querySelector('[data-auth-choice-local]');
  const cancel = dialog.querySelector('[data-auth-choice-cancel]');
  const note = dialog.querySelector('[data-auth-choice-note]');
  if (github instanceof HTMLButtonElement) github.disabled = !apiBase;
  if (note) note.textContent = apiBase ? '登录是可选的；站点不会获得你的密码。' : 'GitHub 登录同步尚未启用，本机收藏仍可使用。';
  let settled = false;
  const finish = (choice: FavoriteChoice) => {
    if (settled) return;
    settled = true;
    dialog.close();
    resolve(choice);
  };
  if (github instanceof HTMLButtonElement) github.onclick = () => finish('github');
  if (local instanceof HTMLButtonElement) local.onclick = () => finish('local');
  if (cancel instanceof HTMLButtonElement) cancel.onclick = () => finish('cancel');
  dialog.oncancel = () => finish('cancel');
  dialog.showModal();
});

const render = () => {
  const loginButton = document.querySelector('[data-github-login]');
  const userPanel = document.querySelector('[data-github-user]');
  if (loginButton instanceof HTMLButtonElement) {
    loginButton.hidden = state.authenticated;
    loginButton.disabled = !state.configured;
    loginButton.textContent = state.configured ? 'GitHub 登录' : '登录待配置';
  }
  if (userPanel instanceof HTMLElement) userPanel.hidden = !state.authenticated;
  const name = document.querySelector('[data-github-login-name]');
  if (name) name.textContent = state.user ? `@${state.user.login}` : '';
  const avatar = document.querySelector('[data-github-avatar]');
  if (avatar instanceof HTMLImageElement && state.user) {
    avatar.src = state.user.avatar_url;
    avatar.alt = `${state.user.login} 的 GitHub 头像`;
  }
  const sync = document.querySelector('[data-sync-favorites]');
  const library = (window as Window & { starRankLibrary?: { read: () => { favorites: Array<{ fullName?: string }> } } }).starRankLibrary?.read();
  if (sync instanceof HTMLButtonElement) sync.hidden = !state.authenticated || !(library?.favorites.length);
};

const initialize = (async () => {
  await loadSession().catch(() => clearSession());
  render();
  window.dispatchEvent(new CustomEvent('starrankauthready', { detail: state }));
  window.dispatchEvent(new CustomEvent('starrankauthchange', { detail: state }));
  return state;
})();

const api = {
  get state() { return state; }, initialize, login, logout, exchangeHandoff, starStatus, setStar, syncFavorites, chooseFavoriteMode,
};
(window as Window & { starRankAuth?: typeof api }).starRankAuth = api;

document.querySelector('[data-github-login]')?.addEventListener('click', () => {
  try { login(); } catch (error) { window.alert(error instanceof Error ? error.message : '登录暂不可用'); }
});
document.querySelector('[data-github-logout]')?.addEventListener('click', () => logout());
window.addEventListener('starranklibrarychange', render);
document.querySelector('[data-sync-favorites]')?.addEventListener('click', async () => {
  const library = (window as Window & { starRankLibrary?: { read: () => { favorites: Array<{ fullName?: string }> } } }).starRankLibrary?.read();
  const names = library?.favorites.map((item) => item.fullName).filter((item): item is string => Boolean(item)) ?? [];
  if (!names.length || !window.confirm(`将本机收藏的 ${names.length} 个项目同步为你的 GitHub Star？此操作不会自动取消其他 Star。`)) return;
  const status = document.querySelector('[data-sync-status]');
  try {
    const result = await syncFavorites(names, (completed, total) => { if (status) status.textContent = `正在同步 ${completed} / ${total}…`; });
    if (status) status.textContent = result.failed.length
      ? `已同步 ${result.succeeded} 个，${result.failed.length} 个失败。`
      : `已将 ${result.succeeded} 个收藏同步到 GitHub。`;
  } catch (error) {
    if (status) status.textContent = error instanceof Error ? error.message : '同步失败，请稍后重试。';
  }
});
