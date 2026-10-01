/**
 * Exact fixed-window rate limits in one SQLite Durable Object.
 * Keys are opaque strings; callers hash IPs before passing them in.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export interface LimitResult {
  ok: boolean;
  /** Seconds until the window resets (only meaningful when !ok). */
  retryAfter: number;
}

export interface Rule {
  limit: number;
  windowMs: number;
}

export const RULES = {
  /** Price quotes and take attempts per IP (each one runs AI moderation). */
  takePerIp: { limit: 20, windowMs: 10 * 60_000 },
  /** Paid takeovers per paying wallet. */
  paidPerWallet: { limit: 10, windowMs: 60 * 60_000 },
  /** The same listing (holder key) at most this often. */
  paidPerCard: { limit: 3, windowMs: 60 * 60_000 },
  /** Reports per IP. */
  reportPerIp: { limit: 10, windowMs: 60 * 60_000 },
} satisfies Record<string, Rule>;

/** Pure window math, shared by the Durable Object and tests. */
export function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

export class RateLimiter extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (key TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (key, win))",
    );
  }

  /** Count one hit for `key`; refuses (without counting) once the window is full. */
  hit(key: string, rule: Rule, now = Date.now()): LimitResult {
    const win = windowStart(now, rule.windowMs);
    const n =
      this.sql
        .exec<{ n: number }>("SELECT n FROM hits WHERE key = ? AND win = ?", key, win)
        .toArray()[0]?.n ?? 0;
    if (n >= rule.limit)
      return { ok: false, retryAfter: Math.ceil((win + rule.windowMs - now) / 1000) };
    this.sql.exec(
      "INSERT INTO hits (key, win, n) VALUES (?, ?, 1) ON CONFLICT (key, win) DO UPDATE SET n = n + 1",
      key,
      win,
    );
    // Keep the table small: drop windows older than a day now and then.
    if (Math.random() < 0.01) this.sql.exec("DELETE FROM hits WHERE win < ?", now - 86_400_000);
    return { ok: true, retryAfter: 0 };
  }
}
