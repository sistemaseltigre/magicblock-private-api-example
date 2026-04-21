const assert = require('assert');
const { distributePool } = require('../src/bettingMath');

function testSingleWinnerPool() {
  const result = distributePool({
    totalPoolLamports: 10_000_000,
    winnerStakeLamports: 10_000_000,
    bets: [
      { wallet: 'wallet-a', fighter: 'fighter_a', stakeLamports: 10_000_000 },
    ],
    gameFeeBps: 1000,
  });

  assert.strictEqual(result.gameFeeLamports, 1_000_000);
  assert.strictEqual(result.winnerPoolLamports, 9_000_000);
  assert.strictEqual(result.payouts.length, 1);
  assert.strictEqual(result.payouts[0].payoutLamports, 9_000_000);
}

function testProportionalSplit() {
  const result = distributePool({
    totalPoolLamports: 80_000_000,
    winnerStakeLamports: 40_000_000,
    bets: [
      { wallet: 'wallet-a', fighter: 'fighter_a', stakeLamports: 10_000_000 },
      { wallet: 'wallet-b', fighter: 'fighter_a', stakeLamports: 30_000_000 },
    ],
    gameFeeBps: 1000,
  });

  assert.strictEqual(result.gameFeeLamports, 8_000_000);
  assert.strictEqual(result.winnerPoolLamports, 72_000_000);
  assert.strictEqual(result.payouts[0].payoutLamports, 18_000_000);
  assert.strictEqual(result.payouts[1].payoutLamports, 54_000_000);
}

function run() {
  testSingleWinnerPool();
  testProportionalSplit();
  console.log('local-betting-simulation.test.js: ok');
}

run();

