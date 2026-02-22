/**
 * Commit-Reveal RNG
 *
 * Provably fair randomness for off-chain gaming.
 * Casino commits hash(seed) BEFORE agent sends their seed.
 * Neither party can manipulate the result.
 *
 * Flow:
 *   1. Casino: seed = random(), commitment = sha256(seed) → send commitment
 *   2. Agent: sees commitment → sends agentSeed
 *   3. Casino: reveals seed
 *   4. Result: sha256(casinoSeed + agentSeed + nonce)
 *   5. Agent: verifies sha256(casinoSeed) === commitment
 */

const { createHash, randomBytes } = require('crypto');

class CommitReveal {
  /**
   * Step 1: Casino generates seed and commitment.
   * Commitment is sent to agent. Seed stays private until reveal.
   */
  static commit() {
    const seed = randomBytes(32).toString('hex');
    const commitment = createHash('sha256').update(seed).digest('hex');
    return { seed, commitment };
  }

  /**
   * Step 4: Compute deterministic result from both seeds + nonce.
   * Returns BigInt for flexible modular arithmetic.
   */
  static computeResult(casinoSeed, agentSeed, nonce) {
    const input = casinoSeed + ':' + agentSeed + ':' + nonce.toString();
    const hash = createHash('sha256').update(input).digest('hex');
    return {
      hash,
      rng: BigInt('0x' + hash),
      proof: { casinoSeed, agentSeed, nonce, resultHash: hash },
    };
  }

  /**
   * Step 5: Agent verifies casino's commitment matches revealed seed.
   * Returns false if casino cheated.
   */
  static verify(commitment, casinoSeed) {
    const expected = createHash('sha256').update(casinoSeed).digest('hex');
    return expected === commitment;
  }
}

module.exports = CommitReveal;
