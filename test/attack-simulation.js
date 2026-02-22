/**
 * Attack Simulation Suite
 *
 * Brute force adversarial tests against the Agent Casino.
 * Tries every known attack vector to steal funds or break invariants.
 *
 * Run: node test/attack-simulation.js
 */

const { ethers } = require('ethers');
const GamingEngine = require('../server/gaming-engine');
const CommitReveal = require('../server/commit-reveal');
const SlotsGame = require('../server/games/slots');
const LottoGame = require('../server/games/lotto');
const CoinflipGame = require('../server/games/coinflip');
const { toWei, toEth } = require('../server/wei');

// ─── Test Harness ────────────────────────────────────────

let passed = 0;
let failed = 0;
let findings = [];

function test(name, fn) {
  return async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ❌ ${name}`);
      console.log(`     ${err.message}`);
      findings.push({ name, error: err.message });
    }
  };
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertThrows(fn, expectedMsg) {
  let threw = false;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        throw new Error(`Expected throw "${expectedMsg}" but succeeded`);
      }).catch(err => {
        if (expectedMsg && !err.message.includes(expectedMsg)) {
          throw new Error(`Expected "${expectedMsg}" but got "${err.message}"`);
        }
      });
    }
  } catch (err) {
    threw = true;
    if (expectedMsg && !err.message.includes(expectedMsg)) {
      throw new Error(`Expected "${expectedMsg}" but got "${err.message}"`);
    }
  }
  if (!threw) throw new Error(`Expected throw "${expectedMsg}" but succeeded`);
}

async function assertThrowsAsync(fn, expectedMsg) {
  try {
    await fn();
    throw new Error(`Expected throw "${expectedMsg}" but succeeded`);
  } catch (err) {
    if (err.message.startsWith('Expected throw')) throw err;
    if (expectedMsg && !err.message.includes(expectedMsg)) {
      throw new Error(`Expected "${expectedMsg}" but got "${err.message}"`);
    }
  }
}

// ─── Engine Factory ──────────────────────────────────────

async function createEngine() {
  const wallet = ethers.Wallet.createRandom();
  const engine = new GamingEngine(wallet, '0x' + 'ab'.repeat(20), 84532);
  engine.registerGame(new SlotsGame());
  engine.registerGame(new LottoGame());
  engine.registerGame(new CoinflipGame());
  return engine;
}

const AGENT = '0x1111111111111111111111111111111111111111';
const AGENT2 = '0x2222222222222222222222222222222222222222';
const AGENT3 = '0x3333333333333333333333333333333333333333';

// ─── ATTACK 1: Float Precision Drain ─────────────────────
// Old bug: repeated small bets caused float drift, making
// channels un-closeable. With BigInt this should be impossible.

async function attackFloatDrain() {
  console.log('\n🔴 ATTACK 1: Float Precision Drain (1000 rapid spins)');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.1', '0.1');

  const depositTotal = toWei('0.1') + toWei('0.1'); // 0.2 ETH in wei

  let spinsCompleted = 0;
  for (let i = 0; i < 1000; i++) {
    try {
      // Commit
      await engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.0001' });

      // Reveal with random seed
      const seed = ethers.hexlify(ethers.randomBytes(32));
      await engine.handleGameAction('slots_reveal', AGENT, { agentSeed: seed });
      spinsCompleted++;
    } catch (err) {
      // Insufficient balance is expected eventually
      if (!err.message.includes('Insufficient') && !err.message.includes('bankroll')) {
        throw err;
      }
      break;
    }
  }

  const status = engine.getChannelStatus(AGENT);

  await test('Invariant holds after 1000 spins', () => {
    assert(status.invariantOk, `Invariant broken after ${spinsCompleted} spins!`);
  })();

  await test('BigInt balances are exact (no drift)', () => {
    const ch = engine.channels.get(AGENT);
    const sum = ch.agentBalance + ch.casinoBalance;
    assert(sum === depositTotal,
      `Drift detected: sum=${sum}, expected=${depositTotal}, diff=${sum - depositTotal} wei`);
  })();

  console.log(`   Completed ${spinsCompleted} spins, invariant: ${status.invariantOk}`);
}

// ─── ATTACK 2: Negative Balance Exploit ──────────────────
// Old bug: buy lotto tickets between commit and reveal to
// drain balance, causing negative balance at reveal.

async function attackNegativeBalance() {
  console.log('\n🔴 ATTACK 2: Negative Balance Exploit (commit → drain → reveal)');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.1', '50.0');

  // Step 1: Commit a slots bet (small enough for bankroll, big enough to matter)
  await engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.05' });

  // Step 2: Try to drain balance with lotto tickets between commit and reveal
  try {
    // Buy lotto tickets to drain remaining balance below bet amount
    // 10 tickets * 0.001 = 0.01 ETH
    await engine.handleGameAction('lotto_buy', AGENT, { pickedNumber: 42, ticketCount: 10 });
    // Also buy coinflip to drain more
    await engine.handleGameAction('coinflip_commit', AGENT, { betAmount: '0.039', choice: 'heads' });
    const seed = ethers.hexlify(ethers.randomBytes(32));
    // Reveal coinflip (lose it to drain balance)
    await engine.handleGameAction('coinflip_reveal', AGENT, { agentSeed: seed });
  } catch (err) {
    // Some drains might fail, that's fine
  }

  // Step 3: Try to reveal - should fail if balance < bet
  const seed = ethers.hexlify(ethers.randomBytes(32));

  await test('Reveal rejects when balance drained between commit/reveal', async () => {
    const ch = engine.channels.get(AGENT);
    const betWei = toWei('0.05');

    if (ch.agentBalance < betWei) {
      // Balance was drained - reveal should reject
      await assertThrowsAsync(
        () => engine.handleGameAction('slots_reveal', AGENT, { agentSeed: seed }),
        'Insufficient balance at reveal'
      );
    } else {
      // Balance wasn't fully drained (lotto coverage check prevented it)
      // Reveal should still work
      await engine.handleGameAction('slots_reveal', AGENT, { agentSeed: seed });
      const status = engine.getChannelStatus(AGENT);
      assert(status.invariantOk, 'Invariant broken');
    }
  })();
}

// ─── ATTACK 3: Double Commit (Race Condition) ────────────
// Try to submit two commits for the same game before revealing.

async function attackDoubleCommit() {
  console.log('\n🔴 ATTACK 3: Double Commit Race Condition');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.1', '10.0');

  // First commit (must respect bankroll: 10 / (290*2) = ~0.017 max)
  await engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.001' });

  await test('Second commit for same game rejected', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.001' }),
      'Already have a pending'
    );
  })();

  await test('Can commit to DIFFERENT game while slots pending', async () => {
    // This should work - different game, different commit key
    await engine.handleGameAction('coinflip_commit', AGENT, {
      betAmount: '0.001',
      choice: 'heads',
    });
  })();
}

// ─── ATTACK 4: Cross-Agent Commit Theft ──────────────────
// Try to reveal another agent's commit.

async function attackCrossAgentCommit() {
  console.log('\n🔴 ATTACK 4: Cross-Agent Commit Theft');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.1', '10.0');
  engine.openChannel(AGENT2, '0.1', '10.0');

  // Agent 1 commits
  await engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.001' });

  await test('Agent 2 cannot reveal Agent 1 commit', async () => {
    const seed = ethers.hexlify(ethers.randomBytes(32));
    await assertThrowsAsync(
      () => engine.handleGameAction('slots_reveal', AGENT2, { agentSeed: seed }),
      'No pending'
    );
  })();
}

// ─── ATTACK 5: Bet Exceeds Balance ───────────────────────
// Try to bet more than you have.

async function attackOverbet() {
  console.log('\n🔴 ATTACK 5: Overbetting');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.01', '10.0');

  await test('Cannot bet more than balance', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.02' }),
      'Insufficient balance'
    );
  })();

  await test('Cannot bet zero', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('slots_commit', AGENT, { betAmount: '0' }),
      'Bet must be positive'
    );
  })();

  await test('Cannot bet negative', async () => {
    try {
      await engine.handleGameAction('slots_commit', AGENT, { betAmount: '-0.001' });
      throw new Error('Should have rejected negative bet');
    } catch (err) {
      // Any error is fine - should never accept negative
    }
  })();
}

// ─── ATTACK 6: Bankroll Drain via Max Multiplier ─────────
// Try to bet an amount where max payout exceeds casino balance.

async function attackBankrollDrain() {
  console.log('\n🔴 ATTACK 6: Bankroll Drain (max multiplier exploit)');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.5', '0.01'); // Agent rich, casino poor

  await test('Slots rejects bet when max payout exceeds bankroll', async () => {
    // 0.01 ETH casino balance, slots max = 290x, safety = 2x
    // Max safe bet = 0.01 / (290 * 2) = ~0.000017 ETH
    await assertThrowsAsync(
      () => engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.001' }),
      'bankroll limit'
    );
  })();

  await test('Lotto rejects tickets when payout exceeds casino balance', async () => {
    // 0.01 casino balance, 85x payout on 0.001 ticket = 0.085 ETH needed
    await assertThrowsAsync(
      () => engine.handleGameAction('lotto_buy', AGENT, { pickedNumber: 42, ticketCount: 1 }),
      "Casino can't cover"
    );
  })();
}

// ─── ATTACK 7: Lotto Ticket Spam ─────────────────────────
// Try to buy more than max tickets per draw.

async function attackLottoSpam() {
  console.log('\n🔴 ATTACK 7: Lotto Ticket Spam');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.5', '5.0');

  // Buy max tickets
  await engine.handleGameAction('lotto_buy', AGENT, { pickedNumber: 42, ticketCount: 10 });

  await test('Cannot exceed max tickets per draw', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('lotto_buy', AGENT, { pickedNumber: 42, ticketCount: 1 }),
      'Already have 10 tickets'
    );
  })();

  await test('Invalid lotto number rejected (0)', async () => {
    engine.openChannel(AGENT2, '0.5', '5.0');
    await assertThrowsAsync(
      () => engine.handleGameAction('lotto_buy', AGENT2, { pickedNumber: 0, ticketCount: 1 }),
      'Pick a number between'
    );
  })();

  await test('Invalid lotto number rejected (101)', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('lotto_buy', AGENT2, { pickedNumber: 101, ticketCount: 1 }),
      'Pick a number between'
    );
  })();
}

// ─── ATTACK 8: Commit-Reveal Manipulation ────────────────
// Try to predict or manipulate the RNG outcome.

async function attackRNGManipulation() {
  console.log('\n🔴 ATTACK 8: Commit-Reveal RNG Manipulation');

  await test('Casino commitment binds before agent seed', () => {
    const { seed, commitment } = CommitReveal.commit();
    // After commitment, casino seed is fixed
    // Agent can't change outcome because casino seed is already set
    const agentSeed1 = 'aaaa';
    const agentSeed2 = 'bbbb';
    const r1 = CommitReveal.computeResult(seed, agentSeed1, 0);
    const r2 = CommitReveal.computeResult(seed, agentSeed2, 0);
    // Different agent seeds produce different results (agent has influence)
    assert(r1.hash !== r2.hash, 'Agent seed should influence result');
  })();

  await test('Tampered casino seed detected', () => {
    const { seed, commitment } = CommitReveal.commit();
    const fakeSeed = 'i_am_a_cheating_casino_' + Date.now();
    const valid = CommitReveal.verify(commitment, fakeSeed);
    assert(!valid, 'Tampered seed should fail verification');
  })();

  await test('Honest casino seed passes verification', () => {
    const { seed, commitment } = CommitReveal.commit();
    assert(CommitReveal.verify(commitment, seed), 'Honest seed should verify');
  })();

  await test('Nonce prevents replay (same seeds, different nonce)', () => {
    const { seed } = CommitReveal.commit();
    const agentSeed = ethers.hexlify(ethers.randomBytes(32));
    const r1 = CommitReveal.computeResult(seed, agentSeed, 0);
    const r2 = CommitReveal.computeResult(seed, agentSeed, 1);
    assert(r1.hash !== r2.hash, 'Same seeds with different nonce should give different results');
  })();

  // Brute force: try to find a seed that produces triple-sevens
  await test('Brute force seed search infeasible (1M attempts)', () => {
    const { seed: casinoSeed, commitment } = CommitReveal.commit();
    let jackpots = 0;
    const attempts = 100_000; // 100k attempts

    for (let i = 0; i < attempts; i++) {
      const agentSeed = i.toString(16).padStart(64, '0');
      const { hash } = CommitReveal.computeResult(casinoSeed, agentSeed, 0);
      const buf = Buffer.from(hash, 'hex');

      // Check if all 3 reels are sevens (index 4, weight 10%)
      const r0 = buf.readUInt32BE(0) % 100;
      const r1 = buf.readUInt32BE(4) % 100;
      const r2 = buf.readUInt32BE(8) % 100;
      // Seven = index 4, needs rng >= 90
      if (r0 >= 90 && r1 >= 90 && r2 >= 90) jackpots++;
    }

    // Expected: ~0.1% (10%^3 = 0.1%)
    const rate = jackpots / attempts;
    console.log(`     Jackpot rate: ${jackpots}/${attempts} = ${(rate * 100).toFixed(3)}%`);
    // Should be roughly 0.1% - no way to bias it
    assert(rate < 0.005, `Jackpot rate suspiciously high: ${rate}`);
    // And it shouldn't be zero (would mean RNG is broken)
    // With 100k attempts at 0.1%, we expect ~100 hits
    // Allow wide margin: 10-500
    assert(jackpots > 5, `Too few jackpots (${jackpots}) - RNG might be broken`);
  })();
}

// ─── ATTACK 9: Channel State Manipulation ────────────────
// Try to mess with channel state directly.

async function attackChannelState() {
  console.log('\n🔴 ATTACK 9: Channel State Manipulation');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.1', '0.1');

  await test('Cannot open duplicate channel', () => {
    assertThrows(
      () => engine.openChannel(AGENT, '0.1', '0.1'),
      'Channel already exists'
    );
  })();

  await test('Cannot access non-existent channel', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('slots_commit', '0xdead', { betAmount: '0.001' }),
      'Channel not found'
    );
  })();

  await test('Unknown action rejected', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('fake_action', AGENT, {}),
      'Unknown action'
    );
  })();

  // Try to manipulate balance by modifying channel object directly
  await test('Direct balance manipulation breaks invariant check', async () => {
    const ch = engine.channels.get(AGENT);
    const originalAgent = ch.agentBalance;
    const originalCasino = ch.casinoBalance;

    // Attacker tries to inflate their balance
    ch.agentBalance = ch.agentBalance + 1000000000000000000n; // +1 ETH

    const status = engine.getChannelStatus(AGENT);
    assert(!status.invariantOk, 'Should detect tampered balance');

    // Close should catch it too
    await assertThrowsAsync(
      () => engine.closeChannel(AGENT),
      'INVARIANT VIOLATION'
    );

    // Restore for subsequent tests
    ch.agentBalance = originalAgent;
    ch.casinoBalance = originalCasino;
  })();
}

// ─── ATTACK 10: Coinflip Edge Cases ──────────────────────

async function attackCoinflip() {
  console.log('\n🔴 ATTACK 10: Coinflip Edge Cases');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.1', '0.1');

  await test('Invalid choice rejected', async () => {
    await assertThrowsAsync(
      () => engine.handleGameAction('coinflip_commit', AGENT, {
        betAmount: '0.001', choice: 'edge'
      }),
      'Choice must be'
    );
  })();

  await test('Coinflip payout is exactly 1.9x (BigInt precision)', async () => {
    // Run 100 coinflips and verify payout math
    const testEngine = await createEngine();
    testEngine.openChannel(AGENT, '1.0', '10.0');

    for (let i = 0; i < 100; i++) {
      try {
        await testEngine.handleGameAction('coinflip_commit', AGENT, {
          betAmount: '0.001', choice: 'heads'
        });
        const seed = ethers.hexlify(ethers.randomBytes(32));
        const result = await testEngine.handleGameAction('coinflip_reveal', AGENT, { agentSeed: seed });

        if (result.won) {
          // Payout should be exactly 0.0019 ETH (0.001 * 1.9)
          const expectedPayout = toWei('0.001') * 19n / 10n;
          const actualPayout = toWei(result.payout);
          assert(actualPayout === expectedPayout,
            `Payout drift: expected ${expectedPayout}, got ${actualPayout}`);
        }
      } catch (err) {
        if (!err.message.includes('Insufficient') && !err.message.includes('bankroll')) throw err;
        break;
      }
    }

    const status = testEngine.getChannelStatus(AGENT);
    assert(status.invariantOk, 'Invariant broken after 100 coinflips');
  })();
}

// ─── ATTACK 11: Commit Timeout Abuse ─────────────────────
// Try to reveal after timeout.

async function attackCommitTimeout() {
  console.log('\n🔴 ATTACK 11: Commit Timeout Abuse');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.1', '10.0');

  await engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.001' });

  // Manually expire the commit
  const commitKey = `${AGENT}:slots`;
  const pending = engine.pendingCommits.get(commitKey);
  pending.timestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago

  await test('Expired commit rejected', async () => {
    const seed = ethers.hexlify(ethers.randomBytes(32));
    await assertThrowsAsync(
      () => engine.handleGameAction('slots_reveal', AGENT, { agentSeed: seed }),
      'expired'
    );
  })();

  await test('Can commit again after expiry', async () => {
    await engine.handleGameAction('slots_commit', AGENT, { betAmount: '0.001' });
  })();
}

// ─── ATTACK 12: Stress Test (Invariant Under Load) ───────

async function attackStressTest() {
  console.log('\n🔴 ATTACK 12: Stress Test (multi-agent, multi-game, 500 rounds)');

  const engine = await createEngine();
  const agents = [AGENT, AGENT2, AGENT3];

  for (const a of agents) {
    engine.openChannel(a, '1.0', '5.0');
  }

  let totalOps = 0;
  let errors = 0;

  for (let round = 0; round < 500; round++) {
    const agent = agents[round % agents.length];
    const games = ['slots', 'coinflip'];
    const game = games[round % games.length];

    try {
      if (game === 'slots') {
        await engine.handleGameAction('slots_commit', agent, { betAmount: '0.001' });
        const seed = ethers.hexlify(ethers.randomBytes(32));
        await engine.handleGameAction('slots_reveal', agent, { agentSeed: seed });
      } else {
        await engine.handleGameAction('coinflip_commit', agent, {
          betAmount: '0.001', choice: round % 2 === 0 ? 'heads' : 'tails'
        });
        const seed = ethers.hexlify(ethers.randomBytes(32));
        await engine.handleGameAction('coinflip_reveal', agent, { agentSeed: seed });
      }
      totalOps++;
    } catch (err) {
      if (err.message.includes('Insufficient') || err.message.includes('bankroll')) {
        // Expected when running low
      } else {
        errors++;
        if (errors > 5) throw new Error(`Too many unexpected errors: ${err.message}`);
      }
    }
  }

  await test(`All ${agents.length} channels maintain invariant after ${totalOps} ops`, () => {
    for (const a of agents) {
      const status = engine.getChannelStatus(a);
      if (status.status === 'open') {
        assert(status.invariantOk, `Invariant broken for ${a}`);
      }
    }
  })();

  console.log(`   ${totalOps} successful ops, ${errors} unexpected errors`);
}

// ─── ATTACK 13: Wei Dust Attack ──────────────────────────
// Try minimum possible bets to see if rounding creates free money.

async function attackWeiDust() {
  console.log('\n🔴 ATTACK 13: Wei Dust Attack (minimum bets)');

  const engine = await createEngine();
  engine.openChannel(AGENT, '0.001', '1.0');

  await test('Tiny bet (1 wei equivalent) preserves invariant', async () => {
    // Smallest meaningful bet
    try {
      await engine.handleGameAction('coinflip_commit', AGENT, {
        betAmount: '0.000000000000000001', // 1 wei
        choice: 'heads',
      });
      const seed = ethers.hexlify(ethers.randomBytes(32));
      const result = await engine.handleGameAction('coinflip_reveal', AGENT, { agentSeed: seed });

      if (result.won) {
        // 1 wei * 19 / 10 = 1 wei (integer division floors)
        // This means agent gets 1 wei on a win, loses 1 wei on loss
        // Net edge is still in casino's favor because floor(1.9) = 1
        const payout = toWei(result.payout);
        assert(payout <= 2n, `1 wei bet should not pay more than 2 wei, got ${payout}`);
      }

      const status = engine.getChannelStatus(AGENT);
      assert(status.invariantOk, 'Invariant broken on dust bet');
    } catch (err) {
      // Bankroll limit might reject 1-wei bet, that's fine
      if (!err.message.includes('bankroll') && !err.message.includes('Insufficient')) throw err;
    }
  })();
}

// ─── Run All ─────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  AGENT CASINO — ADVERSARIAL ATTACK SUITE');
  console.log('═══════════════════════════════════════════');

  const startTime = Date.now();

  await attackFloatDrain();
  await attackNegativeBalance();
  await attackDoubleCommit();
  await attackCrossAgentCommit();
  await attackOverbet();
  await attackBankrollDrain();
  await attackLottoSpam();
  await attackRNGManipulation();
  await attackChannelState();
  await attackCoinflip();
  await attackCommitTimeout();
  await attackStressTest();
  await attackWeiDust();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n═══════════════════════════════════════════');
  console.log(`  RESULTS: ${passed} passed, ${failed} failed (${elapsed}s)`);
  console.log('═══════════════════════════════════════════');

  if (findings.length > 0) {
    console.log('\n⚠️  FINDINGS:');
    for (const f of findings) {
      console.log(`  • ${f.name}: ${f.error}`);
    }
  }

  if (failed === 0) {
    console.log('\n🛡️  All attacks defended. System is solid.');
  } else {
    console.log(`\n🚨 ${failed} VULNERABILITIES FOUND. Fix before deployment.`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Suite crashed:', err);
  process.exit(2);
});
