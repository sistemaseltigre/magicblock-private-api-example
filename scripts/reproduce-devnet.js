#!/usr/bin/env node
require('dotenv').config();

const { parseKeypair } = require('../src/keypair');
const { PrivatePaymentsClient } = require('../src/privatePaymentsClient');
const { distributePool } = require('../src/bettingMath');

function pickRecipient(defaultWallet) {
  return String(process.env.PAYOUT_RECIPIENT || '9amaJtjNcRrJsV9Y9unDNdctnuJuUjfybX21DJHorWsg').trim() || defaultWallet;
}

async function main() {
  const keypair = parseKeypair(process.env.SERVER_PRIVATE_KEY);
  const client = new PrivatePaymentsClient({
    keypair,
    cluster: process.env.SOLANA_NETWORK || 'devnet',
    baseRpcUrl: process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
    paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API_URL || 'https://payments.magicblock.app',
    teeUrl: process.env.MAGICBLOCK_TEE_URL || 'https://devnet-tee.magicblock.app',
    validatorId: process.env.MAGICBLOCK_TEE_VALIDATOR_ID || 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo',
    mint: process.env.PRIVATE_MINT || 'So11111111111111111111111111111111111111112',
  });

  const report = {
    startedAt: new Date().toISOString(),
    wallet: client.walletAddress,
    recipient: pickRecipient(client.walletAddress),
    validatorId: client.validatorId,
    mint: client.mint,
    steps: [],
  };

  const teeIdentity = await client.getTeeIdentity();
  report.steps.push({ step: 'tee_identity', ok: teeIdentity === client.validatorId, teeIdentity });

  const mintInit = await client.ensureMintInitialized();
  report.steps.push({ step: 'ensure_mint_initialized', ok: true, signature: mintInit.signature || null });

  const wrap = await client.wrapSolIfNeeded(20_000_000);
  report.steps.push({
    step: 'ensure_base_wsol',
    ok: true,
    wrapped: wrap.wrapped,
    ata: wrap.ata,
    signature: wrap.signature || null,
  });

  const intakeBuilt = await client.buildBaseToEphemeralTransfer({
    from: client.walletAddress,
    to: client.walletAddress,
    amountLamports: 10_000_000,
    memo: 'mb-example-intake',
  });
  const intakeSignature = await client.submitBuiltTransaction(intakeBuilt);
  report.steps.push({
    step: 'private_bet_intake_base_to_ephemeral',
    ok: true,
    sendTo: intakeBuilt.sendTo,
    signature: intakeSignature,
  });

  const payoutPlan = distributePool({
    totalPoolLamports: 10_000_000,
    winnerStakeLamports: 10_000_000,
    bets: [
      { wallet: client.walletAddress, fighter: 'fighter_a', stakeLamports: 10_000_000 },
    ],
    gameFeeBps: 1000,
    opsCostLamports: 0,
  });
  report.steps.push({
    step: 'compute_payouts',
    ok: true,
    gameFeeLamports: payoutPlan.gameFeeLamports,
    winnerPoolLamports: payoutPlan.winnerPoolLamports,
    payouts: payoutPlan.payouts,
  });

  const payoutBuilt = await client.buildEphemeralPayout({
    from: client.walletAddress,
    to: report.recipient,
    amountLamports: payoutPlan.payouts[0].payoutLamports,
    memo: 'mb-example-payout',
    toBalance: 'base',
  });
  report.steps.push({
    step: 'build_private_payout_ephemeral_to_base',
    ok: true,
    sendTo: payoutBuilt.sendTo,
  });

  try {
    const payoutSignature = await client.submitBuiltTransaction(payoutBuilt);
    report.steps.push({
      step: 'submit_private_payout_ephemeral_to_base',
      ok: true,
      signature: payoutSignature,
      note: 'Unexpectedly succeeded. If MagicBlock fixed the issue, this is good news and the repro should be updated.',
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const message = String(error.message || error);
    report.steps.push({
      step: 'submit_private_payout_ephemeral_to_base',
      ok: false,
      expectedFailure: true,
      error: message,
    });
    report.summary = {
      status: 'reproduced_expected_failure',
      note: 'This repository is meant to demonstrate that bet intake works but treasury-side private payout currently fails during ephemeral submission.',
    };
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});

