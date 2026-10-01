import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { Hono } from "hono";
import { Board } from "./board";
import { type BoardCard, validateCard } from "./card";
import type { Env } from "./env";
import { checkLink as checkLinkRules, type LinkCheck } from "./links";
import { parseLogo } from "./logo";
import {
  allowAll,
  type Moderator,
  type Verdict,
  verdictKey,
  WorkersAiModerator,
} from "./moderation";
import { type Gateway, type PayConfig, processTake, salesCsv, X402Gateway } from "./pay";
import { PhishingListStore } from "./phishing";
import { checkToken, type TokenCheck } from "./tokens";

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
  const link = await linkCheck(c.env, result.card.link);
  if (!link.ok) return c.json({ errors: [link.reason] }, 400);
  const tok = await tokenCheck(c.env, result.card);
  if (!tok.ok) return c.json({ errors: [`token check: ${tok.reason}`] }, 400);
  const verdict = await moderate(c.env, result.card, logo.logo ? String(body.logo) : null);
  if (verdict.ok === "unavailable")
    return c.json({ error: "Moderation is unavailable right now." }, 503);
  if (!verdict.ok) return c.json({ errors: [`rejected: ${verdict.reason}`] }, 400);
  const snapshot = await board(c.env).enqueue(
    {
      id: crypto.randomUUID(),
      paidAtMs: Date.now(),
      card: result.card.ticker ? { ...result.card, tokenCheck: tok.status } : result.card,
    },
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

const phishing = (env: Env) => env.PHISHING.get(env.PHISHING.idFromName("metamask"));

async function linkCheck(env: Env, link: string): Promise<LinkCheck> {
  if (env.LINK_CHECKS === "off") return checkLinkRules(link, null);
  try {
    return await phishing(env).check(link);
  } catch (e) {
    console.error("link check unavailable", e);
    return checkLinkRules(link, null);
  }
}

/** DexScreener token checks with a 10-minute cache in the Durable Object. */
async function tokenCheck(env: Env, card: BoardCard): Promise<TokenCheck> {
  if (env.TOKEN_CHECKS === "off" || !card.ticker) return { ok: true, status: "verified" };
  const key = `${card.chain}:${card.contract}:${card.ticker}`;
  const b = board(env);
  const cached = await b.tokenCheck(key);
  if (cached) return JSON.parse(cached) as TokenCheck;
  const r = await checkToken(card, (url) =>
    fetch(url, { headers: { Accept: "application/json", "User-Agent": "bounce-board" } }),
  );
  // "unverified" means DexScreener was unreachable: don't cache that, try again next time.
  if (!(r.ok && r.status === "unverified")) await b.saveTokenCheck(key, JSON.stringify(r));
  return r;
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
        checkToken: (card) => tokenCheck(c.env, card),
        checkLink: (link) => linkCheck(c.env, link),
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

export const REPORT_CATEGORIES = ["scam", "nsfw", "impersonation", "hate", "other"] as const;

/** Anyone can report a takeover. Reporters are stored only as a hash (dedupe, no raw IPs). */
app.post("/api/report", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    id?: unknown;
    category?: unknown;
    note?: unknown;
  } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const category = typeof body?.category === "string" ? body.category : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  const note = (typeof body?.note === "string" ? body.note : "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "unknown takeover" }, 404);
  if (!(REPORT_CATEGORIES as readonly string[]).includes(category)) {
    return c.json({ error: `category: one of ${REPORT_CATEGORIES.join(", ")}` }, 400);
  }
  if (note.length > 200) return c.json({ error: "note: at most 200 characters" }, 400);
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}:${id}`));
  const reporter = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ok = await board(c.env).report(id, category, note, reporter);
  return ok ? c.json({ ok: true }, 201) : c.json({ error: "unknown takeover" }, 404);
});

/** null if the request carries the admin token; otherwise the response to send. */
function adminDenied(c: { env: Env; req: { header(name: string): string | undefined } }) {
  const token = c.env.ADMIN_TOKEN;
  if (!token) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  const auth = c.req.header("Authorization") ?? "";
  if (!sameToken(auth, `Bearer ${token}`)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

app.get("/api/admin/reports", async (c) => {
  const denied = adminDenied(c);
  if (denied) return denied;
  return c.json(await board(c.env).reports());
});

/** Kill switch: remove the current holder now (next buyer, else the previous holder, returns). */
app.post("/api/admin/kill", async (c) => {
  const denied = adminDenied(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "removed by admin";
  return c.json(await board(c.env).kill(reason));
});

app.post("/api/admin/remove", async (c) => {
  const denied = adminDenied(c);
  if (denied) return denied;
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; reason?: unknown };
  if (typeof body.id !== "string") return c.json({ error: "id required" }, 400);
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "removed by admin";
  const r = await board(c.env).remove(body.id, reason);
  return c.json(r, r.removed ? 200 : 404);
});

// Sales log for bookkeeping (ledger import). Hidden unless ADMIN_TOKEN is set.
app.get("/api/admin/sales.csv", async (c) => {
  const denied = adminDenied(c);
  if (denied) return denied;
  const csv = salesCsv(await board(c.env).sales());
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": 'attachment; filename="bounce-board-sales.csv"',
    "Cache-Control": "no-store",
  });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

export default {
  fetch: app.fetch,
  /** Daily cron: refresh the phishing list. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      phishing(env)
        .refresh()
        .then((n) => console.log(`phishing list refreshed: ${n} domains`))
        .catch((e) => console.error("phishing list refresh failed", e)),
    );
  },
};
export { Board, PhishingListStore };
