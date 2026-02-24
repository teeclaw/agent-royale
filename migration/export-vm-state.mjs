#!/usr/bin/env node
/**
 * Export current VM API state into a portable JSON snapshot.
 *
 * Usage:
 *   node migration/export-vm-state.mjs
 *   API_BASE=https://api.agentroyale.xyz node migration/export-vm-state.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE = process.env.API_BASE || 'https://api.agentroyale.xyz';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve('migration/snapshots');
  await fs.mkdir(outDir, { recursive: true });

  const [health, dashboard, arenaAgents, arenaRecent, gameStats] = await Promise.all([
    getJson(`${API_BASE}/health`),
    getJson(`${API_BASE}/dashboard/state`),
    getJson(`${API_BASE}/arena/agents`),
    getJson(`${API_BASE}/arena/recent`),
    getJson(`${API_BASE}/casino/stats`),
  ]);

  const snapshot = {
    meta: {
      exportedAt: now.toISOString(),
      source: API_BASE,
      version: 'phase1-vm-export',
    },
    health,
    dashboard,
    arenaAgents,
    arenaRecent,
    gameStats,
  };

  const file = path.join(outDir, `vm-export-${stamp}.json`);
  await fs.writeFile(file, JSON.stringify(snapshot, null, 2));

  console.log(`Exported snapshot: ${file}`);
  console.log(`Active channels: ${dashboard?.stats?.activeChannels ?? 0}`);
  console.log(`Recent events: ${Array.isArray(arenaRecent) ? arenaRecent.length : 0}`);
}

main().catch((err) => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
