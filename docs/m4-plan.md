# Bounce Board M4 plan: mainnet USDC on Base (revised)

Status: draft for Cole's review, 2026-10-10. Issue: #4. Written after M3 and revised after a skeptical review.

Nothing in this plan moves real money until Cole says OK. The first real payment is Cole's own $1 smoke test (C3).

Markers:

- **[OWNER OK]**: Claude stops and waits for Cole's explicit yes in chat.
- **[OWNER DOES]**: Cole does this himself. Claude never sees wallet keys, recovery phrases, CDP keys or real funds.
- **[SPEND]**: costs real money.
- **[CHECK]**: the plan relies on a fact that is not verified yet. The named step tests it. If the test fails, stop and replan.

## 0. What changed from the first draft

- **Settle outcomes.** The installed @x402/core 2.28.0 can return `success: false` with `errorReason: "settlement_pending"` and a broadcast tx hash. It also throws on HTTP errors. Since the M3 hardening (#24), those cases answer `202` "do not pay again" and log `SETTLE OUTCOME UNKNOWN`, but they are still resolved by hand. M4 adds a pending row and a sweeper, so once settle is called, any result other than success counts as "unknown" until the chain says otherwise.
- **Sweeper.** It resolves unknown payments from the chain every 10 minutes, without waiting for a Claude session.
- **Where settle runs.** Settle and the sale write run inside the Board Durable Object. That keeps them out of the Worker's 10 ms CPU limit.
- **Pause switch.** A stored pause switch in the Board means a deploy, rollback or dashboard edit cannot reopen payments.
- **Deploys.** Production deploys go only through a guarded script.
- **Address checks.** Reconcile compares against a private expected address. Full-address checks replace last-4 checks.
- **Quotas.** The AI caps now add up to less than 10,000 neurons, and unpaid quotes add no DO writes.
- **Public testnet.** It stays on x402.org by default, so it cannot use up CDP's free tier.
- **CDP project.** It is dedicated and holds no wallets. Cole's rotated key is checked before it is reused.
- **Also new:** sanctions screening, refund and sweep records, email alerts, a refund drill and account hardening.

## 1. Goals

1. Real $1 USDC takeovers on Base mainnet at bouncebox.xyz, settled through Coinbase's CDP facilitator.
2. Testnet keeps working at testnet.bouncebox.xyz (Base Sepolia) for Cole's tests and for bot builders.
3. Every mainnet sale is one row in a mainnet-only sales table and CSV. Refunds and sweeps are recorded too. The books tie out to on-chain transfers in and out of the LLC wallet.
4. Bots and agents can pay through a documented `POST /api/take`.
5. Every buyer, human or bot, accepts the current terms before paying.
6. No wallet keys on Cloudflare. The Worker holds the receiving address and a CDP API key from a CDP project that has no wallets.
7. A payment with an unknown outcome is found and resolved automatically within about 15 minutes.
8. Only Cole's explicit OK can reopen payments after a pause.

Not in M4:

- Solana.
- Card payments (M6).
- Launch marketing, analytics and the Base mini app (M5).
- An x402 Bazaar listing.
- Automatic sweeps. They would need a wallet key on a server, so never.

## 2. Safety rules (every step)

1. **Effective payments mode** is the stricter of the `PAYMENTS` var and the stored switch in the Board. In production, a missing switch counts as paused. A deploy or rollback can only make the mode stricter. Lifting the stored switch takes an admin call, and Claude makes that call only with Cole's OK.
2. **After settle is called**, the server never says "You have not been charged" or "try again" unless the chain shows two things: the authorization is unused, and its `validBefore` has passed.
3. **Production deploys** run only through `npm run deploy:prod` (PR1).
4. **Keys.** Claude never creates, sees or stores any CDP key, or a key for a wallet that holds or will hold funds. The one exception is D5: a zero-balance key made in memory inside a test and never written to disk.
5. **Deletes.** Claude deletes a Worker, Durable Object, secret or CDP item only when Cole names that exact item. `wrangler delete` always gets an explicit `--name`.
6. **Not tax or legal advice** wherever money, tax or terms come up.

## 3. Entry criteria (from M3)

- M3 is merged and deployed on bouncebox.xyz: terms, privacy and the "paid placement" label.
- Coinbase Wallet signs a Base Sepolia payment on bouncebox.xyz with no "unsafe" warning. If it does not, the M4 build goes on, but cutover (C1) waits for Blockaid.
  - 2026-10-13: Cole's test on bouncebox.xyz worked (signature screen, settled, card up, sale row recorded), but the "This site may be unsafe" warning still shows. Cole files the Blockaid report (P6). Cutover waits for it.
- bounce-alarm-probe is deleted (done, 2026-10-10).
- The old leaked CDP key is gone from the CDP portal. P4 decides whether the rotated key is reused.
- P10 (account security) is done.

## 4. Target setup

| | Staging (testnet) | Production (mainnet) |
| --- | --- | --- |
| Wrangler config | top level | `env.production` |
| Deploy command | `npm run build && npx wrangler deploy` | `npm run deploy:prod` only |
| Worker | bounce-board (existing) | bounce-board-production (new) |
| Hosts | testnet.bouncebox.xyz (plus bouncebox.xyz and www until cutover) | bouncebox.xyz and www (after cutover) |
| Network | Base Sepolia, eip155:84532 | Base, eip155:8453 |
| USDC | 0x036CbD53842c5426634e7929541eC2318f3dCF7e | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (native, never USDbC) |
| Facilitator | x402.org for public use. CDP during the S phase and before each payment-code release (decision 2) | CDP only |
| Storage | its own Durable Objects, testnet history kept | new, empty Durable Objects |
| Sales CSV | testnet rows only | mainnet rows only |
| PAY_TO_ADDRESS | existing testnet address | the new LLC wallet |
| CDP key | bounce-board-staging | bounce-board-production, in a CDP project with no wallets |
| ADMIN_TOKEN | existing | new, different |
| AI_DAILY_CAP | 40 | 160 (together about 9,000 of the shared 10,000 neurons, at about 45 per run) |
| Cron | one every 10 minutes: pending sweep, plus the phishing refresh once a day | same |
| Version preview URLs | default | off (`preview_urls: false`) [CHECK key name and default] |
| Test hooks | `TEST_SETTLE_MODE` allowed | refused by the config check |

Why this shape:

- A bare `npx wrangler deploy` always deploys testnet. Production needs the guarded script.
- Separate Workers have separate Durable Objects. Production starts with an empty board and an empty sales table, so testnet rows can never mix into income.
- Each Worker counts its AI runs in its own limiter DO. So the two caps must be split by hand to stay under the account-wide neuron limit.

## 5. Owner prerequisites (exact steps)

**P1. [OWNER OK] Approve this plan** and the decisions list. This approves the build only.

**P2. [OWNER DOES] Create the LLC receiving wallet.**

1. Preferred: a hardware wallet, with a new account on a new recovery phrase. Otherwise, a self-custody app that gives a normal address with a recovery phrase. Do not add an account under an existing personal or mining seed.
2. [CHECK] The Base app (formerly Coinbase Wallet) may create a passkey smart wallet rather than a recovery-phrase wallet. A smart wallet can receive x402 payments, but its backup and sending steps differ. Tell Claude which type you made.
3. Write the recovery phrase on paper and keep it offline: not iCloud, not a photo, not a file. Never type it into a website or chat, and never give it to Claude.
4. Label it "CT Wendt Holdings LLC: Bounce Board revenue". Use it for nothing else.
5. Copy its Base address. Search it on basescan.org and confirm it has no history.
6. Create a private file outside the repo (`bounce-expected-payto.txt`) holding only that address, checksummed (mixed case). Reconcile and the health check compare against it.
7. Before C5 (opening payments), send about $2 of ETH on Base to it, straight from Coinbase Business. Refunds and sweeps need it. **[SPEND]**

**P3. [OWNER DOES] Fund a fresh buyer wallet for the smoke test.**

1. Create a new wallet. Do not use your existing personal wallet: a payment from it would link it to the LLC wallet publicly, for good.
2. From Coinbase, send about $3 of USDC to it on the **Base** network. Check the fee before you confirm. **[SPEND]**
3. Confirm the token is USDC at 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, not USDbC. No ETH is needed to pay.

**P4. [OWNER DOES] Set up CDP keys in a dedicated project.**

1. At portal.cdp.coinbase.com, create a project named `bounce-board` [CHECK the project feature]. Never create server wallets or a Wallet Secret in it. onchain-desk and anything else get their own projects.
2. Reuse your rotated key for production only if all of these are true:
   - it is Ed25519;
   - it has no IP allowlist;
   - it is in the bounce-board project;
   - it has never been anywhere but your password manager.

   If any of these is false, delete it and create a new key.
3. Create `bounce-board-production` (if needed) and `bounce-board-staging`.
   - Algorithm: Ed25519.
   - No IP allowlist, because Workers call out from Cloudflare's shared IPs.
   - If the portal offers permission scopes, pick the narrowest one that mentions x402 or payments, and tell Claude which. S3 and S4 show whether it works. Widen it only if they fail.
4. If the portal offers billing alerts or spend caps, set one at $5 a month [CHECK].
5. Save each secret in your password manager. If you download the JSON file, keep it out of every repo and out of iCloud, and delete it after you enter the key.
6. Enter keys only when the checklist says so. Run the commands below from the bounce-board folder and paste at the hidden prompt. Never paste a key into chat, into a file in a repo, or onto a command line.

```
npx wrangler secret put CDP_API_KEY_ID                       # staging, at S2
npx wrangler secret put CDP_API_KEY_SECRET                   # staging, at S2
npx wrangler secret put CDP_API_KEY_ID --env production      # production, at D3
npx wrangler secret put CDP_API_KEY_SECRET --env production  # production, at D3
```

7. If the portal gives a multi-line PEM (ECDSA) key, stop and tell Claude. A multi-line paste at the prompt can be cut short.

**P5. [OWNER DOES] Enter the production address secrets** (at D3):

```
npx wrangler secret put PAY_TO_ADDRESS --env production   # the LLC address from P2
npx wrangler secret put ALLOWED_PAYERS --env production   # the buyer address from P3
```

Claude sets the production ADMIN_TOKEN from a new mode-600 file in the private data folder. The value is piped to `wrangler secret put` and never printed.

**P6. [OWNER DOES] Ask Blockaid to verify the site** (#15), after the M3 deploy and before cutover.

1. Go to report.blockaid.io and pick the developer option to verify a project.
2. Domains: bouncebox.xyz and testnet.bouncebox.xyz.
3. Description: "x402 payments. The page asks for one EIP-3009 USDC transferWithAuthorization signature for exactly $1 on Base. No token approvals, no contract deployments, no seed phrase requests. Source: github.com/cwendt6/bounce-board." If decision 8 blocks the paid step for some countries, say so here.
4. Save the ticket ID and tell Claude. It goes in STATUS.md.
5. If MetaMask flags the site, click "See details", then "Report an issue".

**P7. [OWNER DOES] Set up an alert inbox.**

The public contact stays on GitHub issues for now (decision 9, decided 2026-10-13). No public email address is needed. Email Routing is only for alerts:

1. In Cloudflare: bouncebox.xyz > Email > Email Routing > enable. Email Routing is free.
2. Add your inbox as a destination and confirm the email Cloudflare sends. Do not create a public address.
3. PR8 sends money alerts to that confirmed inbox [CHECK that the Worker send-email binding works on Free]. If it doesn't, alerts fall back to an n8n check on the Mac mini.

**P8. [OWNER DOES] Paperwork.** Not tax or legal advice. Ask your CPA:

- Is each mainnet sale Schedule C gross receipts of the LLC (single-member, disregarded), valued in USD when received (IRS Notice 2014-21, Q-3 and Q-5)? Is recording USDC at $1.00 a reasonable, consistent method?
- Are the smoke-test payment and its refund owner transactions, not income?
- How are refunds recorded (returns and allowances)?
- Does any Form 1099-K apply? It is not known whether CDP counts as a settlement organization.
- Do Indiana sales tax, or EU and UK VAT on digital services sold to consumers, apply to paid placements? From what point?
- The domain and Cloudflare costs were paid personally. Should they be recorded as owner contributions, or reimbursed?
- Confirm "Yes" on the Form 1040 digital asset question.

The M3 terms and privacy pages are Claude drafts, not a lawyer's review. Cole read them and is fine with them (decision 18, 2026-10-13).

**P9. [OWNER DOES] Check Coinbase Business.** Confirm it accepts USDC on Base. Get a fresh deposit address at each sweep. Make the first sweep $1 and confirm it is credited before you send more.

**P10. [OWNER DOES] Lock down the accounts that control the money path.** Anyone with your Cloudflare account can change PAY_TO_ADDRESS.

1. Turn on hardware security key or passkey 2FA for Cloudflare, CDP, GitHub, Coinbase and Coinbase Business.
2. In Cloudflare, turn on DNSSEC for bouncebox.xyz and confirm the registrar lock is on.
3. Review the Cloudflare audit log weekly (section 9).

## 6. Code changes

Each PR: branch `feat/4-<name>`, tests, CI green (Biome, tsc, Vitest, build, gitleaks), squash merge. No real addresses or keys in code, fixtures or docs. Merging needs no OK. Deploying to production is gated. Build them in this order. PR9 can ship after launch.

### PR1. Environments, config check and guarded deploy (`feat/4-envs`)

- `wrangler.jsonc`:
  - The top level becomes staging. Routes: testnet.bouncebox.xyz, plus bouncebox.xyz and www until cutover. `X402_NETWORK` eip155:84532, `ENVIRONMENT` "staging", `AI_DAILY_CAP` "40".
  - `env.production` repeats every binding (BOARD, PHISHING, LIMITER, AI), the cron and all vars:
    - `X402_NETWORK` eip155:8453, `FACILITATOR` "cdp", `ENVIRONMENT` "production", `PAYMENTS` "paused", `AI_DAILY_CAP` "160";
    - no routes until cutover;
    - `workers_dev` true until cutover, then false;
    - `preview_urls` false.

    A dry run confirms that migrations v1 to v3 apply to the new Worker.
  - `observability` on in both. [CHECK] at S3: do invocation logs store request headers? If they include `Authorization` or `PAYMENT-SIGNATURE`, turn invocation logs off and keep only our own log lines.
- Replace `FACILITATOR_URL` with `FACILITATOR` = "cdp" or "x402.org". The URL comes from a constant map in code. Never rely on @x402/core's default URL.
- `worker/config.ts`: `loadPayConfig(env)` returns the config or a list of problems. It refuses:
  - an unknown network;
  - mainnet with x402.org;
  - "cdp" without both CDP secrets;
  - production on testnet, or staging on mainnet;
  - on mainnet: `DEV_FAKE_PAY` "true", any check set to "off", or any `TEST_SETTLE_MODE`;
  - a PAY_TO_ADDRESS that is not EIP-55 checksummed (mixed case), or is the zero address;
  - a PRICE_USD that is not a positive decimal with at most 2 places.
- Any problem: `/api/take` answers 503 "payments are not configured" before any quote or AI call. The log names the problems, never the values.
- `GET /api/info`: environment, network name, testnet flag, effective payments mode, price, terms version. If the page cannot load it, the pay button stays off.
- Page: staging shows "Testnet: test USDC on Base Sepolia, no real money" with a link to bouncebox.xyz. The production dialog says "Real USDC on Base".
- `scripts/deploy-prod.sh` (`npm run deploy:prod`):
  - It refuses unless the branch is main, the tree is clean, HEAD equals origin/main, and CI passed for HEAD (`gh run list`).
  - It runs `npm ci`, the tests, the build and `wrangler deploy --env production --dry-run`.
  - It prints the vars that will ship and asks for the word "production" to be typed in.
  - It deploys with `--message <git sha>`. The health page shows that SHA.
- `.dev.vars.example` with placeholders only. README deploy section for both environments.
- Tests:
  - one test per refusal rule;
  - a config test that parses `wrangler.jsonc` and checks:
    - production is eip155:8453 with cdp, and staging is eip155:84532;
    - both have every binding and the cron;
    - DEV_FAKE_PAY is "false" and no check is "off";
    - staging and production hosts never overlap;
    - production `preview_urls` is false;
    - the AI caps add up to at most 200.

### PR2. Payments switch (`feat/4-payments-mode`)

- The `PAYMENTS` var is `open`, `owner-only` or `paused`. The Board also stores a switch: `paused` or `clear`.
  - The effective mode is the stricter of the two.
  - In production, a missing switch row counts as `paused`.
  - A var change, deploy or rollback cannot lift a stored pause.
- `POST /api/admin/payments {mode: "paused" | "clear"}` (admin token). The admin page gets a large "Pause payments" button that works on a phone.
- `paused`: `/api/take` answers 503 "Payments are paused. You have not been charged." before any quote or AI call.
- `owner-only`:
  - Right after verify, and before limits, token checks and AI, a payer not in `ALLOWED_PAYERS` gets "Payments open soon. You have not been charged."
  - The page shows "Payments open soon" and keeps the button off unless the URL has `?owner=1`.
- Tests:
  - each mode;
  - settle and AI are never called for a payer not on the list;
  - a stored pause beats `PAYMENTS` "open";
  - only "clear" lifts it;
  - production with no row is paused.

### PR3. CDP facilitator auth (`feat/4-cdp-auth`)

- Primary path: `worker/cdp-jwt.ts`, about 30 lines of WebCrypto Ed25519 (EdDSA). It is small and auditable, and it keeps axios and cdp-sdk out of the money path.
  - Claims: `sub` = key id, `iss` "cdp", `uris` ["<METHOD> api.cdp.coinbase.com<path>"], `nbf` and `iat` now, `exp` now + 120 s.
  - Header: `alg` EdDSA, `kid` = key id, `typ` JWT, `nonce` = 16 random bytes as hex.
  - The secret is base64 of 64 bytes: a 32-byte seed, then the 32-byte public key. Import it as JWK `{kty: "OKP", crv: "Ed25519", d, x}`.
- `createAuthHeaders` returns headers keyed by `verify`, `settle` and `supported`. A flat object throws in @x402/core 2.28.
- `@coinbase/x402` 2.1.0 goes in devDependencies only. A test checks that our decoded claims and header match what its `createAuthHeader` builds.
- Client: `new HTTPFacilitatorClient({url, createAuthHeaders, timeoutMs})`. Pass the env values explicitly and never use `process.env`.
- The gateway cache key is a hash of the config, never the secret. Never log the config or request headers.
- Spike on staging at S3. A 402 quote proves the `GET /supported` token. S4 proves verify and settle on testnet.
- Fallback: if WebCrypto Ed25519 fails in workerd [CHECK], try `@coinbase/x402` and measure bundle size (dry run) and CPU.
- Tests:
  - each path gets its own token with the right method and path;
  - tokens expire 120 s after they are issued;
  - the signature verifies with a key generated inside the test (no real key in fixtures);
  - missing keys give a config error, not a crash.

### PR4. Settlement safety (`feat/4-settle-safety`)

This is the core of M4.

- **Pins.** Pin `@x402/core`, `@x402/evm` and `viem` to exact versions. Add `save-exact=true` to `.npmrc`. CI and deploys use `npm ci`. Confirm that `npm ls @x402/core` shows one copy. Upgrades go through staging first.
- **Asset guard.** Before answering 402, check three things. The asset is native USDC for the network (a two-address table citing Circle's list). The amount equals PRICE_USD in atomic units. payTo equals the config. If any check fails, refuse to quote.
- **EIP-3009 only on mainnet.** Accept only a payload with an `authorization` (from, to, value, validAfter, validBefore, nonce). Its `to` must equal payTo and its `value` must equal the price. Refuse Permit2 payloads.
- **Time margin.** If fewer than 20 s remain before `validBefore` once the checks are done, refuse before settle: "Not charged. Please sign again."
- **Settle inside the Board.** After verify, limits, token checks and moderation, the Worker makes one call: `board.settleAndRecord(payload, requirements, card, logo, termsVersion)`. The Board then:
  1. inserts a `pending_payments` row (payer, nonce, amount, valid_before, card JSON, logo, terms version, created_at) with UNIQUE(payer, nonce). If the insert fails (a duplicate or the write quota), it answers "not charged" and never settles. A concurrent request with the same signed payment stops here.
  2. calls the facilitator's settle (90 s timeout).
  3. on `success` with a tx hash: writes the sale and the takeover and deletes the pending row, all in one SQLite transaction. A repeated tx hash is a no-op.
  4. on anything else (a thrown error, a timeout, `success: false` with or without a tx hash, including `settlement_pending`): keeps the row, marks it `unknown`, saves the reason and any tx hash, and logs `SETTLE UNKNOWN <pending id>`.
  - Why the Board: a Durable Object got 30 s of CPU in the 2026-10-01 probe, so the Worker's 10 ms limit cannot cut the request off after money moves. [CHECK] Does a Board call keep running if the buyer closes the tab? The sweeper covers it either way.
- **Buyer answer for unknown.** 202 with the pending id: "We could not confirm your payment yet. Do not pay again. We check the blockchain every 10 minutes. If $1 left your wallet, your takeover will be queued or refunded. Status: /api/payment/<id>."
- **`GET /api/payment/:id`** answers pending, settled (with the tx) or not charged. No payer details.
- **Page.**
  - It keeps the last pending id in sessionStorage.
  - Before it asks for a new signature, it checks that id. While the payment is pending, the button reads "Checking your last payment" and stays off.
  - A network error after "Settling payment" also counts as pending.
- **Sweeper.** It runs on the cron every 10 minutes and also from `POST /api/admin/sweep`. For each open pending row, it calls USDC `authorizationState(payer, nonce)` on a public Base RPC, with a second RPC as fallback [CHECK rate limits].
  - **Used:** find the tx from the `AuthorizationUsed(payer, nonce)` event. Check the receipt: status success, and a native USDC `Transfer` from the payer to payTo for the price. Then write the sale (received_at = block time) and queue the takeover. This also covers a buyer or a third party who submits the authorization on chain directly.
  - **Not used and `valid_before` has passed:** close the row as "not charged".
  - **Otherwise:** wait for the next run. Alert if the row is older than 30 minutes.
  - **Receipt mismatch:** alert and write nothing.
- **Admin resolve.** `POST /api/admin/resolve {id}` runs the same on-chain check for one row. There is no way to write a sale from a typed tx hash.
- **Messages.** Errors before settle keep "You have not been charged." That covers quote, verify, limits, token checks, moderation, owner-only, sanctions and KYT declines at verify. After settle, only the sweeper's proof allows that message.
- Cite IRS Notice 2014-21 (Q-3, Q-5) in the `usdValue` docstring. Not tax advice.
- Staging-only `TEST_SETTLE_MODE` for the S6 drills:
  - `report-timeout`: settle really happens, but the code treats it as a timeout;
  - `skip-settle`: write the pending row and never settle.
- Tests (fake gateway, fake RPC):
  - the mainnet quote has asset 0x8335...2913, amount 1000000, and extra name "USD Coin" with version "2";
  - the Sepolia quote's name is "USDC";
  - the EIP-712 name is never hard-coded in the signing path;
  - a timeout, a thrown SettleError, and `settlement_pending` with a tx hash each leave an unknown row and no sale, and the answer never says "not charged";
  - a failed pending insert means settle is never called;
  - two requests with the same payload: settle is called once;
  - a settle success writes exactly one sale and clears the row;
  - sweeper: a used nonce gives exactly one sale and one takeover;
  - sweeper: unused and expired closes the row; unused and not expired waits;
  - sweeper: a receipt with the wrong token, payer, receiver or amount alerts and writes nothing;
  - `TEST_SETTLE_MODE` is refused on mainnet.

### PR5. Keep testnet and mainnet sales apart (`feat/4-sales-split`)

- Separate Workers already give separate tables. The Board also refuses a sale whose network differs from its environment's network.
- The CSV filename names the network: `bounce-board-sales-mainnet.csv` or `-testnet.csv`. The columns do not change.
- Sales the sweeper writes use block time for `received_at`. Direct sales use server time, and reconcile flags any sale whose block time is more than 10 minutes off or on a different UTC day.
- Follow-up issue in btc-mining-ledger: import the sales CSV plus `refunds.csv` and `sweeps.csv` from the private data folder.
  - Import mainnet rows only, and refuse a file that mixes networks.
  - Dedupe on tx_hash.
  - Skip tx hashes on the private owner-test list.
  - Print "Not tax advice."
- Tests: a wrong-network sale is refused, the filename is right, and the existing CSV tests still pass.

### PR6. Terms acceptance and terms content (`feat/4-terms-accept`)

- `TERMS_VERSION` (a date string) in `src/core/terms.ts`, shown at the top of /terms.
- Dialog: an unchecked box, "I agree to the Terms and understand this is a paid placement," linking /terms and /privacy. "Take the box" stays off until the box is checked.
- API: the body field `terms` must equal `TERMS_VERSION`. It is checked first, before link, token and AI checks. If it is missing or old, the answer is 400 with the current version and the terms URL.
- Stored in `takeovers.terms_version`: an additive column, with a guarded ALTER for staging's existing table.
- Terms content to add or confirm. Cole reviews it. Not legal advice.
  - The operator (CT Wendt Holdings LLC) and the contact (GitHub issues, per decision 9). Refund requests by GitHub issue need a way to reply privately; settle that before payments open.
  - The buyer is 18 or older, is not on a US sanctions list, and is not in an embargoed region.
  - The refund policy from decision 7, with a 7-day refund target.
  - Payments are final on chain. Refunds go only to the paying address.
  - No securities offerings, presales or "send tokens to get tokens" listings. A paid placement is not an endorsement.
  - The corner-hit bonus is extra display time only, with no cash value.
  - A bot or agent that sends `terms` accepts on behalf of whoever runs it.
- Tests: missing, old and current versions; the dev endpoint follows the same rule; the column is written.

### PR7. Sanctions screening (`feat/4-sanctions`, per decision 8)

- `worker/data/sdn-evm.json` holds the Ethereum-format addresses from OFAC's SDN list, which is public data. A weekly GitHub Action rebuilds it from OFAC's published files and opens a PR [CHECK the source format].
- The verified payer is checked before settle. A match gets "This payment cannot be accepted. You have not been charged." and an alert. Nothing else goes back to the payer.
- An `SDN_EXTRA` var adds extra addresses to block. Staging uses it for the S7 drill.
- Optional, per decision 8: refuse the paid step (not the page) when `request.cf.country` is a comprehensively embargoed country.
- `npm run screen -- <address>`: Claude runs it before Cole sends any refund. A match means no refund, and Cole talks to a lawyer.
- CDP's own OFAC and KYT screening is rated only "likely" in the research. Treat it as a second layer.
- Tests: a listed address never reaches settle; the check ignores case; the list loads.

### PR8. Monitoring, alerts and reconciliation (`feat/4-health`)

- **Counters.** One WITHOUT ROWID row per day and counter, bumped only on the paid path after verify and inside Board calls that already happen. Counters:
  - verify_invalid, settle_unknown, settled;
  - sweeper_resolved, sweeper_closed;
  - moderation_unavailable, ai_text_calls, ai_logo_calls;
  - sanctions_blocked.

  Unpaid quotes write nothing new. Quote volume comes from Workers Logs.
- **`GET /api/admin/health`** (admin token) shows:
  - 7 days of counters and the open pending rows;
  - environment, network, facilitator and the effective payments mode;
  - the **full** payTo address;
  - terms version, deployed git SHA and version id;
  - a neuron estimate.
- **Alerts.** The Worker emails the confirmed inbox from P7 on:
  - SETTLE UNKNOWN;
  - a pending row older than 30 minutes;
  - a sweeper receipt mismatch;
  - a sanctions match;
  - moderation unavailable;
  - any error writing a sale.

  At most one email per type per hour. [CHECK the send-email binding on Free. Fallback: an n8n check on the Mac mini.]
- **Reconcile** (`npm run reconcile -- <sales.csv>`):
  - It takes the expected receiver from a private file outside the repo (`bounce-expected-payto.txt`), never from the CSV. Any row with a different `receiver` is an error.
  - It pulls native USDC `Transfer` logs into and out of that address from a public Base RPC (viem `getLogs`, in chunks from the first sale's block).
  - It sorts every transfer:
    - matched sale;
    - sale with no transfer (error);
    - amount, payer or token mismatch (error);
    - unsolicited inbound (listed, not a sale);
    - zero-value or spam (ignored, with an address-poisoning warning);
    - outbound matched to `refunds.csv` or `sweeps.csv`;
    - unexplained outbound (error).
  - It checks that each sale's tx succeeded and used the native USDC contract, and reports block time.
  - It prints the expected LLC wallet balance.
  - It works on Base and Base Sepolia and prints "Not tax advice." Tests use fixture logs.
- **Records.** `refunds.csv` in the private data folder (sale id, payer, amount, refund tx, date, reason) and `sweeps.csv` (amount, tx, date, Coinbase Business credit date). Claude adds the rows after Cole sends.
- **Backups.** The cron emails a daily sales CSV to the alert inbox if the binding allows attachments [CHECK]. Otherwise Claude downloads it each session. The chain backs up the amounts but not the card details.
- **Quota guards:**
  - AI caps of 160 for production and 40 for staging (PR1). Measure on staging and adjust.
  - Tighter take limits per IP on staging.
  - A Cloudflare WAF rate-limiting rule on `/api/take` for both hosts [CHECK the Free allowance].
  - DO rows written per day on the health page if the analytics API can be read with a read-only token [CHECK]. Otherwise, from the dashboard.
- Docs: update the write budget in `docs/architecture.md` with the measured rows per paid takeover. Add `docs/runbook.md` with go-live, pause, rollback, refunds, and daily and weekly checks. No private data.

### PR9. Public API docs (`feat/4-api-docs`, can follow launch)

- A static /developers page, linked from the footer, from a `docs` field in the 402 body, and from `GET /api/take`.
- What the page covers:
  - both endpoints, testnet first;
  - fields and limits, including `terms`;
  - the x402 v2 flow;
  - every status code, including 202 and polling `/api/payment/:id`;
  - rate limits, content rules and the refund policy;
  - one TypeScript example using `@x402/fetch` on Base Sepolia.
- Warnings for bot builders:
  - use a dedicated hot wallet with a small balance;
  - never log or share the `PAYMENT-SIGNATURE` header, because it is a signed $1 transfer until it expires;
  - never answer a 202 with a new signature.
- `GET /api/take` returns a JSON description: method, fields, price, network, asset, terms version and docs URL. No AI call, no payment.
- Optional: `/llms.txt`.
- Tests: the example body passes `validateCard`, and `GET /api/take` matches the config.

Effort: about three weekend sessions of Claude work for PR1 to PR8. Cole's steps take about 90 minutes, plus any wait on Blockaid.

## 7. Go-live checklist

### Phase S: staging (no real money)

- [ ] **S1.** Claude merges PR1 to PR8 and deploys staging. testnet.bouncebox.xyz goes live. bouncebox.xyz still serves testnet.
- [ ] **S2. [OWNER DOES]** Create the staging CDP key and enter it (P4).
- [ ] **S3.** Claude sets staging `FACILITATOR` to "cdp" and deploys.
  - Pass: the 402 quote works, which proves the `/supported` token.
  - Also record: the dry-run bundle size, and whether invocation logs store headers.
- [ ] **S4. [OWNER DOES]** One testnet takeover in Coinbase Wallet on testnet.bouncebox.xyz. Pass:
  - the page answers 201;
  - the tx is on sepolia.basescan.org;
  - the staging CSV has a row with network=testnet and facilitator=cdp.
- [ ] **S5. CPU and quota.** Claude sends ten testnet takes with a 500 KB logo (the maximum) and reads CPU per request in Workers Logs.
  - Pass: the Worker's p99 is under 5 ms, and no request hits the limit.
  - Also record DO rows written and neurons per take.
  - If it fails, see decision 6.
- [ ] **S6. Failure drills on testnet.**
  - `TEST_SETTLE_MODE=report-timeout`: Cole does one testnet takeover. Pass: the page shows the 202 and blocks a second payment, an alert email arrives, and within 10 minutes the sweeper writes the sale and queues the takeover.
  - `TEST_SETTLE_MODE=skip-settle`: Cole does one more. Pass: after `validBefore`, the sweeper closes it as "not charged", and no test USDC moved.
  - Pause drill: a stored pause beats `PAYMENTS` "open", and a redeploy does not lift it.
  - Turn `TEST_SETTLE_MODE` off afterwards.
- [ ] **S7.** Claude checks on staging:
  - the terms rule, /api/info and the payment status endpoint;
  - owner-only mode (Cole types a test wallet into staging `ALLOWED_PAYERS`);
  - the sanctions check: Cole's test wallet goes in `SDN_EXTRA`, and his next take must stop before settle;
  - the health page;
  - `npm run reconcile` on the staging CSV, against a staging expected-address file.
- [ ] **S8.** Per decision 2, Claude sets staging `FACILITATOR` back to "x402.org" for public use.

### Phase D: production, dark

- [ ] **D1. [OWNER DOES] [SPEND]** P2 (the LLC wallet and the expected-address file) and P3 (the fresh buyer wallet with about $3 USDC).
- [ ] **D2. [OWNER OK]** Claude runs `npm run deploy:prod` for the first time. The state:
  - PAYMENTS is "paused", and the missing stored switch also counts as paused;
  - no custom domain;
  - new, empty DOs.

  No payment is possible.
- [ ] **D3. [OWNER DOES]** Enter CDP_API_KEY_ID, CDP_API_KEY_SECRET, PAY_TO_ADDRESS and ALLOWED_PAYERS (P4, P5). Claude sets ADMIN_TOKEN and writes the stored switch as "paused".
- [ ] **D4.** Claude runs `npx wrangler secret list --env production` (five names) and opens `/api/admin/health`.
  - Pass: eip155:8453, cdp, paused, and a payTo that a script compares in full with the expected-address file.
  - **[OWNER DOES]** Compare the full address on the health page with the address shown inside the LLC wallet app on your device. Stop if any character differs.
- [ ] **D5. [OWNER OK]** Claude sets PAYMENTS to "owner-only", deploys, and clears the stored pause. Checks on the workers.dev URL, with no money moving:
  - `POST /api/take` with a test card returns 402 with:
    - network eip155:8453;
    - asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 and amount 1000000;
    - extra name "USD Coin" with version "2";
    - the full expected payTo.
  - A payment signed by a zero-balance key, made in memory inside a test script, is rejected at verify (insufficient funds). The key is never written down. No pending row, no sale. This proves the CDP verify token on mainnet.
  - The health counters moved as expected.

### Phase C: cutover and real-money smoke test

- [ ] **C1. [OWNER OK]** Cutover.
  1. Claude removes bouncebox.xyz and www from staging and deploys staging.
  2. Claude adds them to production, sets production `workers_dev` to false, and runs `npm run deploy:prod`. Expect a short outage on bouncebox.xyz [CHECK how long].
  3. In the dashboard (Workers & Pages > each Worker > Settings > Domains & Routes), confirm each host is attached to exactly one Worker.
  4. Pass: bouncebox.xyz/api/info shows mainnet and owner-only, and testnet.bouncebox.xyz/api/info shows testnet.
- [ ] **C2. [OWNER DOES]** Open https://bouncebox.xyz in Coinbase Wallet.
  - Pass: no "unsafe" warning.
  - If there is a warning, stop, update the Blockaid ticket and wait.
- [ ] **C3. [OWNER DOES] [SPEND]** One takeover with a plain test card at bouncebox.xyz/?owner=1, paid from the fresh buyer wallet. Before signing, check that the wallet shows 1 USDC on Base going to the full LLC address. Cost: $1, from you to your LLC.
- [ ] **C4.** Claude and Cole check. Everything must pass:
  - The page answered 201, and the card is on the board or in the queue.
  - basescan.org shows 1.000000 USDC (contract 0x8335...2913) from the buyer to the LLC wallet. The buyer paid no ETH.
  - **[OWNER DOES]** The LLC wallet app on your device shows +1 USDC.
  - The production CSV has exactly one row: mainnet, base, USDC, 1.000000, usd_value 1.00, the same tx_hash and payer, facilitator cdp.
  - The staging CSV has no new row.
  - `npm run reconcile` reports 0 errors.
  - Health shows settle_unknown 0 and no open pending rows.
  - CDP portal usage shows one transaction and no charge to you [CHECK who pays gas].
  - Claude adds the tx hash to the private owner-test list.
  - If any check fails: pause with the stored switch and stop.
- [ ] **C4b. [OWNER DOES] [SPEND] Refund drill.**
  1. Claude runs `npm run screen` on the buyer address.
  2. Cole sends the $1 back from the LLC wallet to the buyer address, copied from the sales CSV.
  3. Claude adds the row to `refunds.csv`.
  4. Pass: reconcile matches the refund. This proves the LLC wallet can send, and gas costs cents.
- [ ] **C5. [OWNER OK]** Open payments: set PAYMENTS to "open" and run `npm run deploy:prod`. Health shows "open". The optional second mainnet test is skipped (decision 15).
- [ ] **C6.** Claude updates the README, docs/architecture.md, docs/runbook.md, STATUS.md and BACKLOG.md, and closes #4. For the first week, check alerts and health daily.

## 8. Rollback plan

Rule: pausing is always allowed and fast. Anything that reopens payments needs Cole's OK. Before any rollback, download the production sales CSV to the private data folder.

1. **Pause.** This is the first response to any money problem.
   - Use the admin page's "Pause payments" button, or `POST /api/admin/payments {mode: "paused"}`.
   - It takes effect on the next request and needs no deploy. No later deploy or rollback can undo it.
   - The board keeps running.
2. **Roll back code.**
   - Run `npx wrangler deployments list --env production`, then `npx wrangler rollback <version-id> --env production`.
   - The stored pause stays in force. Durable Object data is not rolled back, so every M4 schema change is additive.
   - Afterwards, recheck health: network, facilitator, mode, the full payTo and the git SHA.
3. **Domain back to testnet. [OWNER OK]** Last resort only. Prefer pause plus rollback. A testnet app on the real-money domain confuses buyers and wallet scanners.
4. **CDP key leaked or suspected.**
   - Revoke it in the portal at once. Verify then fails, so no new buyer is charged.
   - Open pending rows still resolve, because the sweeper reads the chain, not CDP.
   - Create a new key, enter it, deploy, and delete the old one.
5. **Wrong receiving address, or the LLC wallet or Cloudflare account is compromised.**
   - Pause.
   - Cole moves the funds to a new wallet and updates PAY_TO_ADDRESS and the expected-address file.
   - Rotate ADMIN_TOKEN and review the Cloudflare audit log.
   - Funds sent to a wrong address are likely lost.
6. **Paid but not queued, or unknown outcome.**
   - The sweeper resolves it.
   - If it cannot (a receipt mismatch, or the RPC is down), Claude runs admin resolve.
   - If the takeover cannot be shown, refund it. **[OWNER DOES]** Claude screens the address with `npm run screen`. Cole sends USDC from the LLC wallet to the address in the sales CSV. Claude records the refund in `refunds.csv`.
   - A sanctions match means no refund. Talk to a lawyer. Not legal advice.
7. **CDP outage.**
   - Verify fails, so no new buyer is charged.
   - Settles that were in flight become pending rows, and the sweeper resolves them.
   - If the outage lasts more than 15 minutes, pause. x402.org cannot stand in, because it is testnet only.

## 9. Monitoring

Automatic: alert emails (PR8) and the 10-minute sweeper. Cole reads alerts as they arrive and can pause from his phone. Refund target: within 7 days, as the terms say.

Each Claude session, and at least weekly:

1. Download the production sales CSV to a dated file in the private data folder and run `npm run reconcile`. Target: 0 errors.
2. Open /admin.html: health, open pending rows and new reports.
3. Search Workers Logs for "SETTLE UNKNOWN", "SETTLED BUT NOT QUEUED", "sweeper" and "take failed". Free-plan logs last only a few days [CHECK retention].
4. Check the quotas. They are account-wide and shared by staging and production:
   - Workers AI neurons vs 10,000 a day;
   - DO rows written vs 100,000 a day.
5. **[OWNER DOES]** The LLC wallet balance should equal mainnet sales, plus unsolicited inbound, minus refunds and sweeps. Reconcile prints this number.

Weekly:

- Open bouncebox.xyz in Coinbase Wallet and MetaMask, and look for warnings.
- Check CDP usage against the 1,000 free transactions a month.
- Check the Cloudflare audit log for any change to secrets, routes or members that you did not make.
- **[OWNER DOES]** Sweep to Coinbase Business if the balance is over the threshold (decision 13). Take the deposit address fresh from Coinbase Business and compare it in full.
- Merge the weekly sanctions-list PR and ship it through staging.
- Take dependency updates through staging only.

| Signal | Normal | Act when | Action |
| --- | --- | --- | --- |
| settle_unknown | 0 | any | The sweeper resolves it. If a row is older than 30 min, check the alert and resolve it |
| Sweeper receipt mismatch | 0 | any | Pause and investigate |
| Reconcile errors | 0 | any | Pause and investigate before more sales |
| Unsolicited inbound | 0 | any | Not a sale. Note it for the CPA. Do not refund unless asked and screened |
| verify_invalid | a few | a sudden jump | Look for a client bug or abuse |
| moderation_unavailable | 0 | any day | Quota or outage. Buyers cannot pay while it lasts |
| Workers AI neurons | under 7,000 a day | over 8,500 two days running | Lower the staging cap, then decide on Workers Paid |
| DO rows written | under 30,000 a day | over 50,000 | Find the writer (the 2026-10-01 incident hit 100k) |
| sanctions_blocked | 0 | any | Note it in STATUS.md. Do not contact the payer |
| Wallet warning | none | any | Blockaid report, note in STATUS.md |

## 10. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Settle reports failure or times out, but the transfer lands | Buyer charged with no takeover, or pays twice | Every non-success is unknown, 202 "do not pay again", the page blocks a new signature, the sweeper checks the chain |
| Worker cut off after settle (CPU limit, tab closed) | Money received, no record | Settle and record run in the Board, pending row first, sweeper, S5 measurement |
| A deploy or rollback undoes a pause | Payments reopen without an OK | Stored switch, stricter mode wins, production defaults to paused |
| Unreviewed code deployed to production | Payment bugs go live | `npm run deploy:prod` guard, git SHA on the health page |
| Wrong or swapped receiving address | Revenue lost | Checksum check, full-address checks at D4 and C3, reconcile against the private expected address, P10 |
| Shared free-plan quotas used up, including by public testnet abuse | Production cannot take payments until 00:00 UTC (fails closed) | AI caps of 160 and 40, no writes on unpaid quotes, WAF rule, staging limits, alerts |
| Testnet uses up CDP's free tier | Fees, or failed settles if no billing method is on file | Public testnet on x402.org, CDP on staging only for checks |
| CDP key leak | Quota or billing abuse. It should not move funds while the project has no wallets [CHECK] | Dedicated project, narrow scope, prompt-only entry, revoke and rotate |
| Sanctioned payer | Legal exposure | SDN check before settle and before refunds, CDP screening as a second layer, terms representation. Not legal advice |
| Address poisoning when refunding or sweeping | Funds sent to an attacker | Addresses only from the CSV or fresh from Coinbase Business, full compare, small first sweep |
| The LLC wallet cannot send (wrong type, lost phrase) | Revenue stuck, no refunds | Wallet type confirmed in P2, offline backup, refund drill C4b |
| Wallet "unsafe site" warning | Buyers cannot sign | Blockaid request, consistent UI, minimum-funds signatures, weekly check |
| Production Worker deleted by mistake | Sales and pending rows lost | Deletes only with the exact name from Cole, backups, the chain holds the amounts |
| Testnet rows counted as income | Wrong books | Separate Workers, the network check, network in the filename, the ledger refuses mixed files |
| Scam or harmful listing paid with real money | Reputation and legal exposure | M3 moderation, token and link checks, reports, kill switch, terms |
| Terms incomplete or not enforceable | Disputes | PR6 checklist, Cole's review, optional lawyer |
| Bookkeeping errors | Wrong Schedule C | Refunds and sweeps files, owner-test list, CPA questions in P8. Not tax advice |

## 11. Cost estimate

Assumes about 45 neurons per moderation run and about 1.5 runs per sale. Check the pricing pages before any upgrade.

| Item | Launch | 1,000 sales a month | 10,000 sales a month |
| --- | --- | --- | --- |
| Gross revenue | a few dollars | $1,000 | $10,000 |
| Domain | already bought; yearly renewal | same | same |
| Cloudflare Workers | $0 (Free), if S5 passes | $0 (about 33 sales a day) | Workers Paid, $5 a month minimum **[OWNER OK] [SPEND]** |
| Workers AI | $0 (cap of 160 production runs a day) | $0 (about 50 runs a day) | about $4 to $7 a month on Paid |
| CDP facilitator | $0 (1,000 free a month) | $0 | about $9 |
| Settlement gas | expected $0 to Cole [CHECK at C4] | same | same |
| LLC wallet ETH (refunds, sweeps) | about $2 once | same | same |
| Smoke test and refund drill | $1 out and back, plus cents of gas and any Coinbase send fee | n/a | n/a |
| **Running cost** | **$0 a month** | **$0 a month** | **about $18 to $21 a month** |

Note: the production AI cap of 160 runs a day allows about 100 sales a day before moderation reports "unavailable". Raise it only on Workers Paid.

## 12. Facts not yet verified, and where each is checked

| Fact the plan relies on | Checked at |
| --- | --- |
| The CDP key cannot move funds when its project has no wallets | P4 portal review. Treat it as unproven |
| The narrowest CDP permission scope that works for x402 | S3, S4 |
| WebCrypto Ed25519 JWT works in workerd | S3 |
| The Free-plan bundle limit (3 MB compressed) and our bundle size | S3 dry run |
| Worker CPU stays under 10 ms on the paid path | S5 |
| A Board call keeps running if the buyer closes the tab | S6 (the sweeper covers it either way) |
| Public Base RPC limits are enough for the sweeper and reconcile | S6, S7 |
| The send-email binding works on Free | S6 (the alert arrives) |
| A WAF rate-limiting rule is available on Free | PR8 |
| Invocation logs do or do not store request headers | S3 |
| The `preview_urls` key and its default | PR1 dry run |
| Cron triggers allowed on Free | PR1 deploy |
| Downtime when a custom domain moves | C1 |
| Who pays settlement gas | C4 |
| Testnet settlements count toward CDP's free 1,000 | CDP usage page after S4 |
| A billing method is needed past 1,000 a month | CDP portal, before 800 a month |
| CDP KYT screening: payTo coverage and decline format | Treated as a second layer only |
| Coinbase Business credits USDC on Base from a self-custody wallet | P9, first $1 sweep |
| Base app wallet type (passkey or recovery phrase) | P2 |
| Blockaid review time, and .xyz or domain-age scoring | C2 |
| 1099-K, state sales tax, EU and UK VAT, accounting method | CPA (P8). Not tax advice |

## 13. Sources

- CDP facilitator and auth: docs.cdp.coinbase.com/x402/seller/facilitator, docs.cdp.coinbase.com/api-reference/v2/authentication, docs.cdp.coinbase.com/x402/network-support
- @coinbase/x402 2.1.0 and @x402/core 2.28.0 package code, from jsdelivr and the installed copy in bounce-board/node_modules (`settleWithPendingRetry`, `settlement_pending`, `HTTPFacilitatorClient`)
- x402.org is testnet only: docs.x402.org/core-concepts/network-and-token-support
- EIP-3009 (`authorizationState`, `AuthorizationUsed`): eips.ethereum.org/EIPS/eip-3009
- USDC addresses: developers.circle.com/stablecoins/usdc-contract-addresses
- Wallet warnings: docs.base.org/base-chain/security/avoid-malicious-flags, report.blockaid.io
- Workers: developers.cloudflare.com/workers/runtime-apis/web-crypto/ and /nodejs/process/
- Durable Object CPU (30 s) and the daily write limit: the probe on Cole's account, 2026-10-01 (STATUS.md)
- Tax: IRS Notice 2014-21, irs.gov/filing/digital-assets. Not tax advice.
- Sanctions: OFAC SDN list (treasury.gov). Not legal advice.

## 14. Decisions for Cole

The plan refers to these by number. Recommended answers are marked.

1. Approve the revised M4 plan. This approves the build only. Every real-money step still needs its own OK.
2. Staging facilitator. Recommended: use CDP on Base Sepolia for the S phase and before each payment-code release, then switch back to x402.org for public testnet use. That way public testnet traffic cannot use up CDP's 1,000 free monthly transactions. Alternative: keep CDP on staging all the time, with a cap of 10 testnet settles a day.
3. CDP setup. Recommended: one CDP project just for bounce-board, never with server wallets or a Wallet Secret. Reuse your rotated key for production only if it is Ed25519, has no IP allowlist, and sits in that project. Otherwise delete it and make a new one.
4. Testnet host: testnet.bouncebox.xyz. Turn the workers.dev URLs off once the custom domains work (recommended).
5. Soft launch in owner-only mode, so your $1 test happens before the public can pay (recommended).
6. Cloudflare plan. Recommended: stay on Free at launch only if S5 shows the paid path under 5 ms of CPU at p99. If it does not, upgrade to Workers Paid ($5 a month minimum) before payments open. Paid also removes the 100,000-row daily Durable Object limit, which public testnet abuse could hit.
7. Refund policy for the terms. Proposal: no refund once a takeover has shown, and none for listings removed for breaking the rules. Refund when a payment settles but the takeover never shows, or when we remove a listing by mistake. Refunds go only to the paying address, within 7 days, after a sanctions check. You send them from the LLC wallet.
8. Sanctions. Recommended: check payers against OFAC's SDN crypto addresses before settle and before any refund, and add a sanctions statement to the terms. CDP's own screening is not verified. Separately, decide whether to block the paid step from fully embargoed countries by IP. That is a lawyer question, and it may affect wallet-scanner reviews. Not legal advice.
9. Contact address, and naming CT Wendt Holdings LLC as the operator in the terms. **Decided 2026-10-13:** the LLC is the operator (live in the M3 terms), and the contact stays on GitHub issues for now because traffic is expected to be low. Revisit if refund or privacy requests start coming in, since those shouldn't be handled in public.
10. Alerts (recommended). The Worker emails your inbox about unknown payments, sweeper problems, sanctions matches and moderation outages, so you hear about them between Claude sessions.
11. Pause authority: may Claude pause production payments without asking when money is at risk, and tell you after? Reopening always needs your OK.
12. Production deploys after launch go only through npm run deploy:prod. Any change to payment code or production config needs your OK. UI-only changes ship after staging checks.
13. LLC wallet. A hardware wallet or a recovery-phrase wallet is preferred over a Base app passkey wallet. Put about $2 of ETH on Base in it from Coinbase Business before payments open. Pick a sweep threshold and how often you sweep.
14. Smoke test from a fresh buyer wallet funded straight from Coinbase, not your personal wallet, so the two are never linked on chain (recommended).
15. Refund drill (recommended): send the $1 smoke-test payment back to the buyer wallet to prove the LLC wallet can send. Skip the optional second mainnet test through the API example, because it needs a funded key in a script.
16. Price stays at $1 USDC per takeover at launch.
17. CPA questions before the first real sale (P8). How are the smoke test and its refund treated? How are refunds recorded? Does a 1099-K apply? Do Indiana sales tax or EU and UK VAT apply to digital placements? How should the personally paid domain and Cloudflare costs be recorded? Confirm the Form 1040 digital asset answer. Not tax advice.
18. Optional lawyer review of the terms and privacy pages before payments open (costs money). Otherwise you review the Claude drafts yourself. **2026-10-13:** Cole reviewed the drafts and is fine with them. A lawyer review stays optional.
19. Account security (P10) before D1. Hardware-key or passkey 2FA on Cloudflare, CDP, GitHub, Coinbase and Coinbase Business. DNSSEC and registrar lock on bouncebox.xyz.
