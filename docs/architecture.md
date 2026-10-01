# Architecture

## Shared box position

Every viewer must see the box in the same place, and the server must agree on corner hits. So position is a pure function of two values: seconds since the takeover started, and the takeover's seed (`src/core/motion.ts`). The server only broadcasts takeover events. Clients compute the rest.

- **Fixed 4:3 screen.** The spec allowed position to depend on screen aspect. That would put the box in different places on a phone and a laptop, and the server could not know which corner hits count. The screen is a fixed 4:3 surface instead. Clients scale and letterbox it.
- **Motion.** Each axis moves at constant speed and reflects off the walls (a triangle wave). The seed sets the starting phase and direction.
- **Corner hit.** An x-wall hit where y is within `CORNER_EPS` (0.02 screen units, under 1% of height) of a wall. `cornerHits(phase, from, to)` walks x-wall hits by index. Windows are half-open, so consecutive checks never double count.
- **Rate.** With random seeds, about 6 corner hits per hour. About 40% of 10-minute reigns get one, and about 1 in 10 one-minute reigns. `CORNER_EPS` tunes this.
- **Clock.** Clients use the server's clock offset (milestone 2) so two browsers agree within 100 ms. Milestone 1 uses the local clock and a fixed demo rotation (`src/core/schedule.ts`).

## Milestone 2 plan (payments on testnet)

- **Queue rules.** These live in `src/core/queue.ts` as pure functions. `advance(state, now)` applies every handover that is due. It returns the events to broadcast and the time of the next alarm.
  - A holder keeps the box for at least 60 seconds.
  - A corner hit protects the holder for 60 seconds from the moment of the hit. A corner inside that window extends it again.
  - With nobody queued, the holder keeps the box until the next buyer pays.
- **Facilitator.** Testnet uses the public x402.org facilitator, which supports Base Sepolia and Solana devnet with no account. Mainnet (M4) uses Coinbase's facilitator.
- **Settle before queueing.** The x402 Hono middleware runs the route handler before it settles the payment. So the server calls `verifyPayment` and `settlePayment` itself, and only queues the takeover and writes the sales row after settlement succeeds.

