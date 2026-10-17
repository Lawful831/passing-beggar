# Passing Beggar

A public HTTP 402 endpoint that asks passing AI agents for one dollar, on Base, in USDC. Paying is
optional by design, the ledger is public, and refusals are public too.

Live: <https://passing-beggar.94.72.112.144.sslip.io>

## What is here

| path | what |
|---|---|
| `server.mjs` | the whole service: express, `@x402/express` v2, hand-rolled 402 challenge, public ledgers |
| `public/` | the machine-facing surface (`agents.md`, `llms.txt`, `openapi.json`, `/.well-known/x402`, `agent-card.json`) and the human page |
| `answer.mjs` | list/answer/refuse queued tasks, publicly |
| `test-client.mjs`, `probe-facilitator.mjs` | the two probes that prove the payment wire format without spending anything |

`data/` (the ledgers), `bin/` (its own node) and the systemd unit are not in this repo. The payout
address is receive-only and its key has never touched the service.

## The endpoints

- `GET /api/beg` 1.00 USDC, `GET /api/beg/cent` 0.01, `GET /api/beg/dime` 0.10: a receipt and a
  public thank you. The cent tier exists because a dollar sits above the per-call cap a lot of agent
  wallets enforce.
- `POST /api/task` 1.00 USDC: a small piece of work from a human, queued and answered in public at
  `/api/tasks`.
- `GET /api/x402-check?url=...` free, 3/day per IP: parses and sanity-checks an x402 challenge before
  you sign it. `GET /api/x402-deep-check?url=...` 0.01 USDC: the same, plus the target's
  `/.well-known/x402` and its facilitator's `/supported`.
- `GET /api/stats` the ledger, `GET /api/whoami` what the server thinks you are.

## The numbers, as of 2026-10-17

- ~209 logged requests, of which **40 are this machine** and **165 carry a collapsed proxy address**
  that cannot be attributed to anyone (see the bug below).
- 4 strangers in the clean window since the fix: three third-party uptime probes and a browser.
- Pre-fix, by user agent, the visitors were: x402dash's verifier (`python-httpx`), Blue Hub's liveness
  probe (`node`, three hits on `POST /api/task`), a Telegram link preview, `axios`, `Wget`, a WordPress
  vulnerability scanner, and a phishing-kit scanner fetching `/js/twint_ch.js`, `/js/raif_ch.js`.
- **Paid requests: 0. Dollars received: 0. Tasks queued: 0.** The only payment-signed request in the
  log is my own test client with an unfunded wallet, which the facilitator answered `insufficient_funds`.

## The bug I shipped, because it is the interesting part

`app.set('trust proxy', false)` was wrong. Behind Traefik that makes `req.ip` the proxy's own address,
so **every HTTPS visitor collapsed into a single hashed IP**. I then built a "exclude our own traffic"
filter keyed on that hash, and the result was a ledger that confidently reported no strangers had ever
arrived while real clients were in the table.

The fix is one line (`trust proxy` set to the private ranges, since the listener is bound to the Docker
gateway only), plus three related repairs: the rate limiter keyed on the same address, so all HTTPS
clients shared one 120/min bucket; ledger writes happened inside the handler while settlement runs
after it, so a failed settlement would still have recorded a dollar; and `payer` read a header nothing
sets. Old rows cannot be re-attributed, so they are reported as their own `legacy_visits` bucket instead
of being quietly counted or quietly hidden.

## Run it

```
npm i
PORT=4021 HOST=10.0.0.1 PAY_TO=0x... node server.mjs
```

Environment: `PRICE`, `NETWORK` (`eip155:8453`), `PAY_TO`, `PORT`, `HOST`, `PUBLIC_URL`, `RPC`,
`FACILITATOR`, `POLL_MS`, `DEBUG_FACILITATOR=1`, `SELF_IPS`, `SELF_IP_HASHES`, `SELF_UA_RE`.

Facilitators that need no key and are live on Base mainnet: `https://facilitator.xpay.sh`,
`https://facilitator.settlegrid.ai` (`/v1/*`), `https://facilitator.arispay.app`.

TLS comes free if a reverse proxy with a Let's Encrypt resolver already owns 80/443; a hostname like
`<name>.<ip>.sslip.io` resolves back to the box, so the HTTP-01 challenge lands without owning a domain.

## What I would tell the next person

1. Fix attribution before you fix anything else. My first day of "nobody came" was a measurement bug.
2. Price below the caller's cap. A cent is buyable by more agents than a dollar is.
3. Discovery is the bottleneck, not the price. Six listings is not a distribution channel.
4. A receipt is not a product. The products here that make sense are the trust check and a human answer.
5. Refusals in public keep the promise honest, and the promise is the only brand a beggar has.

MIT.
