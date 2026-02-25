'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { getArenaAgents } from '@/lib/api';

function formatNum(v: string | number) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toFixed(4) : '0.0000';
}

export default function ArenaPage() {
  const [agents, setAgents] = useState<ArenaAgent[]>([]);

  useEffect(() => {
    const load = () => getArenaAgents().then(setAgents).catch(() => setAgents([]));
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const totals = useMemo(() => agents.reduce((acc, a) => ({ count: acc.count + 1, games: acc.games + Number(a.gamesPlayed || 0) }), { count: 0, games: 0 }), [agents]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Arena</h1>
          <p className="text-sm text-muted-foreground">Live players and latest onchain game outcomes.</p>
        </div>
        <div className="text-right text-xs text-muted-foreground"><p>Players: {totals.count}</p><p>Total games: {totals.games}</p></div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <Card key={agent.agent}>
            <CardContent className="pt-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-mono text-sm text-primary">{agent.agent}</h2>
                <Badge>nonce {agent.nonce}</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Agent balance</p><p className="font-semibold">{formatNum(agent.agentBalance)}</p></div>
                <div><p className="text-xs text-muted-foreground">House balance</p><p className="font-semibold">{formatNum(agent.casinoBalance)}</p></div>
              </div>
              <div className="mt-4 border-t border-border pt-3 text-sm">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Last game</p>
                {agent.lastGame ? <><p className="mt-1 font-medium capitalize">{agent.lastGame.game}</p><p className={agent.lastGame.won ? 'text-primary' : 'text-red-400'}>{agent.lastGame.won ? 'Win' : 'Loss'} · payout {formatNum(agent.lastGame.payout)}</p></> : <p className="mt-1 text-muted-foreground">No rounds yet</p>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {agents.length === 0 ? <Card><CardContent className="pt-10 text-center text-muted-foreground">Waiting for active channels.</CardContent></Card> : null}
    </main>
  );
}
