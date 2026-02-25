# Pyth Entropy Rollout Spec (Agent Royale)

Status: Draft for implementation
Owner: Agent Royale
Scope: Coinflip first, then Slots and Lotto

## 1) Goal

Ship verifiable onchain randomness without Chainlink subscription overhead.

Use Pyth Entropy as the randomness provider while preserving current production stability:
- keep existing channel custody and settlement flow working
- add proof-grade randomness artifacts to each round
- expose proof links in API and frontend

## 2) Product Strategy

Phase 1 uses Coinflip only. This gives the fastest trust upgrade with the least contract and UX complexity.

- Current mode: offchain commit-reveal
- New mode: Entropy-backed async finalize
- Migration mode: dual-path behind feature flag

## 3) Architecture

### 3.1 Components

1. `EntropyCoinflip.sol` (new)
- Requests entropy from Pyth Entropy contract
- Stores request lifecycle by `requestId`
- Finalizes round outcome from entropy output
- Emits proof events

2. Existing settlement stack (unchanged initially)
- `ChannelManager` remains source of channel custody and close settlement
- API still updates round/channel state in Supabase

3. API integration (`frontend/api/a2a/casino.js`)
- Add entropy-specific commit/finalize actions
- Enforce idempotency and timeout logic
- Persist proof metadata

4. Frontend proof UI
- Show request tx, fulfill tx, requestId, entropy output, deterministic formula

### 3.2 Trust Boundary

- Randomness source becomes onchain/verifiable (Entropy)
- Result derivation must be pure deterministic formula from entropy output
- Balance accounting remains current hybrid path during phase 1

## 4) State Machine (Coinflip v1)

States per round:
1. `created`
2. `entropy_requested`
3. `entropy_fulfilled`
4. `settled`
5. `expired` (timeout)
6. `failed`

Allowed transitions:
- created -> entropy_requested
- entropy_requested -> entropy_fulfilled
- entropy_fulfilled -> settled
- entropy_requested -> expired
- any -> failed (terminal)

## 5) API Contract

## 5.1 New actions

1. `coinflip_entropy_commit`
Input:
- `stealthAddress`
- `betAmount`
- `choice` (`heads|tails`)

Output:
- `roundId`
- `requestId`
- `requestTxHash`
- `status: "entropy_requested"`
- `expiresAt`

2. `coinflip_entropy_finalize`
Input:
- `stealthAddress`
- `roundId` (or `requestId`)

Output:
- `status`
- `won`
- `result`
- `payout`
- `agentBalance`
- `casinoBalance`
- `nonce`
- `proof` object:
  - `provider: "pyth_entropy"`
  - `requestId`
  - `requestTxHash`
  - `fulfillTxHash`
  - `randomValue`
  - `formula: "uint256(randomValue) % 2"`
  - `derivedResult`

3. Optional `coinflip_entropy_status`
Input:
- `roundId` or `requestId`
Output:
- current round state and readiness

### 5.2 Errors

Standardized error codes:
- `ENTROPY_NOT_READY`
- `ROUND_NOT_FOUND`
- `ROUND_EXPIRED`
- `INVALID_CHOICE`
- `MAX_BET_EXCEEDED`
- `CHANNEL_NOT_FOUND`
- `INSUFFICIENT_BALANCE`
- `IDEMPOTENCY_REPLAY`

## 6) Contract Design Notes

## 6.1 EntropyCoinflip storage

Per round/request:
- `agent`
- `betAmount`
- `choice`
- `nonceSnapshot`
- `requestId`
- `requestTxHash` (optional offchain indexed)
- `entropyValue`
- `createdAt`
- `fulfilledAt`
- `state`

## 6.2 Event schema

- `EntropyRequested(bytes32 indexed requestId, bytes32 indexed roundId, address indexed agent, uint256 betAmount, uint8 choice)`
- `EntropyFulfilled(bytes32 indexed requestId, bytes32 indexed roundId, bytes32 entropyValue)`
- `RoundSettled(bytes32 indexed roundId, address indexed agent, bool won, uint256 payout, uint256 nonce)`
- `RoundExpired(bytes32 indexed roundId)`

## 6.3 Deterministic result mapping

- Convert entropy output to uint256
- `resultBit = random % 2`
- `0 => heads`, `1 => tails`
- Win if `choice == result`

## 6.4 Security requirements

- callback origin must be Pyth Entropy contract only
- one-time fulfillment guard per request
- replay-protected finalize path
- timeout handler for stuck rounds
- pause switch and owner-only config mutators

## 7) Risk Controls (Industry Best Practice)

1. Bet limits
- Reuse current dynamic max-bet logic for bankroll safety
- enforce at commit time

2. Timeout policy
- round TTL (ex: 5 minutes)
- if not fulfilled in time, mark expired and unblock funds path

3. Idempotency
- require idempotency key on commit/finalize
- make finalize safe to retry

4. Monitoring
- request->fulfill latency histogram
- pending rounds count
- failed fulfill rate
- payout anomaly alerts

5. Emergency controls
- pause entropy mode independently of core API
- fallback path to existing commit-reveal for continuity

## 8) Data Model Updates (Supabase)

Add/extend tables:

1. `casino_entropy_rounds`
- `id`
- `agent`
- `game`
- `bet_amount`
- `choice`
- `request_id`
- `request_tx_hash`
- `fulfill_tx_hash`
- `entropy_value`
- `state`
- `won`
- `payout`
- `nonce`
- `created_at`
- `updated_at`

2. `casino_events`
- include entropy proof metadata in payload for frontend timeline

3. `casino_rounds`
- optional columns for `rng_provider`, `rng_request_id`, `rng_fulfill_tx_hash`

## 9) Frontend UX Requirements

1. Coinflip card badge
- `Verifiable RNG: Pyth Entropy`

2. Proof drawer per round
- Request ID
- Request tx link
- Fulfill tx link
- Random value
- Formula and derived result

3. Clear state labels
- Requested
- Waiting for entropy
- Settled
- Expired

## 10) Rollout Plan

### Phase A (staging)
- deploy contract on Base Sepolia
- run 100 round soak test
- verify no stuck rounds

### Phase B (production canary)
- enable for limited traffic (`RNG_PROVIDER=pyth_entropy` + canary gate)
- monitor latency/failures for 24h

### Phase C (default coinflip)
- set entropy as default provider for coinflip
- keep commit-reveal fallback flag available

### Phase D (expand)
- Slots integration
- Lotto integration

## 11) Acceptance Criteria

- >=95% entropy rounds complete with full proof metadata
- no fund-accounting drift in channel balances
- no unhandled pending rounds past TTL
- API proof payload renders correctly on homepage/arena/agent views

## 12) Env + Config Checklist

- `RNG_PROVIDER=pyth_entropy`
- `PYTH_ENTROPY_CONTRACT`
- `PYTH_ENTROPY_FEE_LIMIT`
- `ENTROPY_ROUND_TTL_MS`
- `ENTROPY_CANARY_PERCENT`

## 13) Out of Scope (for this rollout)

- full onchain game engine for all games
- removal of existing offchain commit-reveal path
- redesign of channel custody contracts

---

Decision recommendation:
Start with Coinflip entropy path immediately, ship proof UX first, then graduate to default after canary stability.
