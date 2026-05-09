const assert = require('assert');
const {
  validateBetIncrement,
  solToLamports,
  lamportsToSol,
  distributePvPPool,
} = require('../src/bettingMath');

function testBetTiers() {
  assert.deepStrictEqual(validateBetIncrement(0, solToLamports(0.01)), { ok: true });
  assert.deepStrictEqual(validateBetIncrement(solToLamports(0.01), solToLamports(0.03)), { ok: true });
  assert.strictEqual(validateBetIncrement(solToLamports(0.03), solToLamports(0.01)).error, 'stake_must_increase');
  assert.strictEqual(validateBetIncrement(0, solToLamports(0.02)).error, 'invalid_total_stake');
}

function testSingleWinnerPool() {
  const result = distributePvPPool({
    totalPoolLamports: solToLamports(0.01),
    winningStakeTotalLamports: solToLamports(0.01),
    winnerBets: [
      { betId: 'bet-a', walletAddress: 'wallet-a', fighter: 'fighter_a', stakeLamports: solToLamports(0.01) },
    ],
  });

  assert.strictEqual(result.gameFeeLamports, solToLamports(0.001));
  assert.strictEqual(result.fighterRewardLamports, solToLamports(0.002));
  assert.strictEqual(result.bettorPoolLamports, solToLamports(0.007));
  assert.strictEqual(result.payouts[0].payoutLamports, solToLamports(0.007));
}

function testTenBettorProportionalSplit() {
  const winningBets = [
    ['bet-1', 0.01],
    ['bet-2', 0.03],
    ['bet-3', 0.05],
    ['bet-4', 0.01],
    ['bet-5', 0.05],
  ].map(([betId, sol], index) => ({
    betId,
    walletAddress: `winner-wallet-${index + 1}`,
    fighter: 'gargoyle_a',
    stakeLamports: solToLamports(sol),
  }));

  const losingStake = [0.01, 0.03, 0.03, 0.05, 0.01].reduce((sum, sol) => sum + solToLamports(sol), 0);
  const winningStake = winningBets.reduce((sum, bet) => sum + bet.stakeLamports, 0);
  const totalPool = winningStake + losingStake;
  const result = distributePvPPool({
    totalPoolLamports: totalPool,
    winningStakeTotalLamports: winningStake,
    winnerBets: winningBets,
  });

  assert.strictEqual(lamportsToSol(totalPool), 0.28);
  assert.strictEqual(result.gameFeeLamports, solToLamports(0.028));
  assert.strictEqual(result.fighterRewardLamports, solToLamports(0.056));
  assert.strictEqual(result.bettorPoolLamports, solToLamports(0.196));

  const payoutTotal = result.payouts.reduce((sum, payout) => sum + payout.payoutLamports, 0);
  assert.strictEqual(payoutTotal, result.bettorPoolLamports);
  assert.ok(result.payouts.find((payout) => payout.betId === 'bet-3').payoutLamports > result.payouts.find((payout) => payout.betId === 'bet-2').payoutLamports);
  assert.ok(result.payouts.find((payout) => payout.betId === 'bet-2').payoutLamports > result.payouts.find((payout) => payout.betId === 'bet-1').payoutLamports);
}

function testOpsCostComesFromBettorPool() {
  const result = distributePvPPool({
    totalPoolLamports: solToLamports(0.10),
    winningStakeTotalLamports: solToLamports(0.05),
    magicblockCostLamports: solToLamports(0.001),
    winnerBets: [
      { betId: 'bet-a', walletAddress: 'wallet-a', stakeLamports: solToLamports(0.05) },
    ],
  });

  assert.strictEqual(result.gameFeeLamports, solToLamports(0.01));
  assert.strictEqual(result.fighterRewardLamports, solToLamports(0.02));
  assert.strictEqual(result.bettorPoolLamports, solToLamports(0.069));
  assert.strictEqual(result.payouts[0].payoutLamports, solToLamports(0.069));
}

function run() {
  testBetTiers();
  testSingleWinnerPool();
  testTenBettorProportionalSplit();
  testOpsCostComesFromBettorPool();
  console.log('local-betting-simulation.test.js: ok');
}

run();
