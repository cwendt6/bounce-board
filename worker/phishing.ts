/**
 * Holds MetaMask's phishing list (eth-phishing-detect) in SQLite so link checks are quick
 * lookups. Kept apart from the board's Durable Object so a refresh (about 2 s, 100k domains)
 * never stalls takeovers. Refreshed by a daily cron, and on first use if empty.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  checkLink,
  type LinkCheck,
  PHISHING_LIST_URL,
  type PhishingList,
  type PhishingLookup,
} from "./links";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS black (d TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS white (d TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export class PhishingListStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private meta(k: string): string | null {
    return (
      this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray()[0]?.v ?? null
    );
  }

  /** Replace the stored list. Exposed for tests; production calls refresh(). */
  load(list: PhishingList): number {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM black");
      this.sql.exec("DELETE FROM white");
      for (const d of list.blacklist)
        this.sql.exec("INSERT OR IGNORE INTO black VALUES (?)", d.toLowerCase());
      for (const d of list.whitelist)
        this.sql.exec("INSERT OR IGNORE INTO white VALUES (?)", d.toLowerCase());
      this.sql.exec(
        "INSERT OR REPLACE INTO meta VALUES ('fuzzy', ?), ('tolerance', ?), ('refreshed_at', ?)",
        JSON.stringify(list.fuzzylist ?? []),
        String(list.tolerance ?? 1),
        String(Date.now()),
      );
    });
    return list.blacklist.length;
  }

  async refresh(): Promise<number> {
    const res = await fetch(this.env.PHISHING_LIST_URL ?? PHISHING_LIST_URL, {
      headers: { "User-Agent": "bounce-board" },
    });
    if (!res.ok) throw new Error(`phishing list ${res.status}`);
    const list = (await res.json()) as PhishingList;
    if (!Array.isArray(list.blacklist) || list.blacklist.length < 1000) {
      throw new Error("phishing list looks wrong; keeping the old copy");
    }
    return this.load(list);
  }

  private lookup(): PhishingLookup | null {
    if (!this.meta("refreshed_at")) return null;
    const inList = (table: string, domains: string[]) =>
      domains.length > 0 &&
      this.sql
        .exec(
          `SELECT 1 FROM ${table} WHERE d IN (${domains.map(() => "?").join(",")}) LIMIT 1`,
          ...domains,
        )
        .toArray().length > 0;
    return {
      isBlacklisted: (d) => inList("black", d),
      isWhitelisted: (d) => inList("white", d),
      fuzzylist: () => ({
        entries: JSON.parse(this.meta("fuzzy") ?? "[]") as string[],
        tolerance: Number(this.meta("tolerance") ?? 1),
      }),
    };
  }

  /** Check a link. Loads the list on first use; without a list, only the cheap rules apply. */
  async check(link: string): Promise<LinkCheck> {
    if (!this.meta("refreshed_at")) {
      try {
        await this.refresh();
      } catch (e) {
        console.error("phishing list unavailable", e);
      }
    }
    return checkLink(link, this.lookup());
  }

  status(): { domains: number; refreshedAt: number | null } {
    const n = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM black").one().n;
    const at = this.meta("refreshed_at");
    return { domains: n, refreshedAt: at ? Number(at) : null };
  }
}
