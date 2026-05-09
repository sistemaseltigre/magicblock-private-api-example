const LAMPORTS_PER_SOL = 1_000_000_000;
const ALLOWED_BET_SOL = Object.freeze([0.01, 0.03, 0.05]);
const ALLOWED_BET_LAMPORTS = Object.freeze(ALLOWED_BET_SOL.map((value) => Math.round(value * LAMPORTS_PER_SOL)));

function solToLamports(sol) {
  return Math.round(Number(sol || 0) * LAMPORTS_PER_SOL);
}

function lamportsToSol(lamports) {
  return Number(lamports || 0) / LAMPORTS_PER_SOL;
}

function isAllowedBetLamports(lamports) {
  return ALLOWED_BET_LAMPORTS.includes(Number(lamports || 0));
}

function validateBetIncrement(currentLamports, nextTotalLamports) {
  const current = Number(currentLamports || 0);
  const next = Number(nextTotalLamports || 0);
  if (!isAllowedBetLamports(next)) return { ok: false, error: 'invalid_total_stake' };
  if (current === 0) return { ok: true };
  if (!isAllowedBetLamports(current)) return { ok: false, error: 'invalid_existing_stake' };
  if (next <= current) return { ok: false, error: 'stake_must_increase' };
  return { ok: true };
}

function distributePvPPool({
  totalPoolLamports,
  winningStakeTotalLamports,
  winnerBets,
  gameFeeBps = 1000,
  fighterRewardBps = 2000,
  magicblockCostLamports = 0,
}) {
  const totalPool = BigInt(Math.max(0, Number(totalPoolLamports || 0)));
  const winningStakeTotal = BigInt(Math.max(0, Number(winningStakeTotalLamports || 0)));
  const gameFee = BigInt(Math.max(0, Number(gameFeeBps || 0)));
  const fighterReward = BigInt(Math.max(0, Number(fighterRewardBps || 0)));
  const opsCost = BigInt(Math.max(0, Number(magicblockCostLamports || 0)));

  if (gameFee + fighterReward > 10_000n) {
    throw new Error('invalid_pool_split_bps');
  }

  const gameFeeLamports = (totalPool * gameFee) / 10_000n;
  const fighterRewardLamports = (totalPool * fighterReward) / 10_000n;
  const grossBettorPool = totalPool - gameFeeLamports - fighterRewardLamports;
  const bettorPool = grossBettorPool > opsCost ? grossBettorPool - opsCost : 0n;

  const normalizedBets = (winnerBets || []).map((bet, index) => ({
    betId: bet.betId || `bet-${index}`,
    walletAddress: bet.walletAddress || bet.wallet || null,
    fighter: bet.fighter || null,
    stakeLamports: Math.max(0, Number(bet.stakeLamports || 0)),
  }));

  if (winningStakeTotal <= 0n || normalizedBets.length === 0) {
    return {
      gameFeeLamports: Number(gameFeeLamports),
      fighterRewardLamports: Number(fighterRewardLamports),
      magicblockCostLamports: Number(opsCost),
      bettorPoolLamports: 0,
      winnerPoolLamports: 0,
      unallocatedBettorPoolLamports: Number(bettorPool),
      payouts: [],
      dustLamports: 0,
    };
  }

  let allocated = 0n;
  const payouts = normalizedBets.map((bet) => {
    const stake = BigInt(bet.stakeLamports);
    const payout = stake > 0n ? (bettorPool * stake) / winningStakeTotal : 0n;
    allocated += payout;
    return {
      betId: bet.betId,
      walletAddress: bet.walletAddress,
      fighter: bet.fighter,
      stakeLamports: bet.stakeLamports,
      payoutLamports: Number(payout),
    };
  });

  let dust = Number(bettorPool - allocated);
  if (dust > 0) {
    const ordered = [...payouts].sort((a, b) => {
      if (b.stakeLamports !== a.stakeLamports) return b.stakeLamports - a.stakeLamports;
      return String(a.betId).localeCompare(String(b.betId));
    });
    for (let cursor = 0; dust > 0; cursor += 1, dust -= 1) {
      ordered[cursor % ordered.length].payoutLamports += 1;
    }
  }

  return {
    gameFeeLamports: Number(gameFeeLamports),
    fighterRewardLamports: Number(fighterRewardLamports),
    magicblockCostLamports: Number(opsCost),
    bettorPoolLamports: Number(bettorPool),
    winnerPoolLamports: Number(bettorPool),
    unallocatedBettorPoolLamports: 0,
    payouts,
    dustLamports: 0,
  };
}

module.exports = {
  LAMPORTS_PER_SOL,
  ALLOWED_BET_SOL,
  ALLOWED_BET_LAMPORTS,
  solToLamports,
  lamportsToSol,
  isAllowedBetLamports,
  validateBetIncrement,
  distributePvPPool,
  distributePool: distributePvPPool,
};
