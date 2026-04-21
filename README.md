# MagicBlock Private Payments Reproducer

This repository is a minimal, standalone reproduction of the private PvP betting flow we are building for an MMORPG on Solana.

The real product flow is:

1. Two fighters accept a scheduled PvP match inside the game.
2. Betting opens publicly.
3. Bettors fund the wager privately using `wSOL` under the hood while the UI still presents the product as `SOL`.
4. After the match result is known, the 10% game fee goes to the game wallet and the other 90% is distributed proportionally to the winning bettors.
5. We want both the wager intake and the payout movement to remain private at the fund-movement layer.

This repository does **not** include the game. It only includes the smallest code needed to demonstrate the private payments behavior we need from MagicBlock.

## What This Reproducer Shows

The current status from our devnet tests is:

- `initialize-mint` works
- TEE auth token retrieval works
- `base -> ephemeral` private intake works
- payout math works
- the payout transaction can be built by the Private Payments API
- but the treasury-side payout submission fails during the `sendTo=ephemeral` step

The failure we are trying to isolate is the payout path:

- expected path: `ephemeral -> base` private payout from treasury/custody wallet to the winner wallet
- current live error in devnet: `ephemeral_transaction_failed:"InvalidWritableAccount"`

## Repository Contents

- `src/privatePaymentsClient.js`
  Minimal client for:
  - TEE auth token retrieval
  - mint initialization
  - `base -> ephemeral` transfer build and submission
  - `ephemeral -> base` payout build and submission
- `src/bettingMath.js`
  Simple proportional payout math for a PvP betting pool
- `tests/local-betting-simulation.test.js`
  Local deterministic simulation of the betting split
- `scripts/reproduce-devnet.js`
  End-to-end devnet reproducer

## Install

```bash
npm install
cp .env.example .env
```

Fill at least:

- `SERVER_PRIVATE_KEY`
- optionally `PAYOUT_RECIPIENT`

## Commands

Run the local deterministic betting simulation:

```bash
npm test
```

Run the real devnet reproduction against MagicBlock:

```bash
npm run test:devnet
```

A sample successful reproduction report is stored in [docs/last-devnet-report.json](./docs/last-devnet-report.json).

## Expected Devnet Behavior

When `npm run test:devnet` runs successfully as a reproducer, you should see:

1. TEE identity matches the configured validator
2. mint is initialized or initialization succeeds
3. the script ensures the signer has enough base `wSOL`
4. a private `base -> ephemeral` intake transaction succeeds
5. payout math is computed
6. a private `ephemeral -> base` payout transaction is built
7. the final payout submission fails with the current issue

The script intentionally treats the payout failure as the expected reproduction target and prints a JSON report.

## Why This Matters

Our product requirement is not just private intake. We need **private payout** from the custody/treasury wallet after the match result is finalized.

The intake side already demonstrates that the private betting concept is viable:

- bettor funds move into a private balance
- public observers do not need to see which fighter that wallet backed

But the product is incomplete unless the treasury can also distribute winnings privately.

## What We Think Is Happening

The reproduction indicates that:

- the Private Payments API can build the payout transaction
- the TEE auth flow works
- the TEE validator identity matches what we expect
- but submission of the payout transaction fails with `InvalidWritableAccount`

This suggests either:

- a route-specific constraint for treasury-side private payouts
- an account preparation step we are missing for the payout route
- a required queue / vault / permission setup not needed for the intake path
- or a mismatch between the built transaction and the required TEE writable-account blockhash derivation for this route

## What We Need Help Confirming

We would appreciate guidance on the correct production/devnet flow for this specific requirement:

- bettor funds enter privately via `base -> ephemeral`
- treasury/custody wallet holds the private pool
- treasury later pays winners privately via `ephemeral -> base`

Questions:

1. Is `ephemeral -> base` from the treasury wallet the correct payout route for this use case?
2. If yes, what extra setup is required before submission?
3. If no, what is the correct private payout route for a custody wallet distributing winnings?
4. Are we missing a queue, permission, delegated ATA, vault ATA, merge, or shuttle step for payout?

## Environment Used In The Reproduction

- Solana cluster: `devnet`
- Private settlement asset: `wSOL`
- Payments API: `https://payments.magicblock.app`
- TEE RPC: `https://devnet-tee.magicblock.app`
- Validator: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`

## Notes

- Everything in this repository is written in English to make it easy to share directly with the MagicBlock team.
- The goal is reproducibility, not app completeness.
