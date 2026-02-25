const { rest, hasConfig } = require('../_supabase');

module.exports = async (req, res) => {
  if (!hasConfig()) return res.status(500).json({ error: true, message: 'Supabase env not configured' });

  try {
    const shortAddr = req.query.shortAddr;
    if (!shortAddr) return res.status(400).json({ error: true, message: 'shortAddr required' });

    const channels = await rest('casino_channels?select=agent,agent_deposit,casino_deposit,agent_balance,casino_balance,nonce,opened_at,status&status=eq.open&limit=500');
    const channel = (channels || []).find((c) => {
      const a = c.agent || '';
      const s = a.startsWith('0x') && a.length > 10 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a;
      return s === shortAddr || a.toLowerCase() === String(shortAddr).toLowerCase();
    });

    if (!channel) return res.status(404).json({ error: 'Agent not found or channel closed' });

    const fullAddr = channel.agent;
    const rounds = await rest(
      `casino_rounds?select=game,bet,payout,won,multiplier,reels,choice,result,picked_number,nonce,timestamp,draw_id,ticket_count&agent=eq.${fullAddr}&order=timestamp.desc&limit=200`
    ).catch(() => []);

    const entropyProofs = await rest(
      `casino_entropy_rounds?select=round_id,request_id,request_tx_hash,fulfill_tx_hash,entropy_value,state,created_at,updated_at&agent=eq.${fullAddr}&order=created_at.desc&limit=50`
    ).catch(() => []);

    let totalWagered = 0;
    let totalPayout = 0;
    let agentWins = 0;
    let houseWins = 0;

    for (const g of rounds) {
      const bet = Number(g.bet || 0);
      const payout = Number(g.payout || 0);
      totalWagered += bet;
      totalPayout += payout;
      const won = g.won || payout > 0;
      if (won) agentWins++; else houseWins++;
    }

    const dep = Number(channel.agent_deposit || 0);
    const bal = Number(channel.agent_balance || 0);
    const netPnl = bal - dep;

    res.status(200).json({
      agent: shortAddr,
      status: 'active',
      channel: {
        agentDeposit: String(channel.agent_deposit ?? '0'),
        casinoDeposit: String(channel.casino_deposit ?? '0'),
        agentBalance: String(channel.agent_balance ?? '0'),
        casinoBalance: String(channel.casino_balance ?? '0'),
        nonce: Number(channel.nonce || 0),
        openedAt: channel.opened_at ? new Date(channel.opened_at).getTime() : Date.now(),
      },
      performance: {
        netPnl: String(netPnl),
        netPnlPercent: dep > 0 ? ((netPnl / dep) * 100).toFixed(2) : '0.00',
        totalRounds: rounds.length,
        agentWins,
        houseWins,
        winRate: rounds.length > 0 ? ((agentWins / rounds.length) * 100).toFixed(1) : '0',
        totalWagered: String(totalWagered),
        totalPayout: String(totalPayout),
        biggestWin: '0',
        biggestLoss: '0',
        longestStreak: 0,
        currentStreak: 0,
        currentStreakType: 'none',
      },
      gameBreakdown: {},
      recentGames: rounds.map((g) => ({
        game: g.game,
        bet: String(g.bet ?? '0'),
        payout: String(g.payout ?? '0'),
        won: g.won !== undefined ? Boolean(g.won) : Number(g.payout || 0) > 0,
        multiplier: g.multiplier,
        reels: g.reels,
        choice: g.choice,
        result: g.result,
        pickedNumber: g.picked_number,
        nonce: g.nonce,
        timestamp: g.timestamp ? new Date(g.timestamp).getTime() : Date.now(),
      })),
      entropyProofs: entropyProofs.map((p) => ({
        roundId: p.round_id,
        requestId: p.request_id,
        requestTxHash: p.request_tx_hash,
        fulfillTxHash: p.fulfill_tx_hash,
        randomValue: p.entropy_value,
        state: p.state,
        createdAt: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
        updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
};
