/**
 * Link checks for buyer cards.
 *
 * - The card's link must not point at a known phishing or wallet-drainer domain. We use
 *   MetaMask's open-source list (eth-phishing-detect): an exact blacklist, a whitelist, and a
 *   short "fuzzy" list of brand domains whose one-edit look-alikes are blocked too.
 * - Bare IP addresses and punycode (xn--) hosts are blocked: common phishing tricks.
 * - Descriptions may not contain links or domains at all (no wallet-connect links). The link
 *   field is the one place for a URL.
 */
export const PHISHING_LIST_URL =
  "https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json";

export interface PhishingList {
  blacklist: string[];
  whitelist: string[];
  fuzzylist: string[];
  tolerance: number;
}

export type LinkCheck = { ok: true } | { ok: false; reason: string };

/** Lookups the Durable Object answers from its SQLite copy of the list. */
export interface PhishingLookup {
  isBlacklisted(domains: string[]): boolean;
  isWhitelisted(domains: string[]): boolean;
  fuzzylist(): { entries: string[]; tolerance: number };
}

/** host and each parent domain: a.b.example.com -> [a.b.example.com, b.example.com, example.com] */
export function domainChain(host: string): string[] {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function checkLink(link: string, list: PhishingLookup | null): LinkCheck {
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "link: not a valid URL" };
  }
  if (IPV4.test(host) || host.startsWith("["))
    return { ok: false, reason: "link: IP addresses are not allowed" };
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { ok: false, reason: "link: look-alike (punycode) domains are not allowed" };
  }
  if (!list) return { ok: true };
  const chain = domainChain(host);
  if (list.isWhitelisted(chain)) return { ok: true };
  if (list.isBlacklisted(chain))
    return { ok: false, reason: "link: this domain is on a phishing blocklist" };
  const bare = host.replace(/^www\./, "");
  const { entries, tolerance } = list.fuzzylist();
  for (const brand of entries) {
    if (bare !== brand && levenshtein(bare, brand, tolerance) <= tolerance) {
      return { ok: false, reason: `link: looks like an imitation of ${brand}` };
    }
  }
  return { ok: true };
}

// "https://", "www." or something.tld (two+ letter TLD) anywhere in the text.
const LINKISH = /(https?:\/\/|www\.|\b[a-z0-9-]{2,}\.(?:[a-z]{2,})(?:\/|\b))/i;

export function checkDescription(text: string): LinkCheck {
  return LINKISH.test(text)
    ? {
        ok: false,
        reason: "description: links and domains aren't allowed here (use the link field)",
      }
    : { ok: true };
}
