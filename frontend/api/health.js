const { rest, hasConfig } = require('./_supabase');

async function entropyStats() {
  try {
    const now = Date.now();
    const sinceIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const rows = await rest(`casino_entropy_rounds?select=state,created_at,updated_at&created_at=gte.${encodeURIComponent(sinceIso)}&limit=500`).catch(() => []);
    const pending = rows.filter((r) => r.state === 'entropy_requested').length;
    const fulfilled = rows.filter((r) => r.state === 'settled' || r.state === 'entropy_fulfilled').length;
    const total = rows.length;
    const successRate = total > 0 ? Number((fulfilled / total) * 100).toFixed(1) : '0.0';
    const latencies = rows
      .map((r) => {
        if (!r.created_at || !r.updated_at) return null;
        const a = new Date(r.created_at).getTime();
        const b = new Date(r.updated_at).getTime();
        return b > a ? (b - a) / 1000 : null;
      })
      .filter((x) => Number.isFinite(x));
    const avgCallbackLatencySec = latencies.length
      ? Number(latencies.reduce((s, x) => s + x, 0) / latencies.length).toFixed(1)
      : null;

    return { total24h: total, pending, fulfilled, successRatePct: successRate, avgCallbackLatencySec };
  } catch {
    return null;
  }
}

function kmsHealth() {
  const useKms = String(process.env.USE_KMS || '').toLowerCase() === 'true';
  const hasServiceAccount = Boolean(
    process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  );

  return {
    required: useKms,
    configured: useKms ? hasServiceAccount : true,
    mode: useKms ? 'kms' : 'private-key-fallback',
  };
}

function entropyHealth() {
  const provider = String(process.env.RNG_PROVIDER || '').toLowerCase();
  const enabled = provider === 'pyth_entropy';
  const entropyCoinflip = process.env.ENTROPY_COINFLIP || '';
  const callbackGasLimit = Number(process.env.ENTROPY_CALLBACK_GAS_LIMIT || 120000);

  return {
    provider: provider || 'commit-reveal',
    enabled,
    configured: enabled ? Boolean(entropyCoinflip) : true,
    callbackGasLimit,
    contracts: enabled ? { entropyCoinflip } : {},
  };
}

module.exports = async (req, res) => {
  if (!hasConfig()) {
    return res.status(500).json({ status: 'error', message: 'Supabase env not configured' });
  }

  try {
    // lightweight connectivity probe
    await rest('casino_channels?select=agent&limit=1');
    const stats = await entropyStats();

    return res.status(200).json({
      status: 'ok',
      runtime: 'vercel',
      storage: 'supabase',
      kms: kmsHealth(),
      entropy: {
        ...entropyHealth(),
        stats,
      },
      timestamp: Date.now(),
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};
