import type { Board } from "./board";

export interface Env {
  BOARD: DurableObjectNamespace<Board>;
  ASSETS: Fetcher;
  PRICE_USD: string;
  /** "true" only in local dev and tests. Enables POST /api/dev/take without payment. */
  DEV_FAKE_PAY: string;
}
