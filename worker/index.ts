import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { Hono } from "hono";
import { Board } from "./board";
import { validateCard } from "./card";
import type { Env } from "./env";
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
  if (!result.ok) return c.json({ errors: result.errors }, 400);
  const snapshot = await board(c.env).enqueue({
    id: crypto.randomUUID(),
    paidAtMs: Date.now(),
    card: result.card,
  });
  return c.json(snapshot, 201);
});

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
  if (result.status === 402) {
    c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(result.body));
    c.header("Cache-Control", "no-store");
    return c.json(result.body, 402);
  }

  // Settled. From here a failure means we have the money and no takeover: log it loudly.
  try {
    const r = await board(c.env).enqueuePaid(result.sale, result.card);
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
