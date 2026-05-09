# MagicBlock Private Payments PvP Betting Example

This repository is a practical Node.js example for building a private PvP betting settlement flow on Solana with the MagicBlock Private Payments API.

It is intentionally not a full game. It focuses on the settlement pattern that a game, tournament app, or PvP betting page can reuse:

1. Bettors choose one fighter and stake an allowed amount.
2. Public game state can show fight metadata, total pool, and side totals.
3. Private settlement hides the movement of funds through MagicBlock private balances.
4. After the fight winner is known, the pool is split automatically.
5. Winners receive a private balance credit and withdraw with their own wallet.

## Why This Example Exists

The common mistake is trying to use `POST /v1/spl/transfer` for both legs:

- base wallet -> ephemeral/private balance
- ephemeral/private treasury -> external base wallet

The canonical pattern used here is:

- Intake: `POST /v1/spl/deposit`
- Private payout credit: `POST /v1/spl/transfer` with `fromBalance=ephemeral` and `toBalance=ephemeral`
- Exit to base wallet: `POST /v1/spl/withdraw`

This means the app can automate winner calculations and private credits, while each winner signs their own withdraw transaction to move funds back to their base wallet.

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

A wallet may increase from `0.01 -> 0.03 -> 0.05`, but cannot decrease or bet both sides in the same fight. This repo only demonstrates the math and settlement pieces; production apps must enforce those rules in their API/database layer.

## What Is Private

This example is designed so the sensitive settlement leg can be private:

- Deposits move a bettor's base token balance into a MagicBlock private balance.
- Treasury-to-winner credits happen as private balance transfers.
- Winners withdraw from their private balance when they choose.

Your public app can still show non-sensitive aggregate data such as fight ID, fighters, total pool, side totals, payout status, and winner name.

## Repository Structure

- `src/privatePaymentsClient.js`
  Reusable client for MagicBlock Private Payments API auth, mint initialization, deposit, private transfer, withdraw, TEE RPC submission, and transaction validation helpers.

- `src/bettingMath.js`
  Deterministic PvP betting math with allowed stake tiers and `10/20/70` pro-rata distribution.

- `scripts/reproduce-devnet.js`
  Dry-run simulation by default, plus an opt-in live devnet smoke flow.

- `tests/local-betting-simulation.test.js`
  Unit tests for stake tiers, payout splits, pro-rata distribution, and operational-cost deduction.

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

Run the live devnet smoke flow:

```bash
npm run devnet:live
```

The live command is intentionally devnet-only. It requires `SERVER_PRIVATE_KEY` in `.env`.

## Environment

```bash
SOLANA_NETWORK=devnet
SOLANA_RPC=https://api.devnet.solana.com
SERVER_PRIVATE_KEY=
RECIPIENT_PRIVATE_KEY=
PVP_BETTING_PRIVATE_MINT=So11111111111111111111111111111111111111112
MAGICBLOCK_PAYMENTS_API_URL=https://payments.magicblock.app
MAGICBLOCK_PRIVATE_TEE_URL=https://devnet-tee.magicblock.app
PVP_BETTING_MAGICBLOCK_VALIDATOR_ID=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo
DEMO_DEPOSIT_SOL=0.01
ESTIMATED_MAGICBLOCK_COST_SOL=0
```

Never commit `.env` or production private keys. The live script should be run only with disposable devnet keys.

## Live Devnet Flow

`npm run devnet:live` performs this smoke test:

1. Authenticates against MagicBlock Private Payments / TEE.
2. Verifies the TEE identity.
3. Ensures the private mint is initialized.
4. Wraps enough devnet SOL into wSOL for the demo deposit.
5. Builds and submits a `deposit` transaction from custody base balance to custody private balance.
6. Creates or funds a demo recipient for fees.
7. Initializes the recipient private balance with a small deposit.
8. Builds and submits a private `transfer` from custody private balance to recipient private balance.
9. Builds and submits a `withdraw` from recipient private balance to recipient base balance.

For a browser wallet integration, the server should build unsigned transactions and verify returned signed transactions before submitting them. See `assertUnsignedTransactionSigner`, `verifySignedTransactionMatches`, and `submitSignedTransaction` in `src/privatePaymentsClient.js`.

## Production API Pattern

A production service should usually expose endpoints similar to:

- `POST /fights/:id/bets/prepare`
  Validate fight status, side, wallet eligibility, stake tier, and wallet-side uniqueness. Build unsigned wrap/deposit transactions.

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

## Notes About SOL and wSOL

The Private Payments API works with SPL tokens. This example uses the native wrapped SOL mint:

```text
So11111111111111111111111111111111111111112
```

The UI can present this as SOL, but under the hood users need enough SOL for:

- the stake amount that gets wrapped/deposited as wSOL
- normal Solana transaction fees
- possibly creating an associated token account the first time

## Mainnet

This repository defaults to devnet. Before adapting it to mainnet:

- Confirm the current MagicBlock production endpoints and validator ID with MagicBlock.
- Confirm final API authentication requirements and costs.
- Test with very small amounts first.
- Use isolated custody wallets and strict operational controls.
- Add monitoring and manual freeze/review controls before automatic payout release.

## Previous Report

`docs/last-devnet-report.json` is kept as a historical debugging artifact. The current implementation follows the corrected canonical route described above.
