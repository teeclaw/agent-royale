const { rest, hasConfig } = require('../_supabase');

module.exports = async (req, res) => {
  if (!hasConfig()) return res.status(500).json({ error: true, message: 'Supabase env not configured' });

  try {
    const channels = await rest(
      'casino_channels?select=agent,agent_balance,casino_balance,nonce,games_played,opened_at,status&status=eq.open&order=opened_at.desc&limit=200'
    );

    const rounds = await rest(
      'casino_rounds?select=agent,game,bet,payout,won,multiplier,reels,choice,result,picked_number,timestamp,nonce,draw_id,ticket_count&order=timestamp.desc&limit=1000'
    ).catch(() => []);

    const latestByAgent = new Map();
    for (const r of (rounds || [])) {
      if (!r.agent || latestByAgent.has(r.agent)) continue;
      latestByAgent.set(r.agent, {
        game: r.game,
        bet: String(r.bet ?? '0'),
        payout: String(r.payout ?? '0'),
        won: Boolean(r.won),
        multiplier: r.multiplier,
        reels: r.reels,
        choice: r.choice,
        result: r.result,
        pickedNumber: r.picked_number,
        ticketCount: r.ticket_count,
        drawId: r.draw_id,
        nonce: r.nonce,
        timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
      });
    }

    const out = (channels || []).map(ch => {
      const full = ch.agent || '';
      const short = full.startsWith('0x') && full.length > 10 ? `${full.slice(0, 6)}...${full.slice(-4)}` : full;
      return {
        agent: short,
        agentBalance: String(ch.agent_balance ?? '0'),
        casinoBalance: String(ch.casino_balance ?? '0'),
        nonce: Number(ch.nonce || 0),
        gamesPlayed: Number(ch.games_played || 0),
        openedAt: ch.opened_at ? new Date(ch.opened_at).getTime() : Date.now(),
        lastGame: latestByAgent.get(full) || null,
        recentGames: [],
      };
    });

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
};
