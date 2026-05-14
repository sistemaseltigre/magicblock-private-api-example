#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Keypair } = require('@solana/web3.js');
const { parseKeypair } = require('../src/keypair');
const { PrivatePaymentsClient } = require('../src/privatePaymentsClient');
const { distributePvPPool, solToLamports, lamportsToSol } = require('../src/bettingMath');

function hasFlag(name) {
  return process.argv.includes(name);
}

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function createClient(keypair, baseClient = null) {
  return new PrivatePaymentsClient({
    keypair,
    cluster: baseClient?.cluster || env('SOLANA_NETWORK', 'devnet'),
    baseRpcUrl: baseClient?.baseRpcUrl || env('SOLANA_RPC', 'https://api.devnet.solana.com'),
    paymentsApiUrl: baseClient?.paymentsApiUrl || env('MAGICBLOCK_PAYMENTS_API_URL', 'https://payments.magicblock.app'),
    teeUrl: baseClient?.teeUrl || env('MAGICBLOCK_PRIVATE_TEE_URL', env('MAGICBLOCK_TEE_URL', 'https://devnet-tee.magicblock.app')),
    validatorId: baseClient?.validatorId || env('PVP_BETTING_MAGICBLOCK_VALIDATOR_ID', env('MAGICBLOCK_TEE_VALIDATOR_ID', 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo')),
    mint: baseClient?.mint || env('PVP_BETTING_PRIVATE_MINT', env('PRIVATE_MINT', 'So11111111111111111111111111111111111111112')),
  });
}

function createDemoFight() {
  const bets = [
    { betId: 'bet-001', walletAddress: 'wallet-01', fighter: 'stonefang', side: 'a', stakeLamports: solToLamports(0.01) },
    { betId: 'bet-002', walletAddress: 'wallet-02', fighter: 'stonefang', side: 'a', stakeLamports: solToLamports(0.03) },
    { betId: 'bet-003', walletAddress: 'wallet-03', fighter: 'obsidian', side: 'b', stakeLamports: solToLamports(0.05) },
    { betId: 'bet-004', walletAddress: 'wallet-04', fighter: 'stonefang', side: 'a', stakeLamports: solToLamports(0.05) },
    { betId: 'bet-005', walletAddress: 'wallet-05', fighter: 'obsidian', side: 'b', stakeLamports: solToLamports(0.01) },
    { betId: 'bet-006', walletAddress: 'wallet-06', fighter: 'stonefang', side: 'a', stakeLamports: solToLamports(0.01) },
    { betId: 'bet-007', walletAddress: 'wallet-07', fighter: 'obsidian', side: 'b', stakeLamports: solToLamports(0.03) },
    { betId: 'bet-008', walletAddress: 'wallet-08', fighter: 'stonefang', side: 'a', stakeLamports: solToLamports(0.05) },
    { betId: 'bet-009', walletAddress: 'wallet-09', fighter: 'obsidian', side: 'b', stakeLamports: solToLamports(0.03) },
    { betId: 'bet-010', walletAddress: 'wallet-10', fighter: 'obsidian', side: 'b', stakeLamports: solToLamports(0.01) },
  ];
  const winnerSide = 'a';
  const winnerBets = bets.filter((bet) => bet.side === winnerSide);
  const totalPoolLamports = bets.reduce((sum, bet) => sum + bet.stakeLamports, 0);
  const winningStakeTotalLamports = winnerBets.reduce((sum, bet) => sum + bet.stakeLamports, 0);
  const distribution = distributePvPPool({
    totalPoolLamports,
    winningStakeTotalLamports,
    winnerBets,
    magicblockCostLamports: solToLamports(Number(env('ESTIMATED_MAGICBLOCK_COST_SOL', '0'))),
  });

  return {
    fightId: 'example-fight-001',
    fighterA: 'stonefang',
    fighterB: 'obsidian',
    winnerSide,
    winningFighter: 'stonefang',
    bets,
    totalPoolLamports,
    winningStakeTotalLamports,
    distribution,
  };
}

function printDryRunReport() {
  const fight = createDemoFight();
  const report = {
    mode: 'dry-run',
    summary: 'Local deterministic PvP betting distribution. No RPC or MagicBlock request is made.',
    currentDevnetFinding: [
      'Intake succeeds with POST /v1/spl/transfer using fromBalance=base and toBalance=ephemeral.',
      'Treasury private payout currently fails with POST /v1/spl/transfer using fromBalance=ephemeral and toBalance=ephemeral for wSOL on devnet.',
      'Same-owner withdraw from treasury private balance can work, but that is not the private external payout needed by the betting product.',
    ],
    fight: {
      fightId: fight.fightId,
      fighterA: fight.fighterA,
      fighterB: fight.fighterB,
      winningFighter: fight.winningFighter,
      totalPoolSol: lamportsToSol(fight.totalPoolLamports),
      winningStakeSol: lamportsToSol(fight.winningStakeTotalLamports),
    },
    split: {
      gameFeeSol: lamportsToSol(fight.distribution.gameFeeLamports),
      winningGargoyleRewardSol: lamportsToSol(fight.distribution.fighterRewardLamports),
      winningBettorsPoolSol: lamportsToSol(fight.distribution.bettorPoolLamports),
      magicblockCostSol: lamportsToSol(fight.distribution.magicblockCostLamports),
    },
    payouts: fight.distribution.payouts.map((payout) => ({
      betId: payout.betId,
      walletAddress: payout.walletAddress,
      stakeSol: lamportsToSol(payout.stakeLamports),
      privatePayoutSol: lamportsToSol(payout.payoutLamports),
    })),
  };
  console.log(JSON.stringify(report, null, 2));
}

async function tryStep(report, step, fn) {
  try {
    const result = await fn();
    report.steps.push({ step, ok: true, ...result });
    return { ok: true, result };
  } catch (error) {
    const message = error?.message || String(error);
    report.steps.push({ step, ok: false, error: message });
    return { ok: false, error: message };
  }
}

function writeReport(report) {
  const reportPath = path.join(__dirname, '..', 'docs', 'last-devnet-report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function runLiveDevnet() {
  if (env('SOLANA_NETWORK', 'devnet') !== 'devnet') {
    throw new Error('This example script is intentionally devnet-only. Set SOLANA_NETWORK=devnet.');
  }
  if (!env('SERVER_PRIVATE_KEY')) {
    throw new Error('SERVER_PRIVATE_KEY is required for --live.');
  }

  const custodyKeypair = parseKeypair(env('SERVER_PRIVATE_KEY'));
  const bettorKeypair = env('BETTOR_PRIVATE_KEY') ? parseKeypair(env('BETTOR_PRIVATE_KEY')) : Keypair.generate();
  const recipientKeypair = env('RECIPIENT_PRIVATE_KEY') ? parseKeypair(env('RECIPIENT_PRIVATE_KEY')) : Keypair.generate();
  const custodyClient = createClient(custodyKeypair);
  const bettorClient = createClient(bettorKeypair, custodyClient);
  const recipientClient = createClient(recipientKeypair, custodyClient);

  const intakeLamports = solToLamports(Number(env('DEMO_INTAKE_SOL', env('DEMO_DEPOSIT_SOL', '0.01'))));
  const payoutLamports = solToLamports(Number(env('DEMO_PAYOUT_SOL', '0.005')));
  const bettorWrapLamports = Math.max(solToLamports(Number(env('DEMO_BETTOR_WRAP_SOL', '0.05'))), intakeLamports);
  const recipientInitLamports = solToLamports(Number(env('DEMO_RECIPIENT_INIT_SOL', '0.001')));

  const report = {
    mode: 'live-devnet',
    startedAt: new Date().toISOString(),
    purpose: 'Reproduce the current wSOL Private Payments payout issue for MagicBlock support.',
    custodyWallet: custodyClient.walletAddress,
    bettorWallet: bettorClient.walletAddress,
    recipientWallet: recipientClient.walletAddress,
    bettorKeypairWasGenerated: !env('BETTOR_PRIVATE_KEY'),
    recipientKeypairWasGenerated: !env('RECIPIENT_PRIVATE_KEY'),
    cluster: custodyClient.cluster,
    baseRpcUrl: custodyClient.baseRpcUrl,
    paymentsApiUrl: custodyClient.paymentsApiUrl,
    teeUrl: custodyClient.teeUrl,
    validatorId: custodyClient.validatorId,
    mint: custodyClient.mint,
    amounts: {
      intakeSol: lamportsToSol(intakeLamports),
      payoutSol: lamportsToSol(payoutLamports),
      bettorWrapSol: lamportsToSol(bettorWrapLamports),
      recipientInitSol: lamportsToSol(recipientInitLamports),
    },
    steps: [],
  };

  await tryStep(report, 'verify_tee_identity', async () => {
    const teeIdentity = await custodyClient.getTeeIdentity();
    return { teeIdentity, matchesExpectedValidator: teeIdentity === custodyClient.validatorId };
  });

  await tryStep(report, 'ensure_private_mint_initialized', async () => {
    const mintInit = await custodyClient.ensureMintInitialized();
    return { initializeSignature: mintInit.initializeSignature || null };
  });

  await tryStep(report, 'fund_bettor_for_devnet_wrap_and_fees', async () => (
    custodyClient.transferSolIfNeeded({
      recipient: bettorClient.walletAddress,
      minimumLamports: solToLamports(Number(env('DEMO_BETTOR_SOL_FUNDING', '0.08'))),
    })
  ));

  await tryStep(report, 'fund_recipient_for_devnet_init_and_fees', async () => (
    custodyClient.transferSolIfNeeded({
      recipient: recipientClient.walletAddress,
      minimumLamports: solToLamports(Number(env('DEMO_RECIPIENT_SOL_FUNDING', '0.03'))),
    })
  ));

  const bettorWrap = await tryStep(report, 'bettor_wrap_sol_to_wsol_base_balance', async () => {
    const wrapped = await bettorClient.wrapSolIfNeeded(bettorWrapLamports);
    const balance = await bettorClient.waitForBaseTokenBalanceLamports(bettorClient.walletAddress, intakeLamports);
    return { ...wrapped, baseTokenBalanceLamports: balance?.amountLamports || 0 };
  });
  if (!bettorWrap.ok) {
    report.summary = { status: 'blocked_before_intake', reason: bettorWrap.error };
    writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const intake = await tryStep(report, 'private_intake_base_to_treasury_ephemeral_transfer', async () => {
    const built = await bettorClient.buildBaseToPrivateTransfer({
      from: bettorClient.walletAddress,
      to: custodyClient.walletAddress,
      amountLamports: intakeLamports,
      memo: 'mb-example-intake',
    });
    bettorClient.assertUnsignedTransactionSigner({
      transactionBase64: built.transactionBase64,
      signerWallet: bettorClient.walletAddress,
      label: 'base_to_ephemeral_intake',
    });
    const signature = await bettorClient.signAndSubmitBuiltTransaction(built, bettorKeypair);
    const custodyPrivateBalance = await custodyClient.getPrivateTokenBalanceLamports(custodyClient.walletAddress)
      .catch((error) => ({ error: error.message }));
    return {
      sendTo: built.sendTo,
      signature,
      amountSol: lamportsToSol(intakeLamports),
      custodyPrivateBalanceLamports: custodyPrivateBalance.amountLamports,
      custodyPrivateBalanceError: custodyPrivateBalance.error,
    };
  });

  if (!intake.ok) {
    report.summary = { status: 'intake_failed', reason: intake.error };
    writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  await tryStep(report, 'recipient_initialize_private_balance_optional_control', async () => {
    await recipientClient.wrapSolIfNeeded(recipientInitLamports);
    await recipientClient.waitForBaseTokenBalanceLamports(recipientClient.walletAddress, recipientInitLamports);
    const built = await recipientClient.buildBaseToPrivateTransfer({
      from: recipientClient.walletAddress,
      to: recipientClient.walletAddress,
      amountLamports: recipientInitLamports,
      memo: 'mb-example-recipient-init',
    });
    const signature = await recipientClient.signAndSubmitBuiltTransaction(built, recipientKeypair);
    const recipientPrivateBalance = await recipientClient.getPrivateTokenBalanceLamports(recipientClient.walletAddress)
      .catch((error) => ({ error: error.message }));
    return {
      sendTo: built.sendTo,
      signature,
      recipientPrivateBalanceLamports: recipientPrivateBalance.amountLamports,
      recipientPrivateBalanceError: recipientPrivateBalance.error,
    };
  });

  const privatePayout = await tryStep(report, 'treasury_private_to_winner_private_transfer_expected_issue', async () => {
    const built = await custodyClient.buildPrivateTransfer({
      from: custodyClient.walletAddress,
      to: recipientClient.walletAddress,
      amountLamports: payoutLamports,
      memo: 'mb-example-private-payout',
    });
    const signature = await custodyClient.signAndSubmitBuiltTransaction(built, custodyKeypair);
    return { sendTo: built.sendTo, signature, amountSol: lamportsToSol(payoutLamports) };
  });

  const treasuryWithdraw = await tryStep(report, 'treasury_same_owner_withdraw_control', async () => {
    const withdrawAmount = Math.min(intakeLamports, payoutLamports);
    const built = await custodyClient.buildWithdraw({
      owner: custodyClient.walletAddress,
      amountLamports: withdrawAmount,
    });
    const signature = await custodyClient.signAndSubmitBuiltTransaction(built, custodyKeypair);
    return { sendTo: built.sendTo, signature, amountSol: lamportsToSol(withdrawAmount) };
  });

  report.summary = privatePayout.ok
    ? {
        status: 'private_payout_succeeded',
        note: 'The previously failing treasury ephemeral -> recipient ephemeral route succeeded in this run.',
      }
    : {
        status: 'reproduced_private_payout_failure',
        note: 'Intake base -> treasury ephemeral succeeded, but treasury ephemeral -> recipient ephemeral payout failed. This is the support case.',
        payoutError: privatePayout.error,
        sameOwnerWithdrawControl: treasuryWithdraw.ok ? 'succeeded' : `failed:${treasuryWithdraw.error}`,
      };

  writeReport(report);
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  if (!hasFlag('--live')) {
    printDryRunReport();
    return;
  }
  await runLiveDevnet();
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
