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

/**
 * Shared hosting where anyone can get a subdomain. These act as public suffixes, so for
 * metamask.pages.dev the part an attacker controls ("metamask") is what gets checked.
 */
export const HOSTING_SUFFIXES = new Set([
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "github.io",
  "gitlab.io",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "glitch.me",
  "replit.app",
  "surge.sh",
  "azurewebsites.net",
  "blogspot.com",
  "wixsite.com",
  "weebly.com",
  "webflow.io",
  "framer.website",
  "ipfs.io",
  "deno.dev",
  "duckdns.org",
  "neocities.org",
  "wordpress.com",
  "notion.site",
  "gitbook.io",
  "bitbucket.io",
  "loca.lt",
  "appspot.com",
  "netlify.com",
  "railway.app",
  "up.railway.app",
  "s3.amazonaws.com",
  "cloudfront.net",
  "azurestaticapps.net",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
  "myshopify.com",
  "carrd.co",
  "square.site",
  "godaddysites.com",
  "000webhostapp.com",
  "pythonanywhere.com",
  "repl.co",
  "eth.limo",
  "eth.link",
  "co.uk",
  "org.uk",
  "com.au",
  "net.au",
  "co.jp",
  "com.br",
  "co.in",
  "com.mx",
  "co.kr",
  "co.nz",
  "co.za",
  "com.sg",
  "com.tr",
  "com.ar",
  "com.cn",
  "com.hk",
]);

/**
 * The registrable domain: the longest known shared suffix (see HOSTING_SUFFIXES) plus one
 * label, or the last two labels. Good enough for brand look-alike checks. This is a short
 * hand-picked list, not the full Public Suffix List; the exact blocklist still applies.
 */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.+$/, "").split(".");
  for (const n of [3, 2]) {
    if (parts.length > n && HOSTING_SUFFIXES.has(parts.slice(-n).join("."))) {
      return parts.slice(-(n + 1)).join(".");
    }
  }
  return parts.slice(-2).join(".");
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

/** Official domains of fuzzylist brands that the label rule below would otherwise block. */
export const OFFICIAL_ALTERNATES = new Set(["metamask.github.io", "ethereum.foundation"]);

export function checkLink(link: string, list: PhishingLookup | null): LinkCheck {
  let host: string;
  try {
    host = new URL(link).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return { ok: false, reason: "link: not a valid URL" };
  }
  if (IPV4.test(host) || host.startsWith("["))
    return { ok: false, reason: "link: IP addresses are not allowed" };
  if (!host.includes(".")) return { ok: false, reason: "link: needs a full domain name" };
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return { ok: false, reason: "link: look-alike (punycode) domains are not allowed" };
  }
  if (!list) return { ok: true };
  const chain = domainChain(host);
  if (list.isWhitelisted(chain)) return { ok: true };
  if (list.isBlacklisted(chain))
    return { ok: false, reason: "link: this domain is on a phishing blocklist" };
  // Look-alikes: compare the registrable domain's main label (login.metamsk.io -> "metamsk")
  // with each protected brand minus its TLD ("metamask"). Distance 0 counts too, so
  // metamask.app is caught; the brand's own domain (and anything whitelisted) is allowed.
  // Subdomain labels must not be the brand exactly (metamask.evil.workers.dev).
  const registrable = registrableDomain(host);
  if (OFFICIAL_ALTERNATES.has(registrable)) return { ok: true };
  const label = registrable.split(".")[0];
  const subLabels = host.slice(0, -registrable.length).split(".").filter(Boolean);
  const { entries, tolerance } = list.fuzzylist();
  for (const brand of entries) {
    const brandDomain = registrableDomain(brand);
    if (registrable === brandDomain) continue;
    const brandLabel = brandDomain.split(".")[0];
    // MetaMask measures distance on more of the name; we compare one label, so the list's
    // tolerance is capped at 1, and short brand labels (dydx) must match exactly.
    const tol = brandLabel.length < 6 ? 0 : Math.min(tolerance, 1);
    if (levenshtein(label, brandLabel, tol) <= tol || subLabels.includes(brandLabel)) {
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
