module.exports = async (req, res) => {
  // SSE is not enabled in Phase 1 serverless mode; frontend falls back to polling /api/arena/recent
  res.status(501).json({ error: true, message: 'SSE not available in phase 1. Use /api/arena/recent polling.' });
};
