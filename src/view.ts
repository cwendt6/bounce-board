/** What the page renders. Both the demo rotation and the live server produce this shape. */
import type { Chain } from "./fake-data";

export interface CardView {
  name: string;
  description: string;
  link: string;
  x?: string;
  ticker?: string;
  chain?: Chain;
  contract?: string;
  /** Server-relative logo URL ("/api/logo/<id>"), set by the server only. */
  logo?: string;
  /** "unverified" when the token checks couldn't run (shown as a badge). */
  tokenCheck?: "verified" | "unverified";
}

export interface View {
  mode: "demo" | "live";
  /** Current time on the shared clock (server time in live mode), ms since epoch. */
  now: number;
  current: {
    id: string;
    card: CardView;
    startMs: number;
    seed: number;
    /** Known end in demo mode; unknown in live mode (the holder keeps it until someone buys). */
    endMs: number | null;
  } | null;
  queue: { id?: string; card: CardView; startMs: number }[];
  recent: { card: CardView; heldMs: number; corners: number }[];
  cornerClub: { label: string; corners: number }[];
  longest: { label: string; ms: number }[];
  stats: { takeovers: number; uniqueHolders: number };
}
