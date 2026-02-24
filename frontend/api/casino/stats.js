const { rest, hasConfig } = require('../_supabase');

const fallback = {
  slots: { totalRounds: 0, totalWagered: '0', totalPaidOut: '0' },
  coinflip: { totalRounds: 0, totalWagered: '0', totalPaidOut: '0' },
  lotto: { totalRounds: 0, totalWagered: '0', totalPaidOut: '0' },
};

module.exports = async (req, res) => {
  if (!hasConfig()) return res.status(500).json({ error: true, message: 'Supabase env not configured' });

  try {
    const rows = await rest('casino_game_stats?select=game,total_rounds,total_wagered,total_paid_out,next_draw_time');
    const out = { ...fallback };
    for (const r of rows || []) {
      out[r.game] = {
        totalRounds: Number(r.total_rounds || 0),
        totalWagered: String(r.total_wagered || '0'),
        totalPaidOut: String(r.total_paid_out || '0'),
        ...(r.next_draw_time ? { nextDrawTime: new Date(r.next_draw_time).getTime() } : {}),
      };
    }
    res.status(200).json(out);
  } catch {
    res.status(200).json(fallback);
  }
};
