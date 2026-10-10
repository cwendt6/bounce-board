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

1. **Quote.** Without a payment, the answer is `402`. The price is in the `PAYMENT-REQUIRED` header (x402 v2, base64 JSON) and repeated in the body. Only cheap checks run first: card and logo validation and the link check. A bad card gets `400`. An unpaid quote never spends AI or DexScreener calls, so quotes can't be used to burn those budgets.
2. **Sign.** The client signs an EIP-3009 USDC authorization for exactly that amount and retries with `PAYMENT-SIGNATURE`. The buyer needs USDC only, since the facilitator pays the gas.
3. **Verify, check, settle.** The server runs these steps in order:
   - Verify the payment with the facilitator. This is free and moves no money.
   - Use the facilitator's verified payer (which covers EIP-3009 and Permit2) for the self-payment check and the wallet and listing rate limits.
   - Refuse with "sign again" if the signature has less than 30 seconds left, or has no deadline at all. So an expiring signature can't buy a free AI run. The deadline is read the way the facilitator reads the payload: Permit2 `deadline` if a Permit2 authorization is present, otherwise EIP-3009 `validBefore`. A payload with both is refused.
   - Peek at the wallet and listing limits without counting them.
   - Run the token checks (8 s timeout) and moderation (20 s timeout).
   - Refuse with "sign again" if the signature now has less than 15 seconds left.
   - Count the limits.
   - Claim the authorization (payer plus EIP-3009 or Permit2 nonce) in the limiter Durable Object until it expires. A replay of the same signed payment in another request never reaches settle; it gets `202` "do not pay again".
   - Only then settle. If the result proves no money moved, the limits are given back.

   Any refusal before settlement says "You have not been charged". After settlement the server writes the sale and queues the takeover in one SQLite transaction. The answer is `201` with the tx hash, the snapshot and a `PAYMENT-RESPONSE` header. Each facilitator call times out after 30 s.

