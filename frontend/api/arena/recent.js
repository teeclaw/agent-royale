const { rest, hasConfig } = require('../_supabase');

module.exports = async (req, res) => {
  if (!hasConfig()) return res.status(500).json({ error: true, message: 'Supabase env not configured' });

  try {
    const events = await rest('casino_events?select=ts,type,action,agent,result&order=ts.desc&limit=50');
    res.status(200).json(events || []);
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
};
