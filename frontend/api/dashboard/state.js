const { rest, hasConfig } = require('../_supabase');

module.exports = async (req, res) => {
  if (!hasConfig()) return res.status(500).json({ error: true, message: 'Supabase env not configured' });

  try {
    const channels = await rest(
      'casino_channels?select=agent,agent_balance,casino_balance,nonce,games_played,opened_at,status,agent_deposit,casino_deposit&status=eq.open&order=opened_at.desc&limit=200'
    );

    const pending = await rest('casino_commits?select=id&status=eq.pending&limit=1', { headers: { Prefer: 'count=exact' } }).catch(() => []);
    const rounds = await rest('casino_rounds?select=game&limit=1000').catch(() => []);

    const gameSet = new Set((rounds || []).map(r => r.game).filter(Boolean));

    const outChannels = (channels || []).map(ch => {
      const agent = ch.agent || '';
      const short = agent.startsWith('0x') && agent.length > 10 ? `${agent.slice(0, 6)}...${agent.slice(-4)}` : agent;
      const ad = Number(ch.agent_deposit || 0);
      const cd = Number(ch.casino_deposit || 0);
      const ab = Number(ch.agent_balance || 0);
      const cb = Number(ch.casino_balance || 0);
      return {
        agent: short,
        agentBalance: String(ch.agent_balance ?? '0'),
        casinoBalance: String(ch.casino_balance ?? '0'),
        nonce: Number(ch.nonce || 0),
        gamesPlayed: Number(ch.games_played || 0),
        openedAt: ch.opened_at ? new Date(ch.opened_at).getTime() : Date.now(),
        invariantOk: Math.abs((ad + cd) - (ab + cb)) < 1e-12,
      };
    });

    return res.status(200).json({
      server: { uptime: 0, signer: 'Supabase-backed', chain: 8453 },
      contracts: { channelManager: null, bankrollManager: null, insuranceFund: null, relayRouter: null },
      stats: {
        activeChannels: outChannels.length,
        pendingCommits: Array.isArray(pending) ? pending.length : 0,
        registeredGames: gameSet.size || 3,
      },
      channels: outChannels,
      games: {},
    });
  } catch (err) {
    return res.status(500).json({ error: true, message: err.message });
  }
};
