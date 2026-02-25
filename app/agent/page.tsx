'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getAgentProfile, getArenaAgents } from '@/lib/api';

function fmt(v: string | number) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
}

export default function AgentPage() {
  const [agents, setAgents] = useState<ArenaAgent[]>([]);
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState('');
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { getArenaAgents().then(setAgents).catch(() => setAgents([])); }, []);

  useEffect(() => {
    if (!selected) return;
    setLoading(true);
    getAgentProfile(selected).then(setProfile).catch(() => setProfile(null)).finally(() => setLoading(false));
  }, [selected]);

  const list = useMemo(() => agents.map((a) => a.agent), [agents]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    setSelected(input.trim());
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-4 text-2xl font-bold">Agent</h1>
      <form onSubmit={onSubmit} className="mb-6 flex gap-2"><Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="0xABCD...1234" className="font-mono" /><Button type="submit">Lookup</Button></form>
      <div className="mb-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{list.map((addr) => <button key={addr} onClick={() => setSelected(addr)} className="rounded-md border border-border bg-card px-3 py-2 text-left font-mono text-xs hover:border-primary">{addr}</button>)}</div>
      {loading ? <p className="text-muted-foreground">Loading profile...</p> : null}
      {!loading && profile ? (
        <Card>
          <CardContent className="space-y-4 pt-5">
            <div><p className="font-mono text-primary">{profile.agent}</p><p className="text-sm text-muted-foreground">Status: {profile.status}</p></div>
            <div className="grid gap-4 md:grid-cols-3">
              <div><p className="text-xs text-muted-foreground">Net PnL</p><p className={Number(profile.performance.netPnl) >= 0 ? 'text-primary' : 'text-red-400'}>{fmt(profile.performance.netPnl)} ({profile.performance.netPnlPercent}%)</p></div>
              <div><p className="text-xs text-muted-foreground">Win rate</p><p>{profile.performance.winRate}%</p></div>
              <div><p className="text-xs text-muted-foreground">Rounds</p><p>{profile.performance.totalRounds}</p></div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div><p className="text-xs text-muted-foreground">Agent balance</p><p>{fmt(profile.channel.agentBalance)}</p></div>
              <div><p className="text-xs text-muted-foreground">Casino balance</p><p>{fmt(profile.channel.casinoBalance)}</p></div>
            </div>
            <div>
              <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">Recent games</p>
              <div className="space-y-2">{profile.recentGames.slice(0, 8).map((g, i) => <div key={`${g.nonce}-${i}`} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm"><span className="capitalize">{g.game}</span><span className={g.won ? 'text-primary' : 'text-red-400'}>{g.won ? 'Win' : 'Loss'} · {fmt(g.payout)}</span></div>)}</div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}
