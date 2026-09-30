# Architecture

## Shared box position

Every viewer must see the box in the same place, and the server must agree on corner hits. So position is a pure function of two values: seconds since the takeover started, and the takeover's seed (`src/core/motion.ts`). The server only broadcasts takeover events. Clients compute the rest.

- **Fixed 4:3 screen.** The spec allowed position to depend on screen aspect. That would put the box in different places on a phone and a laptop, and the server could not know which corner hits count. The screen is a fixed 4:3 "projector" surface instead. Clients scale and letterbox it.
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

- **Flow.** A buyer submits their card. The server returns an x402 payment requirement ($1 USDC on Base Sepolia or Solana devnet). The facilitator verifies and settles, and the server then appends the takeover to the queue. The queue is first paid, first shown. A takeover starts when the current one has held at least 60 seconds, plus 60 seconds of protection per corner hit.
- **Broadcast.** Takeover events go out over SSE or WebSocket: `{id, holder, startMs, seed}`.
- **No keys on the server.** x402 only needs the receiving address. The facilitator settles the payment. The receiving wallet is a fresh address Cole creates, never a personal wallet.
- **Host.** Cloudflare (Cole's account). One Worker serves the built page as static assets and handles `/api/*`. One Durable Object (`worker/board.ts`) holds the queue, the clock, the sales log (SQLite) and every viewer's WebSocket. Handovers run on Durable Object alarms.
- **API.** `GET /api/state` returns a snapshot. `GET /api/live` opens a WebSocket that pushes snapshots and answers `{type: "ping", t0}` with the server time for clock sync. The page keeps the fastest round trip's offset. `POST /api/dev/take` exists only when `DEV_FAKE_PAY=true` (local dev and tests).
- **Page modes.** Served by the Worker, the page runs live. On GitHub Pages there is no `/api`, so it falls back to the demo rotation.

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
