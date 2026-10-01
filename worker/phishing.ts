/**
 * Holds MetaMask's phishing list (eth-phishing-detect) for link checks.
 *
 * Durable Objects on the free plan allow 100,000 SQLite rows written per day (deletes and
 * index entries count), and the list has about 100k domains. So the list is stored as a few
 * large text chunks, not one row per domain, and lookups use an in-memory Set built from those
 * chunks. A refresh writes about 5 rows, and nothing at all when the list hasn't changed.
 * Kept apart from the board's Durable Object so a refresh never stalls takeovers.
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

// SQLite rows in Durable Objects are capped at 2 MB; stay well under it.
const CHUNK_CHARS = 900_000;

// Integer primary keys only: a TEXT key means a separate index, and index entries count as
// rows written too. All metadata lives in one JSON row.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS list_chunks (i INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS list_info (i INTEGER PRIMARY KEY CHECK (i = 0), json TEXT NOT NULL);
`;

interface Info {
  hash: string;
  white: string[];
  fuzzy: string[];
  tolerance: number;
  refreshedAt: number;
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class PhishingListStore extends DurableObject<Env> {
  private sql: SqlStorage;
  private black: Set<string> | null = null;
  private white: Set<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  private info(): Info | null {
    const row = this.sql
      .exec<{ json: string }>("SELECT json FROM list_info WHERE i = 0")
      .toArray()[0];
    return row ? (JSON.parse(row.json) as Info) : null;
  }

  /**
   * Replace the stored list. Returns the domain count and how many SQLite rows were written,
   * so tests (and logs) can confirm a refresh stays tiny.
   */
  async load(list: PhishingList): Promise<{ domains: number; rowsWritten: number }> {
    const black = [...new Set(list.blacklist.map((d) => d.toLowerCase()))].sort();
    const text = black.join("\n");
    const white = (list.whitelist ?? []).map((d) => d.toLowerCase());
    const fuzzy = list.fuzzylist ?? [];
    const tolerance = list.tolerance ?? 1;
    const hash = await sha256(JSON.stringify([text, white, fuzzy, tolerance]));
    // Unchanged list: write nothing.
    if (hash === this.info()?.hash) return { domains: black.length, rowsWritten: 0 };

    let rows = 0;
    this.ctx.storage.transactionSync(() => {
      rows += this.sql.exec("DELETE FROM list_chunks").rowsWritten;
      for (let i = 0, n = 0; i < text.length; i += CHUNK_CHARS, n++) {
        rows += this.sql.exec(
          "INSERT INTO list_chunks (i, data) VALUES (?, ?)",
          n,
          text.slice(i, i + CHUNK_CHARS),
        ).rowsWritten;
      }
      const info: Info = { hash, white, fuzzy, tolerance, refreshedAt: Date.now() };
      rows += this.sql.exec(
        "INSERT INTO list_info (i, json) VALUES (0, ?) ON CONFLICT (i) DO UPDATE SET json = excluded.json",
        JSON.stringify(info),
      ).rowsWritten;
    });
    this.black = null;
    this.white = null;
    return { domains: black.length, rowsWritten: rows };
  }

  async refresh(): Promise<{ domains: number; rowsWritten: number }> {
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

  /** Build the in-memory sets from the stored chunks (once per object lifetime). */
  private sets(): { black: Set<string>; white: Set<string> } | null {
    if (this.black && this.white) return { black: this.black, white: this.white };
    const info = this.info();
    if (!info) return null;
    const text = this.sql
      .exec<{ data: string }>("SELECT data FROM list_chunks ORDER BY i")
      .toArray()
      .map((r) => r.data)
      .join("");
    this.black = new Set(text ? text.split("\n") : []);
    this.white = new Set(info.white);
    return { black: this.black, white: this.white };
  }

  private lookup(): PhishingLookup | null {
    const s = this.sets();
    const info = this.info();
    if (!s || !info) return null;
    return {
      isBlacklisted: (d) => d.some((x) => s.black.has(x)),
      isWhitelisted: (d) => d.some((x) => s.white.has(x)),
      fuzzylist: () => ({ entries: info.fuzzy, tolerance: info.tolerance }),
    };
  }

  /** Check a link. Loads the list on first use; without a list, only the cheap rules apply. */
  async check(link: string): Promise<LinkCheck> {
    if (!this.info()) {
      try {
        await this.refresh();
      } catch (e) {
        console.error("phishing list unavailable", e);
      }
    }
    return checkLink(link, this.lookup());
  }

  status(): { domains: number; refreshedAt: number | null } {
    return { domains: this.sets()?.black.size ?? 0, refreshedAt: this.info()?.refreshedAt ?? null };
  }
}
