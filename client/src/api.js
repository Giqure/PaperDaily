// Thin wrapper around the JSON auth API. Always sends cookies (credentials:
// 'include') so the session cookie rides along, and surfaces a normalized
// Error with the server's message + status for the UI to display.

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data = null;
  // 204 (logout) has no body; guard the parse.
  if (res.status !== 204) {
    data = await res.json().catch(() => null);
  }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const authApi = {
  signup: (email, password, name) =>
    request('/auth/signup', { method: 'POST', body: { email, password, name } }),
  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  checkEmail: (email) =>
    request('/auth/check-email', { method: 'POST', body: { email } }),
};

export const subscriptionsApi = {
  list: () => request('/subscriptions'),
  catalog: () => request('/subscriptions/catalog'),
  add: (scopeId) => request('/subscriptions', { method: 'POST', body: { scopeId } }),
  createScope: (payload) =>
    request('/subscriptions/scopes', { method: 'POST', body: payload }),
  remove: (id) => request(`/subscriptions/${id}`, { method: 'DELETE' }),
};

export const papersApi = {
  daily: () => request('/papers/daily'),
  saved: () => request('/papers/saved'),
  setState: (id, state) =>
    request(`/papers/${id}/state`, { method: 'PUT', body: { state } }),
};

export const settingsApi = {
  getPush: () => request('/settings/push'),
  updatePush: (payload) => request('/settings/push', { method: 'PUT', body: payload }),
};
