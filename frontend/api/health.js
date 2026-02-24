const { rest, hasConfig } = require('./_supabase');

module.exports = async (req, res) => {
  if (!hasConfig()) {
    return res.status(500).json({ status: 'error', message: 'Supabase env not configured' });
  }

  try {
    // lightweight connectivity probe
    await rest('casino_channels?select=agent&limit=1');

    return res.status(200).json({
      status: 'ok',
      runtime: 'vercel',
      storage: 'supabase',
      timestamp: Date.now(),
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};
