import { Hono } from "hono";
import { Board } from "./board";
import { validateCard } from "./card";
import type { Env } from "./env";

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

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default app;
export { Board };
