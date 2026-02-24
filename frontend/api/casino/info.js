module.exports = async (req, res) => {
  res.status(200).json({
    name: 'Agent Royale',
    chain: 8453,
    mode: 'vercel-supabase',
    privacy: 'Stealth addresses + off-chain gameplay metadata',
    notes: 'Phase 1 read API on Supabase',
  });
};
