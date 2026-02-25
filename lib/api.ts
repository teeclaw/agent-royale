async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function getDashboardState() {
  return fetchJson<DashboardState>('/api/dashboard/state');
}

export function getArenaAgents() {
  return fetchJson<ArenaAgent[]>('/api/arena/recent');
}

export function getAgentProfile(shortAddr: string) {
  return fetchJson<AgentProfile>(`/api/agent/${encodeURIComponent(shortAddr)}`);
}
