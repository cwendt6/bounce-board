import type { Board } from "./board";

export interface Env {
  BOARD: DurableObjectNamespace<Board>;
  ASSETS: Fetcher;
  PRICE_USD: string;
  /** CAIP-2 network for payments: eip155:84532 (Base Sepolia) or eip155:8453 (Base). */
  X402_NETWORK: string;
  FACILITATOR_URL: string;
  /** Receiving address. Set per environment (.dev.vars or the dashboard), never in the repo. */
  PAY_TO_ADDRESS?: string;
  /** Bearer token for the sales CSV export. Set with `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN?: string;
  /** "true" only in local dev and tests. Enables POST /api/dev/take without payment. */
  DEV_FAKE_PAY: string;
}
