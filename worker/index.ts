import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { Hono } from "hono";
import { Board } from "./board";
import { type BoardCard, validateCard } from "./card";
import type { Env } from "./env";
import { parseLogo } from "./logo";
import {
  allowAll,
  type Moderator,
  type Verdict,
  verdictKey,
  WorkersAiModerator,
} from "./moderation";
import { type Gateway, type PayConfig, processTake, salesCsv, X402Gateway } from "./pay";

const app = new Hono<{ Bindings: Env }>();

/** There is one board, so one Durable Object instance. */
const board = (env: Env) => env.BOARD.get(env.BOARD.idFromName("main"));

app.get("/api/state", async (c) => c.json(await board(c.env).snapshot()));

app.get("/api/live", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected a WebSocket upgrade", 426);
  // The Durable Object answers the upgrade and keeps the socket.
  const res = await board(c.env).fetch(c.req.raw);
  return res as unknown as Response;
});

// Local dev and tests only: queue a takeover with no payment.
app.post("/api/dev/take", async (c) => {
  if (c.env.DEV_FAKE_PAY !== "true") return c.notFound();
  const body = await c.req.json().catch(() => null);
  const result = validateCard(body);
  const logo = parseLogo((body as { logo?: unknown } | null)?.logo);
  if (!result.ok || !logo.ok) {
    const errors = [...(result.ok ? [] : result.errors), ...(logo.ok ? [] : [logo.error])];
    return c.json({ errors }, 400);
  }
  const verdict = await moderate(c.env, result.card, logo.logo ? String(body.logo) : null);
  if (verdict.ok === "unavailable")
    return c.json({ error: "Moderation is unavailable right now." }, 503);
  if (!verdict.ok) return c.json({ errors: [`rejected: ${verdict.reason}`] }, 400);
  const snapshot = await board(c.env).enqueue(
    { id: crypto.randomUUID(), paidAtMs: Date.now(), card: result.card },
    logo.logo,
  );
  return c.json(snapshot, 201);
});

function moderator(env: Env): Moderator {
  if (env.MODERATION === "off") return allowAll;
  if (!env.AI) return { check: async () => ({ ok: "unavailable" }) };
  return new WorkersAiModerator(env.AI);
}

/** Moderate with a 24 h cache in the Durable Object. "Unavailable" is never cached. */
async function moderate(env: Env, card: BoardCard, logoDataUrl: string | null): Promise<Verdict> {
  const key = await verdictKey(card, logoDataUrl);
  const b = board(env);
  const cached = await b.verdict(key);
  if (cached)
    return cached.ok ? { ok: true } : { ok: false, reason: cached.reason ?? "content flagged" };
  const v = await moderator(env).check(card, logoDataUrl);
  if (v.ok === true) await b.saveVerdict(key, true, null);
  else if (v.ok === false) await b.saveVerdict(key, false, v.reason);
  return v;
}

// One gateway per isolate and config, so the facilitator handshake happens once.
let cached: { key: string; gateway: Gateway } | null = null;
function gatewayFor(cfg: PayConfig): Gateway {
  const key = JSON.stringify(cfg);
  if (cached?.key !== key) cached = { key, gateway: new X402Gateway(cfg) };
  return cached.gateway;
}

/**
 * Take the box. Send the card as JSON. Without a PAYMENT-SIGNATURE header this answers 402
 * with the price in the PAYMENT-REQUIRED header (x402 v2) and body. With a valid payment it
 * settles, records the sale, queues the takeover and answers 201 with the board snapshot.
 */
app.post("/api/take", async (c) => {
  const payTo = c.env.PAY_TO_ADDRESS;
  if (!payTo) return c.json({ error: "payments are not configured" }, 503);
  const cfg: PayConfig = {
    network: c.env.X402_NETWORK,
    payTo,
    priceUsd: c.env.PRICE_USD,
    facilitatorUrl: c.env.FACILITATOR_URL,
  };
  const body = await c.req.json().catch(() => null);
  let result: Awaited<ReturnType<typeof processTake>>;
  try {
    result = await processTake(
      {
        gateway: gatewayFor(cfg),
        cfg,
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
        decodePayment: decodePaymentSignatureHeader,
        moderate: (card, logo) => moderate(c.env, card, logo),
      },
      body,
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? null,
      new URL("/api/take", c.req.url).toString(),
    );
  } catch (e) {
    console.error("take failed", e);
    return c.json({ error: "payment service unavailable, try again" }, 502);
  }

  if (result.status === 400) return c.json(result.body, 400);
  if (result.status === 503) return c.json(result.body, 503);
  if (result.status === 402) {
    c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(result.body));
    c.header("Cache-Control", "no-store");
    return c.json(result.body, 402);
  }

  // Settled. From here a failure means we have the money and no takeover: log it loudly.
  try {
    const r = await board(c.env).enqueuePaid(result.sale, result.card, result.logo);
    c.header("PAYMENT-RESPONSE", encodePaymentResponseHeader(result.settle));
    return c.json({ duplicate: r.duplicate, tx: result.sale.tx_hash, snapshot: r.snapshot }, 201);
  } catch (e) {
    console.error("SETTLED BUT NOT QUEUED", result.sale.tx_hash, e);
    return c.json(
      { error: "payment received but the takeover was not queued", tx: result.sale.tx_hash },
      500,
    );
  }
});

// Logos are served as images only: exact type, no sniffing, no scripts, cached forever
// (a logo never changes for a given takeover id).
app.get("/api/logo/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.notFound();
  const logo = await board(c.env).logo(id);
  if (!logo) return c.notFound();
  return c.body(logo.data, 200, {
    "Content-Type": logo.mime,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// Sales log for bookkeeping (ledger import). Hidden unless ADMIN_TOKEN is set.
app.get("/api/admin/sales.csv", async (c) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return c.notFound();
  const auth = c.req.header("Authorization") ?? "";
  if (!sameToken(auth, `Bearer ${token}`)) return c.json({ error: "unauthorized" }, 401);
  const csv = salesCsv(await board(c.env).sales());
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="bounce-board-sales.csv"',
    "Cache-Control": "no-store",
  });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default app;
export { Board };
