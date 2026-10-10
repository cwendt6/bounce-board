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
  /** Uncached AI moderation runs per verified payer (wallet), per day. */
  aiPerPayer: { limit: 5, windowMs: 86_400_000 },
  /** Uncached AI moderation runs per IP bucket, per day. */
  aiPerIp: { limit: 10, windowMs: 86_400_000 },
  /** Reports per IP. */
  reportPerIp: { limit: 10, windowMs: 60 * 60_000 },
} satisfies Record<string, Rule>;

/** Uncached AI moderation runs per day, account-wide (Workers AI free plan: 10,000 neurons/day,
 *  about 45 per run). Override with the AI_DAILY_CAP var after upgrading the plan. */
export const DEFAULT_AI_DAILY_CAP = 180;
export const aiDailyRule = (cap: number): Rule => ({ limit: cap, windowMs: 86_400_000 });

/**
 * The rate-limit bucket for a client IP: IPv4 as is, IPv6 by its /64 prefix (one household or
 * one server usually controls a whole /64, so per-address buckets are trivially bypassed).
 * Pass 48 for a coarser bucket (one site or VPS allocation), used for the AI quota.
 */
export function ipBucket(ip: string, prefix: 48 | 64 = 64): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(":")) return raw || "unknown";
  const [head, tail] = raw.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups =
    tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups
    .slice(0, prefix / 16)
    .map((g) => (g || "0").replace(/^0+(?=.)/, ""))
    .join(":")}::/${prefix}`;
}

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
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, until INTEGER NOT NULL) WITHOUT ROWID",
    );
  }

  /**
   * Claim `key` until `until` (ms). true for the first caller, false if it's already claimed.
   * Used so one signed payment authorization is only ever sent to settle once, across every
   * Worker isolate.
   */
  claim(key: string, until: number, now = Date.now()): boolean {
    if (Math.random() < 0.01) this.sql.exec("DELETE FROM claims WHERE until < ?", now);
    const held = this.sql
      .exec<{ until: number }>("SELECT until FROM claims WHERE key = ?", key)
      .toArray()[0];
    if (held && held.until >= now) return false;
    this.sql.exec("INSERT OR REPLACE INTO claims (key, until) VALUES (?, ?)", key, until);
    return true;
  }

  private count(key: string, win: number): number {
    return (
      this.sql
        .exec<{ n: number }>("SELECT n FROM hits WHERE key = ? AND win = ?", key, win)
        .toArray()[0]?.n ?? 0
    );
  }

  /** Would one more hit fit? Counts nothing. */
  peek(key: string, rule: Rule, now = Date.now()): LimitResult {
    const win = windowStart(now, rule.windowMs);
    if (this.count(key, win) >= rule.limit) {
      return { ok: false, retryAfter: Math.ceil((win + rule.windowMs - now) / 1000) };
    }
    return { ok: true, retryAfter: 0 };
  }

  /**
   * Count one hit on every key, but only if every key has room (all or nothing). Returns the
   * first refusal otherwise. Used where several limits guard one action (for example a
   * wallet, a listing, or several AI quotas).
   */
  hitAll(entries: { key: string; rule: Rule }[], now = Date.now()): LimitResult {
    for (const e of entries) {
      const r = this.peek(e.key, e.rule, now);
      if (!r.ok) return r;
    }
    for (const e of entries) this.hit(e.key, e.rule, now);
    return { ok: true, retryAfter: 0 };
  }

  /** Undo one hitAll (same entries, same `now`), for an action that failed after counting. */
  unhitAll(entries: { key: string; rule: Rule }[], now: number): void {
    for (const e of entries) {
      this.sql.exec(
        "UPDATE hits SET n = n - 1 WHERE key = ? AND win = ? AND n > 0",
        e.key,
        windowStart(now, e.rule.windowMs),
      );
    }
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
