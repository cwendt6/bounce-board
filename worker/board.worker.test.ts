import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MIN_HOLD_MS } from "../src/core/queue";
import type { Snapshot } from "./board";
import { validateCard } from "./card";

const card = (name: string) => {
  const r = validateCard({ name, description: "test", link: "https://example.com" });
  if (!r.ok) throw new Error("bad test card");
  return r.card;
};

// Each RPC test gets its own board so storage from other tests can't leak in.
const stub = (name: string) => env.BOARD.get(env.BOARD.idFromName(name));

describe("board API", () => {
  it("starts empty", async () => {
    const res = await SELF.fetch("https://board.test/api/state");
    const s = (await res.json()) as Snapshot;
    expect(s.current).toBeNull();
    expect(s.queue).toEqual([]);
    expect(typeof s.serverNow).toBe("number");
  });

  it("queues a dev takeover and shows it as current", async () => {
    const res = await SELF.fetch("https://board.test/api/dev/take", {
      method: "POST",
      body: JSON.stringify({
        name: "Lamp Oil",
        description: "Warm bulb.",
        link: "https://example.com",
      }),
    });
    expect(res.status).toBe(201);
    const s = (await res.json()) as Snapshot;
    expect(s.current?.card.name).toBe("Lamp Oil");
    expect(s.stats.takeovers).toBe(1);
  });

  it("rejects invalid cards", async () => {
    const res = await SELF.fetch("https://board.test/api/dev/take", {
      method: "POST",
      body: JSON.stringify({ name: "", link: "http://nope" }),
    });
    expect(res.status).toBe(400);
  });

  it("holds the first buyer for the minimum hold and queues the next", async () => {
    const b = stub("hold");
    const now = Date.now();
    await b.enqueue({ id: "a", paidAtMs: now, card: card("First") });
    const s = await b.enqueue({ id: "b", paidAtMs: now + 1, card: card("Second") });
    expect(s.current?.id).toBe("a");
    expect(s.queue).toHaveLength(1);
    expect(s.queue[0].estStartMs).toBeGreaterThanOrEqual(now + MIN_HOLD_MS);
  });

  it("hands over once the hold has passed and records the finished reign", async () => {
    const b = stub("handover");
    const long = Date.now() - 10 * 60_000;
    await b.enqueue({ id: "old", paidAtMs: long, card: card("Old Timer") });
    const s = await b.enqueue({ id: "new", paidAtMs: long + 1, card: card("New Kid") });
    expect(s.current?.id).toBe("new");
    expect(s.recent[0].id).toBe("old");
    expect(s.recent[0].endMs - s.recent[0].startMs).toBeGreaterThanOrEqual(MIN_HOLD_MS);
    expect(s.longest[0].label).toBe("Old Timer");
  });

  it("answers WebSocket pings with the server time", async () => {
    const res = await SELF.fetch("https://board.test/api/live", {
      headers: { Upgrade: "websocket" },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket as WebSocket;
    ws.accept();
    const messages: { type: string; serverNow?: number; t0?: number }[] = [];
    const pong = new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data as string);
        messages.push(m);
        if (m.type === "pong") resolve();
      });
    });
    ws.send(JSON.stringify({ type: "ping", t0: 123 }));
    await pong;
    expect(messages[0].type).toBe("snapshot");
    const p = messages.find((m) => m.type === "pong");
    expect(p?.t0).toBe(123);
    expect(typeof p?.serverNow).toBe("number");
    ws.close();
  });

  it("hides the dev endpoint unless enabled", async () => {
    expect(env.DEV_FAKE_PAY).toBe("true");
  });
});
