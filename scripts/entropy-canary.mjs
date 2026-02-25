#!/usr/bin/env node

/**
 * Entropy canary check (API level)
 *
 * Env:
 *   BASE_URL=https://agent-royale-v2.vercel.app
 *   STEALTH_ADDRESS=0x...
 */

const base = process.env.BASE_URL || 'http://localhost:3000';
const agent = process.env.STEALTH_ADDRESS;

if (!agent) {
  console.error('Missing STEALTH_ADDRESS env');
  process.exit(1);
}

async function post(action, content = {}) {
  const res = await fetch(`${base}/api/a2a/casino`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-idempotency-key': `${action}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    },
    body: JSON.stringify({
      version: '0.3.0',
      from: { name: 'entropy-canary' },
      message: { contentType: 'application/json', content: { action, stealthAddress: agent, ...content } },
    }),
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const info = await post('info');
  console.log('info.rngProvider=', info?.message?.content?.rngProvider);

  const commit = await post('coinflip_entropy_commit', {
    betAmount: 0.0001,
    choice: 'heads',
  });
  console.log('commit=', JSON.stringify(commit?.message?.content || commit));

  const roundId = commit?.message?.content?.roundId;
  if (!roundId) throw new Error('No roundId from commit');

  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const status = await post('coinflip_entropy_status', { roundId });
    const st = status?.message?.content?.state;
    console.log(`status[${i}]=`, st);
    if (st === 'entropy_fulfilled') {
      const finalize = await post('coinflip_entropy_finalize', { roundId });
      console.log('finalize=', JSON.stringify(finalize?.message?.content || finalize));
      return;
    }
  }

  console.log('Canary incomplete: entropy callback not fulfilled in polling window');
})();