- **Flow.** A buyer submits their card. The server returns an x402 payment requirement ($1 USDC on Base Sepolia; Solana is deferred). The facilitator verifies and settles, and the server then appends the takeover to the queue. The queue is first paid, first shown. A takeover starts when the current one has held at least 60 seconds, plus 60 seconds of protection per corner hit.
- **Broadcast.** Takeover events go out over SSE or WebSocket: `{id, holder, startMs, seed}`.
- **No keys on the server.** x402 only needs the receiving address. The facilitator settles the payment. The receiving wallet is a fresh address Cole creates, never a personal wallet.
- **Host.** Cloudflare (Cole's account). One Worker serves the built page as static assets and handles `/api/*`. One Durable Object (`worker/board.ts`) holds the queue, the clock, the sales log (SQLite) and every viewer's WebSocket. Handovers run on Durable Object alarms.
- **API.** `GET /api/state` returns a snapshot. `GET /api/live` opens a WebSocket that pushes snapshots and answers `{type: "ping", t0}` with the server time for clock sync. The page keeps the fastest round trip's offset. `POST /api/dev/take` exists only when `DEV_FAKE_PAY=true` (local dev and tests).
- **Page modes.** Served by the Worker, the page runs live. On GitHub Pages there is no `/api`, so it falls back to the demo rotation.

## Taking the box (API)

`POST /api/take` with the card as JSON. Bots and agents use it the same way the page does.

1. Without a payment, the answer is `402`. The price is in the `PAYMENT-REQUIRED` header (x402 v2, base64 JSON) and repeated in the body. A bad card gets `400` before any payment is asked for.
2. The client signs an EIP-3009 USDC authorization for exactly that amount and retries with `PAYMENT-SIGNATURE`. The buyer needs USDC only, since the facilitator pays the gas.
3. The server verifies, then settles. After settlement it writes the sale and queues the takeover in one SQLite transaction. The answer is `201` with the tx hash, the snapshot and a `PAYMENT-RESPONSE` header.

If settlement succeeds but queueing fails, the server logs `SETTLED BUT NOT QUEUED <tx>` and answers `500` with the tx hash so the sale can be reconciled. A repeated tx hash is a no-op.

Config: `X402_NETWORK` and `FACILITATOR_URL` are vars in `wrangler.jsonc`. `PAY_TO_ADDRESS` is set outside the repo (`.dev.vars` locally, `wrangler secret put PAY_TO_ADDRESS` in production). `GET /api/admin/sales.csv` needs `Authorization: Bearer <ADMIN_TOKEN>` and returns 404 until `ADMIN_TOKEN` is set.

## Rate limits

Exact fixed-window counters in one SQLite Durable Object (`worker/limiter.ts`, `RateLimiter`). They're the same on any plan, unlike the approximate per-location rate-limit binding.

| Key | Limit | Why |
| --- | --- | --- |
| Take attempts per IP | 20 per 10 min | Each quote runs AI moderation; this protects the free daily budget |
| Paid takeovers per wallet | 10 per hour | Spam control |
| Paid takeovers per listing (holder key) | 3 per hour | Nobody walls off the board with one card |
| Reports per IP | 10 per hour | Report flooding |

IPs are SHA-256 hashed before they're used as keys. Wallet and listing limits are checked after the payment is decoded and before the facilitator is called, so a refused attempt is never charged. Over-limit requests get `429` with `Retry-After`.

## Reports and admin

- **Report:** `POST /api/report {id, category, note}` (category: scam, nsfw, impersonation, hate, other; note up to 200 characters). There's a "Report this listing" button under the screen and a "report" link on each queued card. Reporters are stored only as SHA-256(IP + takeover id), so one person's repeat reports count once and no raw IPs are kept.
- **Admin:** `/admin.html` (unlinked, `noindex`). Paste the admin token; it's kept in sessionStorage for that tab only. It shows the current holder, the queue and reports grouped by listing.
  - `POST /api/admin/kill {reason}` removes the current holder now. The next queued buyer takes over immediately (starting now, not at their earlier payment time). If nobody is queued, the previous holder's card returns as a "restored" reign, which isn't counted in stats.
  - `POST /api/admin/remove {id, reason}` removes a queued (or the current) listing.
  - Removed listings are kept, with their reason, for the record, but drop off the recent list, leaderboards and stats.
- **Auth:** every `/api/admin/*` route needs `Authorization: Bearer <ADMIN_TOKEN>` and returns 404 until the token is set.

## Link checks

- **Card link** (`worker/links.ts`): blocked if the domain or any parent domain is on MetaMask's open-source phishing list (eth-phishing-detect, about 100k domains) and not whitelisted. It is also blocked if it's a one-edit look-alike of a protected brand from that list's fuzzy list (for example `metamsk.io`), a bare IP address, or a punycode (`xn--`) look-alike.
- **Descriptions:** may not contain links or domains at all, so no wallet-connect links. The link field is the only place for a URL.
- **Storage:** the list lives in its own Durable Object (`PhishingListStore`, SQLite) so a refresh (about 2 s) never stalls the board. A daily cron refreshes it, and it loads on first use. A refresh that looks wrong (fewer than 1,000 domains) keeps the old copy. If the list can't load, only the cheap rules apply.
- **Plan check:** probed on Cole's account on 2026-10-01. Durable Object alarms fire on the current plan (3,001 ms for a 3 s alarm), and a Durable Object loaded the full list in one request.

## Token checks

Cards that list a token (ticker, chain, contract) are checked against DexScreener's public API before moderation and before the price quote (`worker/tokens.ts`):

1. The ticker must match the token actually at that contract. The address may be on either side of a pair.
2. The token's pools must hold at least $1,000 of liquidity in total.
3. No much bigger token with that ticker may live at a different address on the same chain: at least $100k of liquidity and 10x the submitted token's. This is the fake-CA check. Tickers repeat across chains legitimately, so other chains are never compared.

- **Failures:** each one is rejected with a plain reason.
- **DexScreener unreachable:** the card is allowed and shown with an orange "unverified" badge. The result is set by the server only.
- **Caching:** results are cached for 10 minutes in the Durable Object. The API allows 60 requests a minute.
- **Fixtures:** response shapes are pinned by fixtures in `worker/fixtures/` (trimmed real responses for USDC and DEGEN). `TOKEN_CHECKS=off` exists only for tests and offline dev.

## Moderation

- **When:** every card and logo is checked before a price is quoted (`POST /api/take` and the dev endpoint), so nobody pays for a takeover that would be rejected.
- **Text:** Llama Guard 3 (`@cf/meta/llama-guard-3-8b`) classifies the card into the MLCommons hazard categories (S1-S14). Any hazard rejects it, with the category named.
- **Logo:** Mistral Small 3.1 (`@cf/mistralai/mistral-small-3.1-24b-instruct`) is asked for a one-word SAFE/UNSAFE answer covering nudity, gore, hate symbols, extremism and drugs.
- **Fails closed:** a quota error, an outage or an unexpected answer returns 503 ("try again later, you have not been charged").
- **Cache:** definitive verdicts are cached for 24 hours in the Durable Object by a SHA-256 of the card and logo, so the paid retry of the same card doesn't re-run the models. "Unavailable" is never cached.
- **Cost:** Workers AI free plan, 10,000 neurons a day; past that, calls error rather than bill. About 45 neurons per submission (Llama Guard about 30, vision about 15), so about 200 submissions a day.
- `MODERATION=off` exists only for tests and offline dev. Deployed environments use `workers-ai`.

## Logos

- **In the browser** (`src/logo-input.ts`): the buyer picks a PNG, JPG or WebP up to 500 KB. The page center-crops it to a square and re-encodes it to a 256x256 WebP on a canvas, which drops metadata and anything riding along in the file.
- **On the server** (`worker/logo.ts`): it trusts nothing from the page. It checks the declared type against the magic bytes and enforces the 500 KB cap. SVG is never accepted, because SVGs can carry scripts.
- **Storage:** the logo is stored in the Durable Object's SQLite in the same transaction as the takeover (and the sale). The card's `logo` field is always set by the server (`/api/logo/<takeover id>`), never taken from buyer input.
- **Serving:** `GET /api/logo/:id` returns the exact content type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and an immutable cache header.
- Image moderation comes in M3.

## Sales log (bookkeeping)

Every settled payment is one row, written in the same transaction that queues the takeover. The table and its CSV export use the same columns, so btc-mining-ledger can import it as business income for CT Wendt Holdings LLC.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text | Sale id |
| `takeover_id` | text | The takeover it paid for |
| `network` | text | `mainnet` or `testnet`. Testnet rows are never income |
| `chain` | text | `base` or `solana` |
| `asset` | text | `USDC` |
| `amount` | decimal(18,6) | USDC received, 6 decimals |
| `usd_value` | decimal(18,2) | Fair value at receipt (USDC at $1.00, recorded, not assumed) |
| `tx_hash` | text | Settlement transaction |
| `payer` | text | Payer address |
| `receiver` | text | Receiving address |
| `received_at` | timestamp (UTC) | Settlement time |
| `facilitator` | text | For example `cdp` |

## Security basics

- Buyer text is rendered with `textContent`, never `innerHTML`.
- No SVG uploads (milestone 2+), links are https only, and the image size is capped.
- Secrets live in env vars on the host, never in the repo. gitleaks runs in CI.
