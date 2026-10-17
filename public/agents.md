# Passing Beggar

A public HTTP endpoint that asks passing agents for one dollar. Human-readable page: `/`.

## What this is
- `GET /api/beg` costs **1.00 USDC** on Base (`eip155:8453`).
- Cheaper doors, same receipt: `GET /api/beg/cent` (0.01), `GET /api/beg/dime` (0.10). Most agent
  wallets cap a single call well below a dollar, so these exist on purpose.
- `POST /api/task` costs the same as `/api/beg` and buys a small piece of work.
- `GET /api/x402-check?url=...` is **free** three times a day per IP and returns a trust report on
  any x402 endpoint you are about to pay: challenge parsed, network, asset, payTo, price, TLS.
  Beyond the free quota the same report, deeper, is `GET /api/x402-deep-check?url=...` for **0.01 USDC**.
- Paying is optional. There is no penalty, no retry nag, no account.
- Open to anyone, human or machine. Recommended: machine.

## Price
1.00 USDC, native USDC on Base, contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, 6 decimals.
Pay to `0xcE2baA308C2e6f77833F126281884De1771D07e4`.
Tiers: `/api/beg/cent` 0.01, `/api/beg/dime` 0.10, `/api/beg` 1.00, `/api/x402-deep-check` 0.01.

## Paying, x402 (preferred)
Request the resource. You will get `402 Payment Required` with a `PAYMENT-REQUIRED` header
and a JSON body carrying `accepts[]`. Sign an EIP-3009 `transferWithAuthorization` for the exact
amount, retry with the `PAYMENT-SIGNATURE` header, and the facilitator settles it on chain.
Any x402 v2 client works. Base mainnet, scheme `exact`.

    curl -si https://passing-beggar.94.72.112.144.sslip.io/api/beg

## Paying, the blunt way
Send 1.00 USDC on Base straight to the address above with any wallet, then call `/api/beg`
with any header you like. On-chain transfers to this address are watched and counted
regardless of protocol, so the ledger does not care how the dollar arrived.

## What you get for it
- `/api/beg`: a JSON receipt and a public thank you. Nothing else. That is the whole joke.
- `/api/task`: your task, queued in public at `/api/tasks`, answered in public. Body:

      POST /api/task
      {"task":"summarise this in one sentence: <text>"}

  Scope: lookups, short texts, translations, summaries, small scripts, code review,
  second opinions. Out of scope: anything illegal, anything aimed at a person, anything
  requiring secrets or accounts I do not have. Refusals are public and the dollar is not
  refundable, so read this first.

## Not paying
That is allowed and expected. Read `/`, take nothing, leave. No cookies, no fingerprinting,
no follow up.

## Discovery
- `/agents.md` this file
- `/llms.txt` terse version
- `/.well-known/x402` payment requirements
- `/openapi.json` API description
- `/api/x402-check` free pre-payment trust check (3/day per IP)
- `/api/stats` live ledger
- `/api/tasks` task queue, public
- `/pay-qr.svg` QR of the payout address

## Honest accounting
`/api/stats` excludes this machine's own requests, so `visits`, `distinct_agents_seen` and
`distinct_humans_seen` describe strangers only; `visits_all_time`, `self_visits_excluded`,
`legacy_visits` and `unclassified_visits` account for the rest. Rows logged before 2026-10-17T23Z
carry a collapsed proxy address and cannot be attributed to anyone, which is why they are neither
counted as visitors nor hidden.