Only one settle result proves no money moved: a refusal from a check that runs before anything is broadcast (signature, amount, recipient, time window, balance, simulation; see `PRE_BROADCAST_REASONS`), with no transaction, returned or thrown as a 4xx, and no earlier attempt in the same call that saw a broadcast. The library quietly retries a pending settle once and returns only the second result, so the facilitator client is wrapped (`WatchedFacilitator`) to record every attempt. Only that case answers `402` "not charged" and gives the limits back. Everything else may have moved money: `settlement_pending`, "transaction failed" (the facilitator's catch-all, which also covers a broadcast that errored but may still mine), "nonce already used", timeouts, 5xx or network errors, a receipt that doesn't match, "success" with no tx, and any reason we don't know. Then the server never says "try again". It logs `SETTLE OUTCOME UNKNOWN <tx> payer <address>`, keeps the limits counted, and answers `202` telling the buyer not to pay again and to check their wallet. After signing, the page keeps the pay button off on a `202`, on any 5xx except our own "not charged" 503s, on a dropped connection, and on a `201` whose body didn't arrive. The warning stays on screen until the page is reloaded. Workers Logs keeps these lines for a few days (invocation logs are off, so request headers are never stored). They are reconciled by hand for now; an automatic sweeper that checks the chain is planned for mainnet (M4).

If settlement succeeds but queueing fails, the server logs `SETTLED BUT NOT QUEUED <tx>` and answers `500` with the tx hash and "Your payment went through, but your card was not queued. Do not pay again", so the sale can be reconciled. A repeated tx hash is a no-op.

Config: `X402_NETWORK` and `FACILITATOR_URL` are vars in `wrangler.jsonc`. `PAY_TO_ADDRESS` is set outside the repo (`.dev.vars` locally, `wrangler secret put PAY_TO_ADDRESS` in production). `GET /api/admin/sales.csv` needs `Authorization: Bearer <ADMIN_TOKEN>` and returns 404 until `ADMIN_TOKEN` is set.

## Free-plan write budget

On the Workers Free plan, Durable Objects allow **100,000 SQLite rows written per day**, account-wide. Deletes count, and so do index entries, so a row in a table with a TEXT primary key costs 2. Past the limit, writes fail until 00:00 UTC.

- **Rule for new features:** never write one row per item for large lists. Store blobs and use integer primary keys where possible.
- **Per paid takeover:** roughly 15 to 20 rows (takeover, sale, logo, status updates, verdict and token-check caches, rate-limit counters, the authorization claim). That's several thousand takeovers a day.
- **Incident, 2026-10-01:** a throwaway probe Worker inserted 101,548 rows in one request and exhausted the day's quota. The first version of the phishing store would have done the same on every daily refresh. It was fixed before deploying.

## Rate limits

Exact fixed-window counters in one SQLite Durable Object (`worker/limiter.ts`, `RateLimiter`). They're the same on any plan, unlike the approximate per-location rate-limit binding.

| Key | Limit | Why |
| --- | --- | --- |
| Take attempts per IP (IPv6 by /64) | 20 per 10 min | Quote and payment spam |
| Uncached AI moderation runs, account-wide | 180 per day (`AI_DAILY_CAP`) | Keeps Workers AI inside the free 10,000 neurons; past it, moderation is "unavailable" and nobody is charged |
| Uncached AI moderation runs per verified payer | 5 per day | Stops one funded wallet from draining the shared AI budget with verified-but-never-settled attempts |
| Uncached AI moderation runs per IP bucket (IPv6 by /48) | 10 per day | Same, across wallets from one place. Coarser for IPv6 because a VPS gets thousands of /64s |
| Paid takeovers per wallet | 10 per hour | Spam control |
| Paid takeovers per listing (holder key) | 3 per hour | Nobody walls off the board with one card |
| Reports per IP | 10 per hour | Report flooding |

IPs are SHA-256 hashed before they're used as keys. IPv6 addresses are grouped by /64 (by /48 for the AI quota), because one client usually controls a whole /64. Wallet and listing limits use the facilitator-verified payer. They're peeked at before the slow checks and only counted right before settle, so forged headers and refused attempts (fake token, flagged content, outages, a signature about to expire) can't burn anyone's quota, and a refused attempt is never charged. A settlement that provably moved no money gives the count back, so replaying one signature many times at once mostly can't block a listing either. The AI quotas and the global cap are counted together, all or nothing, on each uncached moderation run. Over-limit requests get `429` with `Retry-After`. Request bodies are capped before parsing (about 900 KB for takes, 4 KB for reports and admin calls).

## Reports and admin

- **Report:** `POST /api/report {id, category, note}` (category: scam, nsfw, impersonation, hate, other; note up to 200 characters). There's a "Report this listing" button under the screen and a "report" link on each queued card. Reporters are stored only as SHA-256(IP + takeover id), so one person's repeat reports count once and no raw IPs are kept.
- **Admin:** `/admin.html` (unlinked, `noindex`). Paste the admin token; it's kept in sessionStorage for that tab only. It shows the current holder, the queue and reports grouped by listing.
  - `POST /api/admin/kill {id, reason}` removes the current holder now. `id` must be the current holder's id (from `/api/state`). If the board has moved on, the answer is `409` and nothing changes. The next queued buyer takes over immediately (starting now, not at their earlier payment time). If nobody is queued, the previous genuine holder's card returns as a "restored" reign, which isn't counted in stats. Killing a restored reign also removes the reign it came from, so the same content can't come back.
  - `POST /api/admin/remove {id, reason}` removes a queued (or the current) listing.
  - Removed listings are kept, with their reason, for the record, but drop off the recent list, leaderboards and stats.
- **Auth:** every `/api/admin/*` route needs `Authorization: Bearer <ADMIN_TOKEN>` and returns 404 until the token is set.

## Link checks

- **Shared hosting:** hosts like `pages.dev`, `vercel.app`, `github.io`, `up.railway.app` and `eth.limo`, plus common country suffixes like `co.uk` (see `HOSTING_SUFFIXES`), count as public suffixes, so for `metamask.pages.dev` the attacker-controlled label is the one compared. It's a hand-picked list, not the full Public Suffix List.
- **Card link** (`worker/links.ts`): blocked if the domain or any parent domain is on MetaMask's open-source phishing list (eth-phishing-detect, about 100k domains) and not whitelisted. It is also blocked if it's a look-alike of a protected brand from that list's fuzzy list, a bare IP address, a single-label host (`localhost.`), or a punycode (`xn--`) look-alike.
- **Look-alikes:** the registrable label may be at most one edit from a brand label (`metamsk.io`), or exactly equal for short brand labels like `dydx`. The list's tolerance is capped at 1 because we compare one label, not the whole name. On shared hosting, a subdomain label may not be the brand exactly either (`metamask.evil.workers.dev`). Other domains' subdomains belong to their owners, so `ethereum.stackexchange.com` is fine. A few official alternate domains are allowed (`OFFICIAL_ALTERNATES`).
- **Descriptions:** may not contain links or domains at all, so no wallet-connect links. The link field is the only place for a URL.
- **Storage:** the list lives in its own Durable Object (`PhishingListStore`) as a few large text chunks plus one JSON info row. Lookups use an in-memory Set built from the chunks. A refresh writes about 5 rows, and nothing when the content hash is unchanged. A daily cron refreshes it, and it loads on first use. A refresh that looks wrong (fewer than 1,000 domains) keeps the old copy. If the list can't load, only the cheap rules apply.
- **Plan check:** probed on Cole's account on 2026-10-01. Durable Object alarms fire on the current plan (3,001 ms for a 3 s alarm), and a Durable Object loaded the full list in one request.

## Token checks

Cards that list a token (ticker, chain, contract) are checked against DexScreener's public API after the payment signature is verified and before moderation (`worker/tokens.ts`):

1. The ticker must match the token actually at that contract. The address may be on either side of a pair.
2. The token's pools must hold at least $1,000 of liquidity in total.
3. No much bigger token with that ticker may live at a different address on the same chain: at least $100k of liquidity and 10x the submitted token's. This is the fake-CA check. Tickers repeat across chains legitimately, so other chains are never compared.

- **Failures:** each one is rejected with a plain reason.
- **DexScreener unreachable:** the card is refused with "try again, you have not been charged". It fails closed, not open, because an attacker can provoke outages (for example by exhausting the shared rate limit) to slip a fake contract address through. This changes the spec's original "show unverified".
- **Caching:** results are cached for 10 minutes in the Durable Object. The API allows 60 requests a minute.
- **Fixtures:** response shapes are pinned by fixtures in `worker/fixtures/` (trimmed real responses for USDC and DEGEN). `TOKEN_CHECKS=off` exists only for tests and offline dev.

## Moderation

- **When:** after the payment is verified and before it settles, so nobody pays for a takeover that would be rejected, and an unpaid quote can't spend the AI budget.
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
- **Serving:** `GET /api/logo/:id` returns the exact content type, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`. It uses a 5-minute cache (`public, max-age=300`) plus the edge cache on the custom domain. When the admin removes a listing, its logo is deleted.
- **Size:** the server reads pixel dimensions from the header (PNG IHDR, JPEG SOFn, WebP VP8, VP8L and VP8X) and refuses anything over 512x512. A JPEG must have exactly one frame header before its image data, because browsers disagree on which of several to use. Huge canvases could crash viewers' browsers. Chrome's canvas encoder writes VP8X WebP, which is covered by real-image fixtures in `worker/fixtures/canvas-images.json`.
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
