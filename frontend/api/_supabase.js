const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function hasConfig() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

async function rest(path, options = {}) {
  if (!hasConfig()) throw new Error('Supabase env missing');

  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const msg = (json && (json.message || json.error || JSON.stringify(json))) || text || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  return json;
}

module.exports = { rest, hasConfig };
