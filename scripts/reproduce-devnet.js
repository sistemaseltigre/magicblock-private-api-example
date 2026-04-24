#!/usr/bin/env node
require('dotenv').config();

const { Keypair } = require('@solana/web3.js');
const { parseKeypair } = require('../src/keypair');
const { PrivatePaymentsClient } = require('../src/privatePaymentsClient');
const { distributePool } = require('../src/bettingMath');

function parseRecipientKeypair() {
  if (process.env.RECIPIENT_PRIVATE_KEY) {
    return {
      keypair: parseKeypair(process.env.RECIPIENT_PRIVATE_KEY),
      generated: false,
    };
  }
  return {
    keypair: Keypair.generate(),
    generated: true,
  };
}

function createClient(keypair, baseClient = null) {
  return new PrivatePaymentsClient({
    keypair,
    cluster: baseClient?.cluster || process.env.SOLANA_NETWORK || 'devnet',
    baseRpcUrl: baseClient?.baseRpcUrl || process.env.SOLANA_RPC || 'https://api.devnet.solana.com',
    paymentsApiUrl: baseClient?.paymentsApiUrl || process.env.MAGICBLOCK_PAYMENTS_API_URL || 'https://payments.magicblock.app',
    teeUrl: baseClient?.teeUrl || process.env.MAGICBLOCK_TEE_URL || 'https://devnet-tee.magicblock.app',
    validatorId: baseClient?.validatorId || process.env.MAGICBLOCK_TEE_VALIDATOR_ID || 'MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo',
    mint: baseClient?.mint || process.env.PRIVATE_MINT || 'So11111111111111111111111111111111111111112',
  });
}

async function main() {
  const custodyKeypair = parseKeypair(process.env.SERVER_PRIVATE_KEY);
  const recipient = parseRecipientKeypair();
  const custodyClient = createClient(custodyKeypair);
  const recipientClient = createClient(recipient.keypair, custodyClient);

  const report = {
    startedAt: new Date().toISOString(),
    custodyWallet: custodyClient.walletAddress,
    recipientWallet: recipientClient.walletAddress,
    recipientKeypairWasGenerated: recipient.generated,
    validatorId: custodyClient.validatorId,
    mint: custodyClient.mint,
    steps: [],
  };

  const teeIdentity = await custodyClient.getTeeIdentity();
  report.steps.push({ step: 'tee_identity', ok: teeIdentity === custodyClient.validatorId, teeIdentity });

  const mintInit = await custodyClient.ensureMintInitialized();
  report.steps.push({ step: 'ensure_mint_initialized', ok: true, signature: mintInit.signature || null });

  const custodyWrap = await custodyClient.wrapSolIfNeeded(20_000_000);
  report.steps.push({
    step: 'custody_ensure_base_wsol',
    ok: true,
    wrapped: custodyWrap.wrapped,
    ata: custodyWrap.ata,
    signature: custodyWrap.signature || null,
  });

  const intakeBuilt = await custodyClient.buildDeposit({
    owner: custodyClient.walletAddress,
    amountLamports: 10_000_000,
  });
  const intakeSignature = await custodyClient.submitBuiltTransaction(intakeBuilt);
  report.steps.push({
    step: 'private_bet_intake_deposit_base_to_ephemeral',
    ok: true,
    sendTo: intakeBuilt.sendTo,
    signature: intakeSignature,
  });

  const recipientFunding = await custodyClient.transferSolIfNeeded({
    recipient: recipientClient.walletAddress,
    minimumLamports: 20_000_000,
  });
  report.steps.push({
    step: 'fund_recipient_for_devnet_fees',
    ok: true,
    ...recipientFunding,
  });

  const recipientWrap = await recipientClient.wrapSolIfNeeded(1_000_000);
  report.steps.push({
    step: 'recipient_ensure_base_wsol',
    ok: true,
    wrapped: recipientWrap.wrapped,
    ata: recipientWrap.ata,
    signature: recipientWrap.signature || null,
  });

  const recipientInitBuilt = await recipientClient.buildDeposit({
    owner: recipientClient.walletAddress,
    amountLamports: 1_000_000,
  });
  const recipientInitSignature = await recipientClient.submitBuiltTransaction(recipientInitBuilt);
  report.steps.push({
    step: 'recipient_initialize_private_balance_with_deposit',
    ok: true,
    sendTo: recipientInitBuilt.sendTo,
    signature: recipientInitSignature,
  });

  const payoutPlan = distributePool({
    totalPoolLamports: 10_000_000,
    winnerStakeLamports: 10_000_000,
    bets: [
      { wallet: recipientClient.walletAddress, fighter: 'fighter_a', stakeLamports: 10_000_000 },
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

  try {
    const privatePayoutBuilt = await custodyClient.buildPrivateTransfer({
      from: custodyClient.walletAddress,
      to: recipientClient.walletAddress,
      amountLamports: payoutPlan.payouts[0].payoutLamports,
      memo: 'mb-example-private-payout',
    });
    report.steps.push({
      step: 'build_private_payout_ephemeral_to_ephemeral',
      ok: true,
      sendTo: privatePayoutBuilt.sendTo,
    });

    const privatePayoutSignature = await custodyClient.submitBuiltTransaction(privatePayoutBuilt);
    report.steps.push({
      step: 'submit_private_payout_ephemeral_to_ephemeral',
      ok: true,
      signature: privatePayoutSignature,
    });

    const withdrawBuilt = await recipientClient.buildWithdraw({
      owner: recipientClient.walletAddress,
      amountLamports: payoutPlan.payouts[0].payoutLamports,
    });
    const withdrawSignature = await recipientClient.submitBuiltTransaction(withdrawBuilt);
    report.steps.push({
      step: 'recipient_withdraw_ephemeral_to_base',
      ok: true,
      sendTo: withdrawBuilt.sendTo,
      signature: withdrawSignature,
    });

    report.summary = {
      status: 'canonical_flow_succeeded',
      note: 'Deposit intake, private transfer payout, and recipient withdraw all succeeded on devnet.',
    };
  } catch (error) {
    report.steps.push({
      step: 'canonical_payout_flow',
      ok: false,
      error: String(error.message || error),
    });
    report.summary = {
      status: 'canonical_flow_failed',
      note: 'This script follows MagicBlock guidance: deposit for intake, private transfer to recipient, then recipient withdraw.',
    };
  }

  console.log(JSON.stringify(report, null, 2));
  if (report.summary.status !== 'canonical_flow_succeeded') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});

