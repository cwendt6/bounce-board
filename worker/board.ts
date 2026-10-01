/**
 * The board: one Durable Object holds the queue, the clock and every connected viewer.
 *
 * State lives in the object's SQLite storage. Every change runs the pure queue rules in
 * src/core/queue.ts, persists the resulting events, schedules an alarm for the next
 * handover, and pushes a fresh snapshot to all WebSockets.
 */
import { DurableObject } from "cloudflare:workers";
import { holderKey, holderLabel } from "../src/core/leaderboard";
import {
  advance,
  type BoardState,
  estimatedStarts,
  type Pending,
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

  snapshot(): Snapshot {
    const state = this.load();
    const est = estimatedStarts(state);
    const finished = this.sql
      .exec<Row>("SELECT * FROM takeovers WHERE status = 'finished' ORDER BY end_ms DESC")
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
    if (state.current) holders.add(holderKey(state.current.card));

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
      stats: { takeovers: finished.length + (state.current ? 1 : 0), uniqueHolders: holders.size },
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
