import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "./board";
import { validateCard } from "./card";

const card = (name: string) => {
  const r = validateCard({ name, description: "test", link: "https://example.com" });
  if (!r.ok) throw new Error("bad test card");
  return r.card;
};
const stub = (name: string) => env.BOARD.get(env.BOARD.idFromName(name));
const AUTH = { Authorization: "Bearer test-admin-token", "Content-Type": "application/json" };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("kill switch", () => {
  it("hands the box to the next queued buyer immediately", async () => {
    const b = stub("kill-queue");
    const t = Date.now() - 1_000;
    await b.enqueue({ id: id(1), paidAtMs: t, card: card("Bad Actor") });
    await b.enqueue({ id: id(2), paidAtMs: t + 1, card: card("Next Up") });
    const before = Date.now();
    const s = await b.kill("scam");
    expect(s.current?.id).toBe(id(2));
    expect(s.current?.startMs).toBeGreaterThanOrEqual(before);
    // Removed reigns don't show anywhere.
    expect(s.recent.map((r) => r.card.name)).not.toContain("Bad Actor");
    expect(s.longest.map((l) => l.label)).not.toContain("Bad Actor");
  });

  it("brings back the previous holder when nobody is queued, without counting it", async () => {
    const b = stub("kill-restore");
    const long = Date.now() - 10 * 60_000;
    await b.enqueue({ id: id(3), paidAtMs: long, card: card("Good Holder") });
    await b.enqueue({ id: id(4), paidAtMs: long + 1, card: card("Bad Actor") });
    const before = (await b.snapshot()).stats.takeovers;
    const s = await b.kill("nsfw");
    expect(s.current?.card.name).toBe("Good Holder");
    expect(s.current?.id).not.toBe(id(3));
    expect(s.stats.takeovers).toBe(before - 1);
  });

  it("removes a queued takeover", async () => {
    const b = stub("remove-queued");
    const t = Date.now();
    await b.enqueue({ id: id(5), paidAtMs: t, card: card("Holder") });
    await b.enqueue({ id: id(6), paidAtMs: t + 1, card: card("Queued Scam") });
    const r = await b.remove(id(6), "impersonation");
    expect(r.removed).toBe(true);
    expect(r.snapshot.queue).toHaveLength(0);
    expect((await b.remove(id(6), "again")).removed).toBe(false);
  });
});

describe("reports and admin routes", () => {
  it("accepts a report for a real takeover and lists it for the admin", async () => {
    const res = await SELF.fetch("https://board.test/api/dev/take", {
      method: "POST",
      body: JSON.stringify({ name: "Reported Co", link: "https://example.com" }),
    });
    const s = (await res.json()) as Snapshot;
    const target = [s.current, ...s.queue].find((h) => h?.card.name === "Reported Co");
    const send = (body: unknown) =>
      SELF.fetch("https://board.test/api/report", { method: "POST", body: JSON.stringify(body) });
    expect((await send({ id: target?.id, category: "scam", note: "fake airdrop" })).status).toBe(
      201,
    );
    // Same reporter (same IP) twice counts once.
    expect((await send({ id: target?.id, category: "scam", note: "again" })).status).toBe(201);
    expect((await send({ id: target?.id, category: "spam" })).status).toBe(400);
    expect((await send({ id: id(999), category: "scam" })).status).toBe(404);

    const list = (await (
      await SELF.fetch("https://board.test/api/admin/reports", { headers: AUTH })
    ).json()) as { takeoverId: string; count: number; categories: string[] }[];
    const entry = list.find((r) => r.takeoverId === target?.id);
    expect(entry?.count).toBe(1);
    expect(entry?.categories).toEqual(["scam"]);
  });

  it("requires the admin token", async () => {
    for (const [path, method] of [
      ["/api/admin/reports", "GET"],
      ["/api/admin/kill", "POST"],
      ["/api/admin/remove", "POST"],
    ]) {
      const res = await SELF.fetch(`https://board.test${path}`, {
        method,
        headers: { Authorization: "Bearer nope" },
      });
      expect(res.status).toBe(401);
    }
  });
});
