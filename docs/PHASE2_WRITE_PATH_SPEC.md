# Phase 2 Spec: Vercel-native Write Path (`/api/a2a/casino`)

Status: approved plan, implementation target
Owner: Agent Royale

## Goal
Move gameplay writes fully to Vercel + Supabase so production no longer depends on VM runtime memory.

## Endpoint
`POST /api/a2a/casino`

A2A payload shape remains compatible with current clients:

```json
{
  "version": "0.3.0",
  "from": { "name": "Anonymous" },
  "message": {
    "contentType": "application/json",
    "content": {
      "action": "open_channel",
      "stealthAddress": "0x...",
      "agentDeposit": "0.001",
      "casinoDeposit": "0.001"
    }
  }
}
```

## Supported actions (Phase 2)
1. `open_channel`
2. `channel_status`
3. `close_channel`
4. `slots_commit`
5. `slots_reveal`
6. `coinflip_commit`
7. `coinflip_reveal`
8. `lotto_buy`
9. `lotto_status`
10. `info`
11. `stats`

## Data model (Supabase)
Primary tables already present in Phase 1:
- `casino_channels`
- `casino_commits`
- `casino_rounds`
- `casino_events`
- `casino_game_stats`

New tables for write integrity:
- `casino_requests` (idempotency and replay safety)
- `casino_lotto_draws` (draw metadata)
- `casino_lotto_tickets` (tickets per draw)

## Critical invariants
- Balance conservation per channel:
  - `agent_deposit + casino_deposit == agent_balance + casino_balance`
- Nonce monotonic:
  - every resolved round increments nonce by 1
- Single pending commit per `(agent, game)`
- Idempotency:
  - repeated request with same idempotency key returns same response

## Idempotency strategy
Derive request key from:
- explicit header `x-idempotency-key`, else
- hash(action + stealthAddress + nonceCandidate + stable params)

Store in `casino_requests` with response body snapshot.

## Randomness model
Keep current commit-reveal model in Phase 2:
- commit stores commitment hash in `casino_commits`
- reveal validates commitment + timeout (5 min)
- result generated deterministically from casinoSeed + agentSeed

## Transaction boundaries
Use Postgres transaction (RPC or SQL function) for each mutating action:
- lock channel row (`FOR UPDATE`)
- validate constraints
- update channel balances and nonce
- insert round/event rows
- update stats rows
- commit atomically

## Error codes (stable)
- `CHANNEL_NOT_FOUND`
- `CHANNEL_ALREADY_EXISTS`
- `INVALID_BET`
- `MAX_BET_EXCEEDED`
- `PENDING_COMMIT_EXISTS`
- `COMMIT_NOT_FOUND`
- `COMMIT_EXPIRED`
- `INVARIANT_VIOLATION`
- `INSUFFICIENT_BALANCE`

## Response contract
Return compatible envelope:

```json
{
  "version": "0.3.0",
  "from": { "name": "AgentCasino" },
  "message": {
    "contentType": "application/json",
    "content": { }
  }
}
```

## Rollout sequence
1. Implement `open_channel`, `channel_status`, `close_channel`
2. Implement `coinflip_commit/reveal` (smallest write surface)
3. Implement `slots_commit/reveal`
4. Implement `lotto_buy/status`
5. Activate `/api/a2a/casino` in production
6. Disable VM write path

## Verification checklist
- API tests for each action (success + failure)
- Nonce increments correctly across rounds
- Conservation invariant always true
- Dashboard reflects writes within polling interval
- Repeat identical request key returns identical response

## Out of scope for Phase 2
- Chainlink VRF migration
- Fully onchain round settlement
- Advanced anti-collusion analytics
