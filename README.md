# MagicBlock Private Payments PvP Betting Example

This repository is a practical Node.js example for a private PvP betting settlement flow on Solana using the MagicBlock Private Payments API.

It is intentionally not a full game. It isolates the settlement problem that a game, tournament app, or PvP betting page needs to solve:

1. A bettor backs one fighter with an allowed SOL tier.
2. The public app shows only fight metadata and aggregate pool totals.
3. Stake intake moves funds into a private treasury balance.
4. After the fight result is final, the pool is split automatically.
5. Winners should receive private credits and withdraw to their own base wallet.

## Current Devnet Finding

The live repro currently confirms this behavior with the wSOL mint:

- `POST /v1/spl/transfer` with `fromBalance=base` and `toBalance=ephemeral` succeeds for stake intake.
- The treasury private balance increases after intake.
- `POST /v1/spl/withdraw` can work when the treasury withdraws its own private balance back to its own base wallet.
- `POST /v1/spl/transfer` with `fromBalance=ephemeral` and `toBalance=ephemeral` fails when the treasury tries to privately credit an external winner wallet.

The failure is the important part of this repo. The current product requirement is not only private intake; it also needs private payouts so nobody can see which wallet won or received the reward.

## Question For MagicBlock

Using devnet TEE `https://devnet-tee.magicblock.app`, validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, and wSOL mint `So11111111111111111111111111111111111111112`:

1. Is `ephemeral -> ephemeral` private transfer supported for wSOL from a treasury private balance to an external recipient private balance?
2. If yes, what exact recipient initialization is required before the treasury can send the private credit?
3. If no, what is the correct private payout route for `treasury private balance -> external winner private balance -> winner base wallet`?
4. Can the API build a direct private treasury payout to an external recipient without exposing the recipient on base-chain settlement?
5. What are the first-time and recurring costs for 0.01, 0.03, and 0.05 SOL bets, including ATA rent, shuttle/vault/private-account rent, MagicBlock fees, and normal transaction fees?

## Pool Rules

The included betting math follows this split:

- `10%` game fee
- `20%` winning fighter reward
- `70%` winning bettor pool

The winning bettor pool is distributed pro-rata by stake size. Optional MagicBlock or operational costs can be deducted from the bettor pool before pro-rata distribution.

Allowed total stake tiers per wallet per fight:

- `0.01 SOL`
- `0.03 SOL`
- `0.05 SOL`

A wallet may increase from `0.01 -> 0.03 -> 0.05`, but cannot decrease or bet both sides in the same fight. This repo demonstrates the math and settlement pieces; production apps must enforce those rules in their API/database layer.

## Repository Structure

- `src/privatePaymentsClient.js`
  Reusable client for MagicBlock Private Payments API auth, mint initialization, base token balance checks, private balance checks, base-to-private transfers, private transfers, withdraws, TEE RPC submission, and transaction validation helpers.

- `src/bettingMath.js`
  Deterministic PvP betting math with allowed stake tiers and `10/20/70` pro-rata distribution.

- `scripts/reproduce-devnet.js`
  Dry-run simulation by default, plus an opt-in live devnet repro.

- `tests/local-betting-simulation.test.js`
  Unit tests for stake tiers, payout splits, pro-rata distribution, and operational-cost deduction.

- `docs/last-devnet-report.json`
  Last live devnet result committed as a support/debugging artifact.

## Requirements

- Node.js `>=18`
- A funded devnet keypair only if running the live devnet flow
- MagicBlock Private Payments API access
- Solana devnet RPC

Install dependencies:

```bash
npm install
cp .env.example .env
```

## Commands

Run deterministic local tests:

```bash
npm test
```

Run syntax checks:

```bash
npm run check
```

Run a local dry-run simulation. This does not call Solana or MagicBlock:

```bash
npm run simulate
```

Run the live devnet repro:

```bash
npm run devnet:live
```

The live command is intentionally devnet-only. It requires `SERVER_PRIVATE_KEY` in `.env`. Generated bettor and recipient keypairs are funded from the server keypair with devnet SOL unless `BETTOR_PRIVATE_KEY` or `RECIPIENT_PRIVATE_KEY` are provided.

