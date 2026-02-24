module.exports = async (req, res) => {
  res.status(503).json({
    version: '0.3.0',
    from: { name: 'AgentCasino' },
    message: {
      contentType: 'application/json',
      content: {
        error: true,
        message: 'Write path not migrated yet. Phase 1 is read-only on Vercel/Supabase.',
      },
    },
  });
};
