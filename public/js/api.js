/* api.js — thin fetch wrapper. Adds owner token header if the user has set one. */
const API = {
  token: localStorage.getItem('ctrl_token') || '',
  setToken(t) { this.token = t || ''; localStorage.setItem('ctrl_token', this.token); },
};

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (API.token) opts.headers['X-Owner-Token'] = API.token;
  if (body !== null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api' + path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401) {
    const left = data?.attempts_remaining;
    const hint = left != null ? ` (${left} attempt${left === 1 ? '' : 's'} left before lockout)` : '';
    toast(`Invalid token${hint}`);
    API.setToken('');
    const t = prompt('Owner token required:');
    if (t) { API.setToken(t.trim()); return api(path, method, body); }
    throw new Error(data?.message || 'Unauthorized');
  }
  if (res.status === 429) {
    const err = new Error(data?.message || 'Too many attempts — try again later');
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
