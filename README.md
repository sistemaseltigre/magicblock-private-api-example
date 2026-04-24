# MagicBlock Private Payments PvP Betting Example

This repository is a minimal, standalone example of the private PvP betting flow we are building for an MMORPG on Solana.

The real product flow is:

1. Two fighters accept a scheduled PvP match inside the game.
2. Betting opens publicly.
3. Bettors fund the wager privately using `wSOL` under the hood while the UI still presents the product as `SOL`.
4. After the match result is known, the 10% game fee goes to the game wallet and the other 90% is distributed proportionally to winning bettors.
5. We want both the wager intake and the payout movement to avoid publicly revealing who backed which fighter.

This repository does **not** include the game. It only includes the smallest code needed to demonstrate the private payments behavior.

## Current Flow

After MagicBlock reviewed the first repro, we changed the example to use the canonical routes:

- intake: `POST /v1/spl/deposit`
- private payout: `POST /v1/spl/transfer` as `ephemeral -> ephemeral`
- recipient exit: `POST /v1/spl/withdraw`

This matches the guidance that direct treasury `ephemeral -> base` payout to an external recipient is not the correct route. The recipient must first have a private balance account, receive the private transfer, and then withdraw with their own wallet.

## Repository Contents

- `src/privatePaymentsClient.js`
  Minimal client for TEE auth, mint initialization, deposit, private transfer, and withdraw.
- `src/bettingMath.js`
  Simple proportional payout math for a PvP betting pool.
- `tests/local-betting-simulation.test.js`
  Local deterministic simulation of the betting split.
- `scripts/reproduce-devnet.js`
  End-to-end devnet flow using the corrected route.

## Install

```bash
npm install
cp .env.example .env
```

Fill at least:

- `SERVER_PRIVATE_KEY`

Optional:

- `RECIPIENT_PRIVATE_KEY`

If `RECIPIENT_PRIVATE_KEY` is not provided, the devnet script generates a temporary recipient keypair and funds it from `SERVER_PRIVATE_KEY` for fees and initialization.

## Commands

Run the local deterministic betting simulation:

```bash
npm test
```

Run the real devnet flow against MagicBlock:

```bash
npm run test:devnet
```

A previous report from the older failing route is stored in [docs/last-devnet-report.json](./docs/last-devnet-report.json). New reports should show `canonical_flow_succeeded` if the corrected flow succeeds.

## Expected Devnet Behavior

When `npm run test:devnet` succeeds, it should:

1. Verify TEE identity.
2. Ensure the private mint is initialized.
3. Ensure the custody wallet has base `wSOL`.
4. Deposit custody funds from base balance into private balance.
5. Fund and initialize a recipient private balance.
6. Compute PvP betting payouts.
7. Transfer the winner payout privately from custody to recipient as `ephemeral -> ephemeral`.
8. Withdraw from the recipient private balance back to base balance with the recipient signer.

## Environment Used

- Solana cluster: `devnet`
- Private settlement asset: `wSOL`
- Payments API: `https://payments.magicblock.app`
- TEE RPC: `https://devnet-tee.magicblock.app`
- Validator: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`

## Product Implication

For the game implementation, this means automatic final payout directly from treasury private balance to a winner's public base balance is not the right model.

The implementable model is:

1. The treasury sends private winnings to each winner's private balance.
2. Each winner withdraws to base balance with their own wallet.
3. The game can still automate pool math, payout queueing, winner notification, and construction of the unsigned withdraw transaction.

