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
  // Password reset: request a mailed link, validate the token behind the link,
  // then submit a new password.
  forgotPassword: (email) =>
    request('/auth/forgot-password', { method: 'POST', body: { email } }),
  validateResetToken: (token) =>
    request(`/auth/reset-password/validate?token=${encodeURIComponent(token)}`),
  resetPassword: (token, password) =>
    request('/auth/reset-password', { method: 'POST', body: { token, password } }),
};

export const subscriptionsApi = {
  list: () => request('/subscriptions'),
  catalog: () => request('/subscriptions/catalog'),
  add: (scopeId) => request('/subscriptions', { method: 'POST', body: { scopeId } }),
  createScope: (payload) =>
    request('/subscriptions/scopes', { method: 'POST', body: payload }),
  // AI-fill arXiv queries + interests from a scope name.
  suggestScope: (name) =>
    request('/subscriptions/scopes/suggest', { method: 'POST', body: { name } }),
  remove: (id) => request(`/subscriptions/${id}`, { method: 'DELETE' }),
};

export const papersApi = {
  daily: () => request('/papers/daily'),
  all: () => request('/papers/all'),
  saved: () => request('/papers/saved'),
  setState: (id, state) =>
    request(`/papers/${id}/state`, { method: 'PUT', body: { state } }),
};

export const reportsApi = {
  // Trigger a background report for a date + scopes. Returns { jobId, status }.
  generate: (date, scopeIds) =>
    request('/reports/generate', { method: 'POST', body: { date, scopeIds } }),
  // Poll a job's status by id.
  job: (id) => request(`/reports/jobs/${id}`),
  // The curated papers for a (date, scopes) result, regardless of subscription.
  result: (date, scopeIds) =>
    request(
      `/reports/result?date=${encodeURIComponent(date)}&scopeIds=${scopeIds.join(',')}`
    ),
};

export const settingsApi = {
  getPush: () => request('/settings/push'),
  // Bark settings only — email push is gated behind a mailed confirmation link.
  updatePush: (payload) => request('/settings/push', { method: 'PUT', body: payload }),
  // Email push: request a confirmation link, or turn it off immediately.
  requestEmailPush: () =>
    request('/settings/push/email/request', { method: 'POST' }),
  disableEmailPush: () =>
    request('/settings/push/email/disable', { method: 'POST' }),
};
