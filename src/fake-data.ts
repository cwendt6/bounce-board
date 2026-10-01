/**
 * Demo data for milestone 1. Every name, ticker and address here is invented.
 * Milestone 2 replaces this with real takeovers from the server.
 */
export type Chain = "base" | "solana" | "ethereum";

export interface Holder {
  id: string;
  name: string;
  ticker?: string;
  chain?: Chain;
  contract?: string;
  description: string;
  x?: string;
  link: string;
}

export const DEMO_HOLDERS: Holder[] = [
  {
    id: "h1",
    name: "Lamp Oil",
    ticker: "LAMPO",
    chain: "base",
    contract: "0x7a3f9c21d04e5b8a6f1e2d3c4b5a69788f1e2d3c",
    description: "Keeps the projector bulb warm since the last bell.",
    x: "lampoil_demo",
    link: "https://example.com/lamp-oil",
  },
  {
    id: "h2",
    name: "Grainfield",
    ticker: "GRAIN",
    chain: "solana",
    contract: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    description: "A coin made entirely of film grain.",
    x: "grainfield_demo",
    link: "https://example.com/grainfield",
  },
  {
    id: "h3",
    name: "Chalk Dust Studio",
    description: "Design studio. Not a token, just a brand saying hi.",
    link: "https://example.com/chalkdust",
  },
  {
    id: "h4",
    name: "Transparency",
    ticker: "SHEET",
    chain: "ethereum",
    contract: "0x51c4e2b7f0a9d3e6c8b1a2f3e4d5c6b7a8f9e0d1",
    description: "One acetate sheet at a time.",
    x: "sheet_demo",
    link: "https://example.com/sheet",
  },
  {
    id: "h5",
    name: "Hall Pass",
    ticker: "PASS",
    chain: "base",
    contract: "0x0c2e8d4a6b1f3e5c7a9b2d4f6e8a0c1e3b5d7f92",
    description: "Leave class, come back rich. Not financial advice.",
    link: "https://example.com/hallpass",
  },
];

/** Fake stats for the left sidebar. */
export const DEMO_STATS = { takeovers: 1287, uniqueHolders: 412 };

export const DEMO_CORNER_CLUB = [
  { name: "Grainfield", ticker: "GRAIN", corners: 7 },
  { name: "Lamp Oil", ticker: "LAMPO", corners: 5 },
  { name: "Chalk Dust Studio", corners: 3 },
];

export const DEMO_LONGEST_REIGN = [
  { name: "Transparency", ticker: "SHEET", seconds: 1834 },
  { name: "Hall Pass", ticker: "PASS", seconds: 1210 },
  { name: "Lamp Oil", ticker: "LAMPO", seconds: 945 },
];
