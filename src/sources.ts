/**
 * Data sources for the page.
 * - Live: the Worker's /api/state plus a WebSocket for snapshots and clock sync.
 * - Demo: a fixed rotation of invented holders on the wall clock (GitHub Pages preview).
 */
import { holderKey, holderLabel, mergeCornerClub, mergeLongest } from "./core/leaderboard";
import { cornerHits, initialPhase } from "./core/motion";
import { DEMO_REIGN_SECONDS, reignAt, upcoming } from "./core/schedule";
import { DEMO_CORNER_CLUB, DEMO_HOLDERS, DEMO_LONGEST_REIGN, DEMO_STATS } from "./fake-data";
import type { CardView, View } from "./view";

export interface Source {
  view(): View;
}

// ---------- demo ----------

export const demoSource: Source = {
  view() {
    const now = Date.now();
    const n = DEMO_HOLDERS.length;
    const cur = reignAt(now, n);
    const recent = [];
    for (let i = 1; i <= 10; i++) {
      const r = reignAt(cur.startMs - i * DEMO_REIGN_SECONDS * 1000, n);
      const heldMs = r.endMs - r.startMs;
      recent.push({
        card: DEMO_HOLDERS[r.holder],
        heldMs,
        corners: cornerHits(initialPhase(r.seed), 0, heldMs / 1000).length,
      });
    }
    return {
      mode: "demo",
      now,
      current: {
        id: `demo-${cur.startMs}`,
        card: DEMO_HOLDERS[cur.holder],
        startMs: cur.startMs,
        seed: cur.seed,
        endMs: cur.endMs,
      },
      queue: upcoming(now, n, 4).map((r) => ({ card: DEMO_HOLDERS[r.holder], startMs: r.startMs })),
      recent,
      cornerClub: DEMO_CORNER_CLUB.map((c) => ({
        label: c.ticker ? `$${c.ticker}` : c.name,
        corners: c.corners,
      })),
      longest: DEMO_LONGEST_REIGN.map((c) => ({
        label: c.ticker ? `$${c.ticker}` : c.name,
        ms: c.seconds * 1000,
      })),
      stats: DEMO_STATS,
    };
  },
};

// ---------- live ----------

/** Subset of the Worker's Snapshot that the page uses (see worker/board.ts). */
export interface Snapshot {
  serverNow: number;
  current: { id: string; card: CardView; startMs: number; seed: number } | null;
  queue: { id: string; card: CardView; estStartMs: number }[];
  recent: { id: string; card: CardView; startMs: number; endMs: number; corners: number }[];
  cornerClub: { key: string; label: string; corners: number }[];
  currentPriorCorners: number;
  longest: { label: string; ms: number }[];
  stats: { takeovers: number; uniqueHolders: number };
}

export function snapshotToView(s: Snapshot, now: number): View {
  const live = s.current
    ? {
        key: holderKey(s.current.card),
        label: holderLabel(s.current.card),
        startMs: s.current.startMs,
        seed: s.current.seed,
        priorCorners: s.currentPriorCorners,
      }
    : null;
  return {
    mode: "live",
    now,
    current: s.current ? { ...s.current, endMs: null } : null,
    queue: s.queue.map((q) => ({ card: q.card, startMs: q.estStartMs })),
    recent: s.recent.map((r) => ({
      card: r.card,
      heldMs: r.endMs - r.startMs,
      corners: r.corners,
    })),
    cornerClub: mergeCornerClub(s.cornerClub, live, now).map(({ label, corners }) => ({
      label,
      corners,
    })),
    longest: mergeLongest(s.longest, live, now),
    stats: s.stats,
  };
}

/**
 * Clock offset from ping/pong: offset = serverNow - midpoint(send, receive).
 * Keeps the sample with the smallest round trip, which is the most accurate.
 */
export class ClockSync {
  private best = { rtt: Number.POSITIVE_INFINITY, offset: 0 };

  sample(t0: number, t1: number, serverNow: number): void {
    const rtt = t1 - t0;
    if (rtt < 0 || rtt > this.best.rtt) return;
    this.best = { rtt, offset: serverNow - (t0 + t1) / 2 };
  }

  seed(serverNow: number, localNow: number): void {
    if (this.best.rtt === Number.POSITIVE_INFINITY) this.best.offset = serverNow - localNow;
  }

  get offset(): number {
    return this.best.offset;
  }
}

export class LiveSource implements Source {
  private snapshot: Snapshot;
  private clock = new ClockSync();
  private retry = 1000;

  constructor(
    initial: Snapshot,
    private readonly wsUrl: string,
    private readonly onChange: () => void,
  ) {
    this.snapshot = initial;
    this.clock.seed(initial.serverNow, Date.now());
    this.connect();
  }

  view(): View {
    return snapshotToView(this.snapshot, Date.now() + this.clock.offset);
  }

  private connect(): void {
    const ws = new WebSocket(this.wsUrl);
    let pinger = 0;
    ws.addEventListener("open", () => {
      this.retry = 1000;
      const ping = () => {
        // Pings are scheduled ahead; skip them if the socket closed in the meantime.
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping", t0: Date.now() }));
      };
      for (let i = 0; i < 5; i++) window.setTimeout(ping, i * 300);
      pinger = window.setInterval(ping, 30_000);
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "snapshot") {
        this.snapshot = msg.snapshot;
        this.onChange();
      } else if (msg.type === "pong") {
        this.clock.sample(msg.t0, Date.now(), msg.serverNow);
      }
    });
    ws.addEventListener("close", () => {
      window.clearInterval(pinger);
      window.setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30_000);
    });
  }
}

/** Use the live server when this page is served by the Worker; otherwise the demo. */
export async function pickSource(onChange: () => void): Promise<Source> {
  const base = import.meta.env.BASE_URL;
  try {
    const res = await fetch(`${base}api/state`, { headers: { Accept: "application/json" } });
    if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
      const snap = (await res.json()) as Snapshot;
      const wsUrl = new URL(`${base}api/live`, window.location.href);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      return new LiveSource(snap, wsUrl.toString(), onChange);
    }
  } catch {
    // no server: fall back to the demo
  }
  return demoSource;
}
