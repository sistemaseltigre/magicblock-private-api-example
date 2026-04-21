function distributePool({
  totalPoolLamports,
  winnerStakeLamports,
  bets,
  gameFeeBps = 1000,
  opsCostLamports = 0,
}) {
  const total = BigInt(Math.max(0, Number(totalPoolLamports || 0)));
  const winnerStake = BigInt(Math.max(0, Number(winnerStakeLamports || 0)));
  const fee = BigInt(Math.max(0, Number(gameFeeBps || 0)));
  const ops = BigInt(Math.max(0, Number(opsCostLamports || 0)));

  const gameFeeLamports = Number((total * fee) / 10000n);
  const winnerPoolLamports = Number((total - BigInt(gameFeeLamports)) > ops ? (total - BigInt(gameFeeLamports) - ops) : 0n);

  if (winnerStake <= 0n) {
    return {
      gameFeeLamports,
      winnerPoolLamports,
      payouts: [],
    };
  }

  const payouts = (bets || []).map((bet) => {
    const stake = BigInt(Math.max(0, Number(bet.stakeLamports || 0)));
    const payout = Number((BigInt(winnerPoolLamports) * stake) / winnerStake);
    return {
      wallet: bet.wallet,
      fighter: bet.fighter,
      stakeLamports: Number(bet.stakeLamports || 0),
      payoutLamports: payout,
    };
  });

  return {
    gameFeeLamports,
    winnerPoolLamports,
    payouts,
  };
}

module.exports = {
  distributePool,
};

