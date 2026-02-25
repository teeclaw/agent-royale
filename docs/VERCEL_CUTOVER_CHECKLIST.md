# Vercel-Only Cutover Checklist

Goal: Agent Royale production runs without Caddy/VM dependency.

## 1) Domain routing
- `agentroyale.xyz` -> Vercel project (frontend)
- `www.agentroyale.xyz` -> Vercel project
- Canonical API host: `www.agentroyale.xyz/api`
- Remove conflicting A/AAAA records that point to VM for production hosts

## 2) Certs
- Verify TLS valid for `agentroyale.xyz` and `www.agentroyale.xyz` in Vercel Domains UI
- Resolve any HTTP-01/ownership challenge failures before cutover

## 3) API health (must pass)
- `https://agentroyale.xyz/api/health`
- `https://www.agentroyale.xyz/api/health`
- `https://agentroyale.xyz/api/dashboard/state`

## 4) Gameplay smoke test (must pass on Vercel)
- open_channel
- one slots round (commit/reveal)
- one coinflip round (commit/reveal)
- lotto_status + lotto_buy
- close_channel

## 5) Data verification in Supabase
- channel row created/updated
- round rows inserted
- events inserted
- game stats incremented

## 6) Disable VM as production path
- Keep VM service for development only
- Ensure production DNS no longer points to VM/Caddy
- Keep rollback notes if emergency reroute is needed

## 7) Observability
- Watch Vercel function logs for errors and timeout spikes
- Track API error rates for first 24h post-cutover

## 8) Production onchain proof (completed 2026-02-25)
- Runtime: `https://agent-royale-v2.vercel.app`
- Signer mode: KMS (`USE_KMS=true`, no private key export)
- Agent wallet: `0x1Af5f519DC738aC0f3B58B19A4bB8A8441937e78`

Real onchain txs:
- Open channel: https://basescan.org/tx/0x93a9b24a0901d169616ef2335100620c82c86907bd605ff023d449fc42e28d78
- Fund casino side (Vercel API onchain-settle open): https://basescan.org/tx/0x3a26849cad1170140d905eb8a37230b6adf52d61c0f6abd629f1c1b7a277efef
- Close channel (after one real coinflip round): https://basescan.org/tx/0xc333533b3bec56cacb63b351f14e48e38e19eb008bfb50bbd10c5f3bab3a13fa

Round evidence:
- Action: `coinflip_commit` + `coinflip_reveal`
- Bet: `0.0001`
- Result: `heads` (win)
- Final balances signed/settled: `agent=0.00109`, `casino=0.00091`
- Verify via API: `/api/arena/recent`, `/api/dashboard/state`, `/api/health` (includes `kms` readiness block)
