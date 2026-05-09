#!/usr/bin/env node
require('dotenv').config();

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
    canonicalPrivatePaymentsFlow: [
      'bettor base balance -> bettor private balance: POST /v1/spl/deposit',
      'custody private balance -> winner private balance: POST /v1/spl/transfer with fromBalance=ephemeral and toBalance=ephemeral',
      'winner private balance -> winner base balance: POST /v1/spl/withdraw signed by winner',
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

function parseRecipientKeypair() {
  if (env('RECIPIENT_PRIVATE_KEY')) {
    return { keypair: parseKeypair(env('RECIPIENT_PRIVATE_KEY')), generated: false };
  }
  return { keypair: Keypair.generate(), generated: true };
}

async function runLiveDevnet() {
  if (env('SOLANA_NETWORK', 'devnet') !== 'devnet') {
    throw new Error('This example script is intentionally devnet-only. Set SOLANA_NETWORK=devnet.');
  }
  if (!env('SERVER_PRIVATE_KEY')) {
    throw new Error('SERVER_PRIVATE_KEY is required for --live.');
  }

  const custodyKeypair = parseKeypair(env('SERVER_PRIVATE_KEY'));
  const recipient = parseRecipientKeypair();
  const custodyClient = createClient(custodyKeypair);
  const recipientClient = createClient(recipient.keypair, custodyClient);
  const fight = createDemoFight();
  const demoDepositLamports = solToLamports(Number(env('DEMO_DEPOSIT_SOL', '0.01')));
  const demoPayoutLamports = Math.min(fight.distribution.payouts[0].payoutLamports, demoDepositLamports);

  const report = {
    mode: 'live-devnet',
    startedAt: new Date().toISOString(),
    custodyWallet: custodyClient.walletAddress,
    recipientWallet: recipientClient.walletAddress,
    recipientKeypairWasGenerated: recipient.generated,
    cluster: custodyClient.cluster,
    baseRpcUrl: custodyClient.baseRpcUrl,
    paymentsApiUrl: custodyClient.paymentsApiUrl,
    teeUrl: custodyClient.teeUrl,
    validatorId: custodyClient.validatorId,
    mint: custodyClient.mint,
    steps: [],
  };

  const teeIdentity = await custodyClient.getTeeIdentity();
  report.steps.push({ step: 'verify_tee_identity', ok: teeIdentity === custodyClient.validatorId, teeIdentity });

  const mintInit = await custodyClient.ensureMintInitialized();
  report.steps.push({ step: 'ensure_private_mint_initialized', ok: true, initializeSignature: mintInit.initializeSignature || null });

  const custodyWrap = await custodyClient.wrapSolIfNeeded(demoDepositLamports);
  report.steps.push({
    step: 'custody_wrap_sol_for_demo_deposit',
    ok: true,
    wrapped: custodyWrap.wrapped,
    ata: custodyWrap.ata || null,
    signature: custodyWrap.signature || null,
  });

  const depositBuilt = await custodyClient.buildDeposit({
    owner: custodyClient.walletAddress,
    amountLamports: demoDepositLamports,
  });
  custodyClient.assertUnsignedTransactionSigner({
    transactionBase64: depositBuilt.transactionBase64,
    signerWallet: custodyClient.walletAddress,
    label: 'deposit',
  });
  const depositSignature = await custodyClient.signAndSubmitBuiltTransaction(depositBuilt);
  report.steps.push({
    step: 'deposit_base_to_ephemeral',
    ok: true,
    sendTo: depositBuilt.sendTo,
    signature: depositSignature,
    amountSol: lamportsToSol(demoDepositLamports),
  });

  const recipientFunding = await custodyClient.transferSolIfNeeded({
    recipient: recipientClient.walletAddress,
    minimumLamports: solToLamports(0.02),
  });
  report.steps.push({ step: 'fund_recipient_for_devnet_fees', ok: true, ...recipientFunding });

  const recipientWrap = await recipientClient.wrapSolIfNeeded(solToLamports(0.001));
  report.steps.push({
    step: 'recipient_wrap_small_sol_for_private_account_init',
    ok: true,
    wrapped: recipientWrap.wrapped,
    ata: recipientWrap.ata || null,
    signature: recipientWrap.signature || null,
  });

  const recipientInitBuilt = await recipientClient.buildDeposit({
    owner: recipientClient.walletAddress,
    amountLamports: solToLamports(0.001),
  });
  const recipientInitSignature = await recipientClient.signAndSubmitBuiltTransaction(recipientInitBuilt);
  report.steps.push({
    step: 'recipient_initialize_private_balance_with_deposit',
    ok: true,
    sendTo: recipientInitBuilt.sendTo,
    signature: recipientInitSignature,
  });

  const privatePayoutBuilt = await custodyClient.buildPrivateTransfer({
    from: custodyClient.walletAddress,
    to: recipientClient.walletAddress,
    amountLamports: demoPayoutLamports,
    memo: 'mb-example-private-payout',
  });
  const privatePayoutSignature = await custodyClient.signAndSubmitBuiltTransaction(privatePayoutBuilt);
  report.steps.push({
    step: 'private_transfer_custody_to_winner_private_balance',
    ok: true,
    sendTo: privatePayoutBuilt.sendTo,
    signature: privatePayoutSignature,
    amountSol: lamportsToSol(demoPayoutLamports),
  });

  const withdrawBuilt = await recipientClient.buildWithdraw({
    owner: recipientClient.walletAddress,
    amountLamports: demoPayoutLamports,
  });
  recipientClient.assertUnsignedTransactionSigner({
    transactionBase64: withdrawBuilt.transactionBase64,
    signerWallet: recipientClient.walletAddress,
    label: 'withdraw',
  });
  const withdrawSignature = await recipientClient.signAndSubmitBuiltTransaction(withdrawBuilt);
  report.steps.push({
    step: 'winner_withdraw_private_balance_to_base',
    ok: true,
    sendTo: withdrawBuilt.sendTo,
    signature: withdrawSignature,
  });

  report.summary = {
    status: 'canonical_flow_succeeded',
    note: 'The live devnet script used deposit for intake, private transfer for winner private credit, and withdraw for winner exit.',
  };
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
