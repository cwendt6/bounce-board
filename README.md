# Bounce Board

One box bounces around an old classroom projector screen. $1 in USDC puts your name, brand or token in the box. You hold it until the next buyer in the queue takes over. Hit a corner and you join the Corner Club.

**Preview:** https://cwendt6.github.io/bounce-board/ (demo data, no payments yet).

## How it works

- **Same box for everyone.** Position is a pure function of the takeover's start time and seed, on a fixed 4:3 screen. The server only broadcasts takeovers, and every client computes the same path and the same corner hits. See [docs/architecture.md](docs/architecture.md).
- **Fair queue.** First paid, first shown. Each holder gets at least 60 seconds, plus 60 seconds of protection per corner hit.
- **Crypto first.** USDC on Base and Solana via [x402](https://www.x402.org/), so wallets, bots and AI agents can all take the box. Stablecoins only.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # motion, schedule and format tests
npm run lint && npm run typecheck
```

## Roadmap

- [x] 1. Prototype: bouncing box, projector look, sidebars with demo data, deterministic position, preview deploy
- [ ] 2. Payments on testnet (Base Sepolia, Solana devnet) via x402: queue, 60-second hold, corner detection, leaderboards
- [ ] 3. Moderation, token checks, admin panel, terms
- [ ] 4. Mainnet USDC and a public x402 `POST /take` endpoint with docs
- [ ] 5. Launch: domain, analytics, OG image, Base mini app
- [ ] 6. Optional: card payments for non-crypto brands

## Disclaimer

Listings are paid placements, not endorsements, and not financial advice.

## License

MIT