## Environment

```bash
SOLANA_NETWORK=devnet
SOLANA_RPC=https://api.devnet.solana.com
SERVER_PRIVATE_KEY=
BETTOR_PRIVATE_KEY=
RECIPIENT_PRIVATE_KEY=
PVP_BETTING_PRIVATE_MINT=So11111111111111111111111111111111111111112
MAGICBLOCK_PAYMENTS_API_URL=https://payments.magicblock.app
MAGICBLOCK_PRIVATE_TEE_URL=https://devnet-tee.magicblock.app
PVP_BETTING_MAGICBLOCK_VALIDATOR_ID=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
DEMO_INTAKE_SOL=0.01
DEMO_PAYOUT_SOL=0.005
DEMO_BETTOR_WRAP_SOL=0.05
DEMO_RECIPIENT_INIT_SOL=0.001
ESTIMATED_MAGICBLOCK_COST_SOL=0
```

Never commit `.env` or production private keys. The live script should be run only with disposable devnet keys.

## Live Devnet Repro

`npm run devnet:live` performs this flow:

1. Authenticates against MagicBlock Private Payments / TEE.
2. Verifies the TEE identity.
3. Ensures the private mint is initialized.
4. Funds a generated bettor and recipient with devnet SOL for fees.
5. Wraps bettor SOL into wSOL.
6. Builds and submits a private intake transfer: bettor base wSOL -> treasury ephemeral/private balance.
7. Optionally initializes the recipient private balance as a control.
8. Builds and submits the target private payout: treasury ephemeral/private balance -> recipient ephemeral/private balance.
9. Attempts a same-owner treasury withdraw control.

Expected current result: step 6 succeeds, step 8 fails. That reproduces the production blocker.

For browser wallet integration, the server should build unsigned transactions and verify returned signed transactions before submitting them. See `assertUnsignedTransactionSigner`, `verifySignedTransactionMatches`, and `submitSignedTransaction` in `src/privatePaymentsClient.js`.

## Production API Pattern

A production service should usually expose endpoints similar to:

- `POST /fights/:id/bets/prepare`
  Validate fight status, side, wallet eligibility, stake tier, and wallet-side uniqueness. Build unsigned wrap/private-intake transactions.

- `POST /fights/:id/bets/commit`
  Verify the user's signed transaction matches the unsigned transaction prepared by the server, then submit it to the correct destination.

- `POST /fights/:id/settle`
  After the fight result is final, compute the split and queue private winner credits.

- `POST /rewards/:id/withdraw/prepare`
  Build an unsigned withdraw transaction for the connected winner wallet.

- `POST /rewards/:id/withdraw/commit`
  Verify and submit the signed withdraw transaction.

Important safeguards:

- Use signed wallet messages or session tokens for user endpoints.
- Never trust client-provided amounts, side totals, fight status, or payout math.
- Store prepared transaction hashes/nonces and expire them quickly.
- Reject signed transactions whose instructions/accounts differ from the server-built transaction.
- Rate-limit public list/search endpoints.
- Keep treasury private keys server-side only.

## Notes About SOL And wSOL

The Private Payments API works with SPL tokens. This example uses the native wrapped SOL mint:

```text
So11111111111111111111111111111111111111112
```

The UI can present this as SOL, but under the hood users need enough SOL for:

- The stake amount that gets wrapped as wSOL.
- Normal Solana transaction fees.
- First-time associated token account rent for wSOL.
- Any MagicBlock/private-account/shuttle/vault rent or fees required by the Private Payments API.

The exact production fee/rent model is one of the open questions for MagicBlock. For very small bets such as `0.01 SOL`, first-time account creation costs matter a lot.

## Mainnet

This repository defaults to devnet. Before adapting it to mainnet:

- Confirm the current MagicBlock production endpoints and validator ID with MagicBlock.
- Confirm whether private external payouts are supported for wSOL and which route should be used.
- Confirm final API authentication requirements and costs.
- Test with very small amounts first.
- Use isolated custody wallets and strict operational controls.
- Add monitoring and manual freeze/review controls before automatic payout release.
