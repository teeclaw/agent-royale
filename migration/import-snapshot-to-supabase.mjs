#!/usr/bin/env node
/**
 * Import VM snapshot JSON into Supabase tables (phase 1 schema).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node migration/import-snapshot-to-supabase.mjs migration/snapshots/vm-export-....json
 */

import fs from 'node:fs/promises';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error('Usage: node migration/import-snapshot-to-supabase.mjs <snapshot.json>');
  process.exit(1);
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function truncateForReload() {
  await rest('casino_events?id=gt.0', { method: 'DELETE' });
  await rest('casino_rounds?id=gt.0', { method: 'DELETE' });
  await rest('casino_channels?id=gt.0', { method: 'DELETE' });
  await rest('casino_commits?id=gt.0', { method: 'DELETE' });
  await rest('casino_game_stats?game=neq.__none__', { method: 'DELETE' });
}

function mapChannels(snapshot) {
  const channels = snapshot?.dashboard?.channels || [];
  const openedAt = new Date().toISOString();
  return channels.map((c) => ({
    agent: c.agent,
    status: 'open',
    agent_deposit: Number(c.agentBalance || 0),
    casino_deposit: Number(c.casinoBalance || 0),
    agent_balance: Number(c.agentBalance || 0),
    casino_balance: Number(c.casinoBalance || 0),
    nonce: Number(c.nonce || 0),
    games_played: Number(c.gamesPlayed || 0),
    opened_at: openedAt,
  }));
}

function mapRounds(snapshot) {
  const agents = snapshot?.arenaAgents || [];
  const rounds = [];
  for (const a of agents) {
    const g = a.lastGame;
    if (!g) continue;
    rounds.push({
      agent: a.agent,
      game: g.game || 'unknown',
      bet: Number(g.bet || g.cost || 0),
      payout: Number(g.payout || 0),
      won: Boolean(g.won || Number(g.payout || 0) > 0),
      multiplier: g.multiplier ?? null,
      reels: g.reels ?? null,
      choice: g.choice ?? null,
      result: g.result ?? null,
      picked_number: g.pickedNumber ?? null,
      draw_id: g.drawId ?? null,
      ticket_count: g.ticketCount ?? null,
      nonce: g.nonce ?? null,
      timestamp: g.timestamp ? new Date(g.timestamp).toISOString() : new Date().toISOString(),
    });
  }
  return rounds;
}

function mapEvents(snapshot) {
  const events = snapshot?.arenaRecent || [];
  return events.map((e) => ({
    ts: e.ts ? new Date(e.ts).toISOString() : new Date().toISOString(),
    type: e.type || 'game',
    action: e.action || 'unknown',
    agent: e.agent || null,
    result: e.result || null,
  }));
}

function mapGameStats(snapshot) {
  const stats = snapshot?.gameStats || {};
  return Object.entries(stats).map(([game, s]) => ({
    game,
    total_rounds: Number(s.totalRounds || 0),
    total_wagered: Number(s.totalWagered || 0),
    total_paid_out: Number(s.totalPaidOut || 0),
    next_draw_time: s.nextDrawTime ? new Date(s.nextDrawTime).toISOString() : null,
  }));
}

async function insertBatched(table, rows, batchSize = 200) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    await rest(table, { method: 'POST', body: slice });
  }
}

async function main() {
  const raw = await fs.readFile(file, 'utf8');
  const snapshot = JSON.parse(raw);

  const channels = mapChannels(snapshot);
  const rounds = mapRounds(snapshot);
  const events = mapEvents(snapshot);
  const gameStats = mapGameStats(snapshot);

  await truncateForReload();
  await insertBatched('casino_channels', channels);
  await insertBatched('casino_rounds', rounds);
  await insertBatched('casino_events', events);
  await insertBatched('casino_game_stats', gameStats);

  console.log('Import completed');
  console.log(`channels=${channels.length} rounds=${rounds.length} events=${events.length} gameStats=${gameStats.length}`);
}

main().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
