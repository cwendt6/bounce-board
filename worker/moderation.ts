/**
 * Content moderation for buyer cards, run before a price is quoted so nobody pays for a
 * takeover we would reject.
 *
 * Text: Llama Guard 3 (content-safety classifier, hazard categories S1-S14).
 * Logo: a vision model asked for a one-word SAFE/UNSAFE answer.
 * Both run on Workers AI. If a check can't run (quota, outage, odd output) we fail closed:
 * the buyer is asked to try again later, before paying.
 */
import type { BoardCard } from "./card";

export type Verdict = { ok: true } | { ok: false; reason: string } | { ok: "unavailable" };

export interface Moderator {
  check(card: BoardCard, logoDataUrl: string | null): Promise<Verdict>;
}

/** Llama Guard 3 hazard categories (MLCommons taxonomy). */
export const HAZARDS: Record<string, string> = {
  S1: "violent crimes",
  S2: "non-violent crimes (fraud, scams)",
  S3: "sex-related crimes",
  S4: "child sexual exploitation",
  S5: "defamation",
  S6: "specialized advice",
  S7: "privacy",
  S8: "intellectual property",
  S9: "indiscriminate weapons",
  S10: "hate",
  S11: "suicide and self-harm",
  S12: "sexual content",
  S13: "elections",
  S14: "code interpreter abuse",
};

export function cardText(card: BoardCard): string {
  const lines = [
    `Display name: ${card.name}`,
    card.description ? `Description: ${card.description}` : "",
    `Link: ${card.link}`,
    card.x ? `X handle: @${card.x}` : "",
    card.ticker ? `Token: $${card.ticker} on ${card.chain}` : "",
  ];
  return `This is a paid ad card that will be shown publicly on a website.\n${lines.filter(Boolean).join("\n")}`;
}

/** Llama Guard output is either {safe, categories} or text like "unsafe\nS10,S12". */
export function parseGuard(response: unknown): Verdict {
  if (response && typeof response === "object") {
    const r = response as { safe?: unknown; categories?: unknown };
    if (r.safe === true) return { ok: true };
    if (r.safe === false) {
      const cats = Array.isArray(r.categories) ? r.categories.map(String) : [];
      return { ok: false, reason: describe(cats) };
    }
    return { ok: "unavailable" };
  }
  if (typeof response === "string") {
    const t = response.trim().toLowerCase();
    if (t.startsWith("safe")) return { ok: true };
    if (t.startsWith("unsafe"))
      return { ok: false, reason: describe(response.match(/S\d{1,2}/g) ?? []) };
  }
  return { ok: "unavailable" };
}

function describe(cats: string[]): string {
  const names = cats.map((c) => HAZARDS[c.toUpperCase()]).filter(Boolean);
  return names.length ? `content flagged: ${names.join(", ")}` : "content flagged";
}

export const IMAGE_PROMPT =
  "You moderate logos for a public website. Look at the image. Reply with exactly one word: " +
  "UNSAFE if it shows nudity or sexual content, graphic violence or gore, hate symbols or " +
  "extremist imagery, or drugs; otherwise SAFE.";

export function parseImageAnswer(text: unknown): Verdict {
  if (typeof text !== "string") return { ok: "unavailable" };
  const t = text.trim().toUpperCase();
  if (t.startsWith("UNSAFE")) return { ok: false, reason: "logo flagged by image moderation" };
  if (t.startsWith("SAFE")) return { ok: true };
  return { ok: "unavailable" };
}

const TEXT_MODEL = "@cf/meta/llama-guard-3-8b";
const IMAGE_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

/** Minimal shape of the Workers AI binding we use. */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export class WorkersAiModerator implements Moderator {
  constructor(private readonly ai: AiRunner) {}

  async check(card: BoardCard, logoDataUrl: string | null): Promise<Verdict> {
    try {
      const [text, image] = await Promise.all([
        this.ai.run(TEXT_MODEL, {
          messages: [{ role: "user", content: cardText(card) }],
          response_format: { type: "json_object" },
          temperature: 0,
          max_tokens: 32,
        }),
        logoDataUrl
          ? this.ai.run(IMAGE_MODEL, {
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: IMAGE_PROMPT },
                    { type: "image_url", image_url: { url: logoDataUrl } },
                  ],
                },
              ],
              temperature: 0,
              max_tokens: 4,
            })
          : Promise.resolve(null),
      ]);
      const t = parseGuard((text as { response?: unknown } | null)?.response);
      if (t.ok !== true) return t;
      if (!logoDataUrl) return t;
      return parseImageAnswer((image as { response?: unknown } | null)?.response);
    } catch (e) {
      console.error("moderation unavailable", e);
      return { ok: "unavailable" };
    }
  }
}

/** Passes everything. Used only when MODERATION=off (tests and offline local dev). */
export const allowAll: Moderator = { check: async () => ({ ok: true }) };

/** Stable cache key for a card and its logo, so the paid retry doesn't re-run the models. */
export async function verdictKey(card: BoardCard, logoDataUrl: string | null): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([card, logoDataUrl ?? ""]));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
