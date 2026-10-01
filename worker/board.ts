/**
 * The board: one Durable Object holds the queue, the clock and every connected viewer.
 *
 * State lives in the object's SQLite storage. Every change runs the pure queue rules in
 * src/core/queue.ts, persists the resulting events, schedules an alarm for the next
 * handover, and pushes a fresh snapshot to all WebSockets.
 */
import { DurableObject } from "cloudflare:workers";
import { holderKey, holderLabel } from "../src/core/leaderboard";
import { cornerHits, initialPhase } from "../src/core/motion";
import {
  advance,
  type BoardState,
  estimatedStarts,
  type Pending,
  seedFor,
  type Takeover,
} from "../src/core/queue";
import type { BoardCard } from "./card";
import type { Env } from "./env";
import type { Logo } from "./logo";
import type { Sale } from "./pay";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS takeovers (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'current', 'finished')),
  paid_at INTEGER NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  seed INTEGER,
  corners INTEGER,
  card TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS takeovers_status ON takeovers (status, paid_at);
-- DexScreener token-check results, cached 10 minutes (their API allows 60 req/min).
CREATE TABLE IF NOT EXISTS token_checks (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  at INTEGER NOT NULL
);
-- Moderation verdicts by card hash, so the paid retry of a card doesn't re-run the models.
CREATE TABLE IF NOT EXISTS verdicts (
  key TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL
);
-- Viewer reports. Reporters are stored only as a hash, to drop duplicate reports.
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  takeover_id TEXT NOT NULL,
  category TEXT NOT NULL,
  note TEXT NOT NULL,
  reporter TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE (takeover_id, reporter)
);
CREATE TABLE IF NOT EXISTS logos (
  takeover_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
  data BLOB NOT NULL
);
-- One row per settled payment. Same columns as the CSV export for the ledger.
CREATE TABLE IF NOT EXISTS sales (
  id TEXT PRIMARY KEY,
  takeover_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  chain TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  usd_value TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  receiver TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  facilitator TEXT NOT NULL
);
`;

interface Row extends Record<string, SqlStorageValue> {
  id: string;
  status: string;
  paid_at: number;
  start_ms: number | null;
  end_ms: number | null;
  seed: number | null;
  corners: number | null;
  card: string;
}

export interface Reign {
  id: string;
  card: BoardCard;
  startMs: number;
  endMs: number;
  corners: number;
}

export interface Snapshot {
  serverNow: number;
  current: Takeover<BoardCard> | null;
  queue: { id: string; card: BoardCard; paidAtMs: number; estStartMs: number }[];
  recent: Reign[];
  /** Finished reigns only, top 20. Pages merge in the live reign (src/core/leaderboard.ts). */
  cornerClub: { key: string; label: string; corners: number }[];
  /** Corners the current holder earned in earlier, finished reigns. */
  currentPriorCorners: number;
  /** Finished reigns only, top 5. */
  longest: { label: string; ms: number }[];
  stats: { takeovers: number; uniqueHolders: number };
}

export class Board extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    // Columns added after launch. SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
    const cols = new Set(
      this.sql
        .exec<{ name: string }>("PRAGMA table_info(takeovers)")
        .toArray()
        .map((c) => c.name),
    );
    if (!cols.has("removed")) {
      this.sql.exec("ALTER TABLE takeovers ADD COLUMN removed INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.has("restored")) {
      this.sql.exec("ALTER TABLE takeovers ADD COLUMN restored INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.has("removed_reason"))
      this.sql.exec("ALTER TABLE takeovers ADD COLUMN removed_reason TEXT");
  }

  // ---------- state ----------

  private rows(status: string): Row[] {
    return this.sql
      .exec<Row>("SELECT * FROM takeovers WHERE status = ? ORDER BY paid_at, id", status)
      .toArray();
  }

  private load(): BoardState<BoardCard> {
    const cur = this.rows("current")[0];
    return {
      current: cur
        ? {
            id: cur.id,
            paidAtMs: cur.paid_at,
            startMs: cur.start_ms as number,
            seed: cur.seed as number,
            card: JSON.parse(cur.card),
          }
        : null,
      queue: this.rows("queued").map((r) => ({
        id: r.id,
        paidAtMs: r.paid_at,
        card: JSON.parse(r.card),
      })),
    };
  }

  /** Apply due handovers, persist them, reschedule the alarm, and notify viewers. */
  private async step(): Promise<void> {
    const { events, wakeAtMs } = advance(this.load(), Date.now());
    for (const e of events) {
      if (e.type === "finished") {
        this.sql.exec(
          "UPDATE takeovers SET status = 'finished', end_ms = ?, corners = ? WHERE id = ?",
          e.finished.endMs,
          e.finished.corners,
          e.finished.id,
        );
      } else {
        this.sql.exec(
          "UPDATE takeovers SET status = 'current', start_ms = ?, seed = ? WHERE id = ?",
          e.takeover.startMs,
          e.takeover.seed,
          e.takeover.id,
        );
      }
    }
    if (wakeAtMs === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(wakeAtMs);
    this.broadcast();
  }

  async alarm(): Promise<void> {
    await this.step();
  }

  // ---------- RPC ----------

  /** Queue a paid takeover. Called only after payment has settled (or in local dev mode). */
  async enqueue(p: Pending<BoardCard>, logo: Logo | null = null): Promise<Snapshot> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO takeovers (id, status, paid_at, card) VALUES (?, 'queued', ?, ?)",
        p.id,
        p.paidAtMs,
        JSON.stringify(this.withLogo(p.id, p.card, logo)),
      );
    });
    await this.step();
    return this.snapshot();
  }

  /**
   * Record a settled sale and queue its takeover in one transaction, so a sale never exists
   * without its takeover. A repeated tx hash is a no-op and returns duplicate: true.
   */
  /** Store the logo (if any) and point the card at it. Call inside a transaction. */
  private withLogo(id: string, card: BoardCard, logo: Logo | null): BoardCard {
    const { logo: _ignored, ...clean } = card;
    if (!logo) return clean;
    this.sql.exec(
      "INSERT INTO logos (takeover_id, mime, data) VALUES (?, ?, ?)",
      id,
      logo.mime,
      logo.bytes,
    );
    return { ...clean, logo: `/api/logo/${id}` };
  }

  /** A cached token check, if it is less than 10 minutes old. */
  tokenCheck(key: string): string | null {
    const row = this.sql
      .exec<{ result: string; at: number }>(
        "SELECT result, at FROM token_checks WHERE key = ?",
        key,
      )
      .toArray()[0];
    return row && Date.now() - row.at < 600_000 ? row.result : null;
  }

  saveTokenCheck(key: string, result: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO token_checks (key, result, at) VALUES (?, ?, ?)",
      key,
      result,
      Date.now(),
    );
  }

  /** A cached moderation verdict, if it is less than a day old. */
  verdict(key: string): { ok: boolean; reason: string | null } | null {
    const row = this.sql
      .exec<{ ok: number; reason: string | null; at: number }>(
        "SELECT ok, reason, at FROM verdicts WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (!row || Date.now() - row.at > 86_400_000) return null;
    return { ok: row.ok === 1, reason: row.reason };
  }

  saveVerdict(key: string, ok: boolean, reason: string | null): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO verdicts (key, ok, reason, at) VALUES (?, ?, ?, ?)",
      key,
      ok ? 1 : 0,
      reason,
      Date.now(),
    );
  }

  logo(id: string): { mime: string; data: ArrayBuffer } | null {
    const row = this.sql
      .exec<{ mime: string; data: ArrayBuffer }>(
        "SELECT mime, data FROM logos WHERE takeover_id = ?",
        id,
      )
      .toArray()[0];
    return row ? { mime: row.mime, data: row.data } : null;
  }

  async enqueuePaid(
    sale: Sale,
    card: BoardCard,
    logo: Logo | null = null,
  ): Promise<{ duplicate: boolean; snapshot: Snapshot }> {
    const seen = this.sql.exec("SELECT 1 FROM sales WHERE tx_hash = ?", sale.tx_hash).toArray();
    if (seen.length) return { duplicate: true, snapshot: this.snapshot() };
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO sales (id, takeover_id, network, chain, asset, amount, usd_value, tx_hash,
           payer, receiver, received_at, facilitator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sale.id,
        sale.takeover_id,
        sale.network,
        sale.chain,
        sale.asset,
        sale.amount,
        sale.usd_value,
        sale.tx_hash,
        sale.payer,
        sale.receiver,
        sale.received_at,
        sale.facilitator,
      );
      this.sql.exec(
        "INSERT INTO takeovers (id, status, paid_at, card) VALUES (?, 'queued', ?, ?)",
        sale.takeover_id,
        sale.received_at,
        JSON.stringify(this.withLogo(sale.takeover_id, card, logo)),
      );
    });
    await this.step();
    return { duplicate: false, snapshot: this.snapshot() };
  }

  /** All sales, oldest first, for the CSV export. */
  sales(): Sale[] {
    return this.sql
      .exec<Sale & Record<string, SqlStorageValue>>("SELECT * FROM sales ORDER BY received_at, id")
      .toArray()
      .map((r) => ({ ...r }) as Sale);
  }

  private isRestored(id: string): boolean {
    return (
      this.sql
        .exec<{ restored: number }>("SELECT restored FROM takeovers WHERE id = ?", id)
        .toArray()[0]?.restored === 1
    );
  }

  // ---------- reports ----------

  /** Record a viewer report. One report per reporter per takeover; returns false if unknown id. */
  report(takeoverId: string, category: string, note: string, reporter: string): boolean {
    const exists =
      this.sql.exec("SELECT 1 FROM takeovers WHERE id = ?", takeoverId).toArray().length > 0;
    if (!exists) return false;
    this.sql.exec(
      "INSERT OR IGNORE INTO reports (id, takeover_id, category, note, reporter, at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      takeoverId,
      category,
      note,
      reporter,
      Date.now(),
    );
    return true;
  }

  /** Reports grouped by takeover, most reported first, with the card and its status. */
  reports(): {
    takeoverId: string;
    card: BoardCard;
    status: string;
    removed: boolean;
    count: number;
    categories: string[];
    notes: string[];
    lastAt: number;
  }[] {
    const rows = this.sql
      .exec<{
        takeover_id: string;
        category: string;
        note: string;
        at: number;
        card: string;
        status: string;
        removed: number;
      }>(
        `SELECT r.takeover_id, r.category, r.note, r.at, t.card, t.status, t.removed
           FROM reports r JOIN takeovers t ON t.id = r.takeover_id ORDER BY r.at DESC`,
      )
      .toArray();
    const by = new Map<string, ReturnType<Board["reports"]>[number]>();
    for (const r of rows) {
      const e = by.get(r.takeover_id) ?? {
        takeoverId: r.takeover_id,
        card: JSON.parse(r.card) as BoardCard,
        status: r.status,
        removed: r.removed === 1,
        count: 0,
        categories: [],
        notes: [],
        lastAt: r.at,
      };
      e.count++;
      if (!e.categories.includes(r.category)) e.categories.push(r.category);
      if (r.note) e.notes.push(r.note);
      by.set(r.takeover_id, e);
    }
    return [...by.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  }

  // ---------- admin ----------

  /**
   * Kill switch: remove the current holder now. The next queued buyer takes over immediately;
   * with an empty queue, the previous holder's card comes back (marked restored, not counted).
   */
  async kill(reason: string): Promise<Snapshot> {
    const now = Date.now();
    const cur = this.load().current;
    if (!cur) return this.snapshot();
    this.ctx.storage.transactionSync(() => {
      const corners = cornerHits(initialPhase(cur.seed), 0, (now - cur.startMs) / 1000).length;
      this.sql.exec(
        `UPDATE takeovers SET status = 'finished', end_ms = ?, corners = ?, removed = 1, removed_reason = ?
          WHERE id = ?`,
        now,
        corners,
        reason,
        cur.id,
      );
      const next = this.rows("queued")[0];
      if (next) {
        this.sql.exec(
          "UPDATE takeovers SET status = 'current', start_ms = ?, seed = ? WHERE id = ?",
          now,
          seedFor(next.id),
          next.id,
        );
        return;
      }
      const prev = this.sql
        .exec<{ card: string }>(
          `SELECT card FROM takeovers WHERE status = 'finished' AND removed = 0 AND id != ?
            ORDER BY end_ms DESC LIMIT 1`,
          cur.id,
        )
        .toArray()[0];
      if (prev) {
        const id = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO takeovers (id, status, paid_at, start_ms, seed, card, restored)
           VALUES (?, 'current', ?, ?, ?, ?, 1)`,
          id,
          now,
          now,
          seedFor(id),
          prev.card,
        );
      }
    });
    await this.step();
    return this.snapshot();
  }

  /** Remove a takeover: the current one (same as kill) or a queued one. */
  async remove(id: string, reason: string): Promise<{ removed: boolean; snapshot: Snapshot }> {
    const cur = this.load().current;
    if (cur?.id === id) return { removed: true, snapshot: await this.kill(reason) };
    const now = Date.now();
    const changed = this.sql.exec(
      `UPDATE takeovers SET status = 'finished', start_ms = ?, end_ms = ?, corners = 0, removed = 1,
              removed_reason = ? WHERE id = ? AND status = 'queued'`,
      now,
      now,
      reason,
      id,
    ).rowsWritten;
    await this.step();
    return { removed: changed > 0, snapshot: this.snapshot() };
  }

  snapshot(): Snapshot {
    const state = this.load();
    const est = estimatedStarts(state);
    const finished = this.sql
      .exec<Row>(
        "SELECT * FROM takeovers WHERE status = 'finished' AND removed = 0 AND restored = 0 ORDER BY end_ms DESC",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        card: JSON.parse(r.card) as BoardCard,
        startMs: r.start_ms as number,
        endMs: r.end_ms as number,
        corners: r.corners as number,
      }));

    const corners = new Map<string, { key: string; label: string; corners: number }>();
    const holders = new Set<string>();
    for (const r of finished) {
      holders.add(holderKey(r.card));
      const k = holderKey(r.card);
      const e = corners.get(k) ?? { key: k, label: holderLabel(r.card), corners: 0 };
      e.corners += r.corners;
      corners.set(k, e);
    }
    const curRestored = state.current ? this.isRestored(state.current.id) : false;
    if (state.current && !curRestored) holders.add(holderKey(state.current.card));

    return {
      serverNow: Date.now(),
      current: state.current,
      queue: state.queue.map((p, i) => ({
        id: p.id,
        card: p.card,
        paidAtMs: p.paidAtMs,
        estStartMs: est[i],
      })),
      recent: finished.slice(0, 10),
      cornerClub: [...corners.values()]
        .filter((c) => c.corners > 0)
        .sort((a, b) => b.corners - a.corners)
        .slice(0, 20),
      currentPriorCorners: state.current
        ? (corners.get(holderKey(state.current.card))?.corners ?? 0)
        : 0,
      longest: finished
        .map((r) => ({ label: holderLabel(r.card), ms: r.endMs - r.startMs }))
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5),
      stats: {
        takeovers: finished.length + (state.current && !curRestored ? 1 : 0),
        uniqueHolders: holders.size,
      },
    };
  }

  // ---------- live updates ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", snapshot: this.snapshot() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Clock sync: the client sends {type: "ping", t0} and gets the server time back. */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > 200) return;
    try {
      const msg = JSON.parse(message) as { type?: string; t0?: unknown };
      if (msg.type === "ping" && typeof msg.t0 === "number") {
        ws.send(JSON.stringify({ type: "pong", t0: msg.t0, serverNow: Date.now() }));
      }
    } catch {
      // ignore malformed messages
    }
  }

  private broadcast(): void {
    const msg = JSON.stringify({ type: "snapshot", snapshot: this.snapshot() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // a closed socket; the runtime cleans it up
      }
    }
  }
}
