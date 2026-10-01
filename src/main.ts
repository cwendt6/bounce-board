import "./style.css";
import {
  BOX_H,
  BOX_W,
  type CornerHit,
  cornerHits,
  initialPhase,
  type Phase,
  positionAt,
  SCREEN_W,
} from "./core/motion";
import { boxLabel, dexscreenerUrl, formatDuration, initials, shortAddress } from "./format";
import { pickSource, type Source } from "./sources";
import type { CardView, View } from "./view";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// ---------- tiny DOM helper (text only, never innerHTML) ----------

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

// ---------- the box ----------

const canvas = $("canvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const css = getComputedStyle(document.documentElement);
const COLOR = {
  bg: css.getPropertyValue("--bg").trim() || "#0a0a0a",
  white: css.getPropertyValue("--screen").trim() || "#ffffff",
  blue: css.getPropertyValue("--blue").trim() || "#0052ff",
  orange: css.getPropertyValue("--orange").trim() || "#f7931a",
};
const FONT = '"Inter", ui-sans-serif, system-ui, sans-serif';

function setFont(size: number) {
  ctx.font = `700 ${Math.round(size)}px ${FONT}`;
}

/** Shrink the font until `text` fits in `maxW`; returns the size used. */
function fitText(text: string, start: number, maxW: number): number {
  let size = start;
  setFont(size);
  while (ctx.measureText(text).width > maxW && size > 8) {
    size -= 1;
    setFont(size);
  }
  return size;
}

/**
 * Lay out a label in at most two lines: one line if it fits at a readable size,
 * otherwise split at the most balanced space, shrinking down to `min`, then ellipsize.
 */
function layoutLabel(text: string, start: number, min: number, maxW: number) {
  const one = fitText(text, start, maxW);
  if (one >= start * 0.75 || !text.includes(" ")) {
    if (one >= min) return { size: one, lines: [text] };
  }
  const words = text.split(" ");
  let best = [text, ""];
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ");
    const b = words.slice(i).join(" ");
    const diff = Math.abs(a.length - b.length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = [a, b];
    }
  }
  const lines = best.filter(Boolean);
  let size = start * 0.8;
  setFont(size);
  const widest = () => Math.max(...lines.map((l) => ctx.measureText(l).width));
  while (widest() > maxW && size > min) {
    size -= 1;
    setFont(size);
  }
  for (let i = 0; i < lines.length; i++) {
    while (ctx.measureText(lines[i]).width > maxW && lines[i].length > 1) {
      lines[i] = `${lines[i].slice(0, -2)}…`;
    }
  }
  return { size, lines };
}

function drawLines(lines: string[], size: number, x: number, cy: number) {
  setFont(size);
  const lh = size * 1.1;
  const top = cy - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => {
    ctx.fillText(l, x, top + i * lh + size * 0.04);
  });
}

/**
 * Empty board: a solid blue box with white text.
 * Holder: a white box with a 2px blue border, logo on the left, black label.
 * Corner flash: the box turns orange briefly (skipped with reduced motion).
 */
function drawBox(card: CardView, phase: Phase, t: number, empty: boolean, flashing: boolean) {
  const scale = canvas.width / SCREEN_W;
  const dpr = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
  const p = positionAt(phase, t);
  const x = p.x * scale;
  const y = p.y * scale;
  const w = BOX_W * scale;
  const hgt = BOX_H * scale;
  const label = boxLabel(card);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";

  if (empty) {
    ctx.fillStyle = flashing ? COLOR.orange : COLOR.blue;
    roundRect(x, y, w, hgt, hgt * 0.14);
    ctx.fill();
    const { size, lines } = layoutLabel(label, hgt * 0.3, hgt * 0.15, w * 0.86);
    ctx.fillStyle = flashing ? COLOR.bg : COLOR.white;
    ctx.textAlign = "center";
    drawLines(lines, size, x + w / 2, y + hgt / 2);
    return;
  }

  const border = 2 * dpr;
  ctx.fillStyle = flashing ? COLOR.orange : COLOR.white;
  roundRect(x + border / 2, y + border / 2, w - border, hgt - border, hgt * 0.14);
  ctx.fill();
  ctx.lineWidth = border;
  ctx.strokeStyle = flashing ? COLOR.orange : COLOR.blue;
  ctx.stroke();

  // Logo placeholder until uploads land: initials on a blue circle.
  const r = hgt * 0.26;
  const cx = x + hgt * 0.42;
  const cy = y + hgt / 2;
  ctx.fillStyle = COLOR.blue;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLOR.white;
  ctx.textAlign = "center";
  const isize = fitText(initials(card.name), r * 0.9, r * 1.5);
  ctx.fillText(initials(card.name), cx, cy + isize * 0.04);

  const textX = x + hgt * 0.8;
  const { size, lines } = layoutLabel(label, hgt * 0.3, hgt * 0.15, x + w - hgt * 0.12 - textX);
  ctx.fillStyle = COLOR.bg;
  ctx.textAlign = "left";
  drawLines(lines, size, textX, cy);
}

// ---------- corner hit: orange flash on the box + toast ----------

const toast = $("corner-toast");
const FLASH_MS = 600;
let toastTimer = 0;
let flashUntil = 0;

function showCorner(hit: CornerHit) {
  toast.textContent = `CORNER! ${hit.corner.replace("-", " ")}`;
  toast.classList.add("on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("on"), 2500);
  if (!reducedMotion.matches) flashUntil = performance.now() + FLASH_MS;
}

// ---------- sidebars ----------

function holderRow(holder: CardView, extra: Child[] = []): HTMLLIElement {
  const logo = h("span", { class: "logo", "aria-hidden": "true" }, initials(holder.name));
  const meta: Child[] = [];
  if (holder.chain) meta.push(h("span", { class: `chain ${holder.chain}` }, holder.chain));
  if (holder.chain && holder.contract) {
    const ca = holder.contract;
    const btn = h(
      "button",
      { class: "copy", type: "button", title: `Copy ${ca}` },
      shortAddress(ca),
    );
    btn.addEventListener("click", () => {
      navigator.clipboard?.writeText(ca).then(
        () => {
          btn.textContent = "copied";
          window.setTimeout(() => {
            btn.textContent = shortAddress(ca);
          }, 1200);
        },
        () => {},
      );
    });
    meta.push(btn);
    meta.push(
      h(
        "a",
        { href: dexscreenerUrl(holder.chain, ca), target: "_blank", rel: "noopener noreferrer" },
        "chart",
      ),
    );
  }
  if (holder.x) {
    meta.push(
      h(
        "a",
        { href: `https://x.com/${holder.x}`, target: "_blank", rel: "noopener noreferrer" },
        `@${holder.x}`,
      ),
    );
  }
  meta.push(
    h("a", { href: holder.link, target: "_blank", rel: "noopener noreferrer nofollow" }, "site"),
  );
  return h(
    "li",
    {},
    logo,
    h("div", { class: "row-main" }, h("span", { class: "name" }, boxLabel(holder)), ...extra),
    h("div", { class: "desc" }, holder.description),
    h("div", { class: "meta" }, ...meta),
  );
}

function emptyRow(text: string): HTMLLIElement {
  return h("li", { class: "empty" }, text);
}

function renderQueue(v: View) {
  const rows = v.queue.map((q) =>
    holderRow(q.card, [
      h("span", { class: "badge" }, `in ${formatDuration((q.startMs - v.now) / 1000)}`),
    ]),
  );
  $("queue").replaceChildren(
    ...(rows.length ? rows : [emptyRow("Nobody queued. The box is yours.")]),
  );
}

function renderBoards(v: View) {
  $("stat-takeovers").textContent = v.stats.takeovers.toLocaleString("en-US");
  $("stat-holders").textContent = v.stats.uniqueHolders.toLocaleString("en-US");
  const club = v.cornerClub.map((c) =>
    h(
      "li",
      {},
      h("span", { class: "name" }, c.label),
      h("span", { class: "badge corners" }, `◢ ${c.corners}`),
    ),
  );
  $("corner-club").replaceChildren(...(club.length ? club : [emptyRow("No corner hits yet.")]));
  const longest = v.longest.map((c) =>
    h(
      "li",
      {},
      h("span", { class: "name" }, c.label),
      h("span", { class: "badge" }, formatDuration(c.ms / 1000)),
    ),
  );
  $("longest").replaceChildren(...(longest.length ? longest : [emptyRow("No reigns yet.")]));
  const recent = v.recent.map((r) =>
    holderRow(r.card, [
      h(
        "span",
        { class: "badge" },
        formatDuration(r.heldMs / 1000),
        r.corners ? h("span", { class: "corners" }, ` ◢ ${r.corners}`) : null,
      ),
    ]),
  );
  $("recent").replaceChildren(...(recent.length ? recent : [emptyRow("No holders yet.")]));
}

function renderNowHolding(v: View, corners: number) {
  const el = $("now-holding");
  if (!v.current) {
    el.replaceChildren("The box is empty. Be the first to take it.");
    return;
  }
  const cur = v.current;
  const timing =
    cur.endMs !== null
      ? `${formatDuration((cur.endMs - v.now) / 1000)} left in demo reign`
      : `held ${formatDuration((v.now - cur.startMs) / 1000)}`;
  el.replaceChildren(
    "Now holding: ",
    h("strong", {}, boxLabel(cur.card)),
    ` · ${timing}${corners ? ` · ◢ ${corners} corner${corners > 1 ? "s" : ""}` : ""}`,
  );
}

// ---------- main loop ----------

const EMPTY_CARD: CardView = {
  name: "Your name here",
  description: "",
  link: "https://example.com",
};
const EMPTY_PHASE = initialPhase(1);

let source: Source;
let currentId: string | null = null;
let phase = EMPTY_PHASE;
let lastT = 0;
let corners = 0;
let lastSidebarSecond = -1;
let boardsDirty = true;

function tick() {
  const v = source.view();
  const cur = v.current;
  const id = cur?.id ?? null;
  if (id !== currentId) {
    currentId = id;
    phase = cur ? initialPhase(cur.seed) : EMPTY_PHASE;
    lastT = cur ? (v.now - cur.startMs) / 1000 : 0;
    corners = cur ? cornerHits(phase, 0, lastT).length : 0;
    boardsDirty = true;
  }

  const t = cur ? (v.now - cur.startMs) / 1000 : v.now / 1000;
  if (cur) {
    const hits = cornerHits(phase, lastT, t);
    if (hits.length) {
      corners += hits.length;
      showCorner(hits[hits.length - 1]);
    }
    lastT = t;
  }
  drawBox(cur?.card ?? EMPTY_CARD, phase, cur ? t : t % 3600, !cur, performance.now() < flashUntil);

  const sec = Math.floor(v.now / 1000);
  if (sec !== lastSidebarSecond || boardsDirty) {
    lastSidebarSecond = sec;
    renderQueue(v);
    renderNowHolding(v, corners);
  }
  if (boardsDirty) {
    boardsDirty = false;
    renderBoards(v);
  }
}

let timer = 0;
let raf = 0;

function loop() {
  tick();
  raf = requestAnimationFrame(loop);
}

// Reduced motion: no animation frames; redraw every 2 s so the box steps instead of gliding.
function start() {
  cancelAnimationFrame(raf);
  window.clearInterval(timer);
  if (reducedMotion.matches) {
    tick();
    timer = window.setInterval(tick, 2000);
  } else {
    loop();
  }
}

// ---------- take the box ----------

const EXPLORER_TX = "https://sepolia.basescan.org/tx/";

function setupTakeDialog() {
  const open = $("take-open") as HTMLButtonElement;
  const dialog = $("take-dialog") as HTMLDialogElement;
  const form = $("take-form") as HTMLFormElement;
  const submit = $("take-submit") as HTMLButtonElement;
  const status = $("take-status");
  open.disabled = false;
  open.title = "";
  const note = document.querySelector(".queue .fine");
  if (note) note.textContent = "Payments: USDC on Base Sepolia (testnet).";

  const say = (msg: string, error = false) => {
    status.replaceChildren(msg);
    status.classList.toggle("error", error);
  };

  open.addEventListener("click", () => {
    say("");
    dialog.showModal();
  });
  $("take-cancel").addEventListener("click", () => dialog.close());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const get = (k: string) => String(f.get(k) ?? "").trim();
    const isToken =
      (form.querySelector(".token-fields") as HTMLDetailsElement).open && get("ticker");
    const card = {
      name: get("name"),
      link: get("link"),
      description: get("description"),
      x: get("x") || undefined,
      ...(isToken ? { ticker: get("ticker"), chain: get("chain"), contract: get("contract") } : {}),
    };
    if (!card.name || !card.link) {
      say("Name and link are required.", true);
      return;
    }
    submit.disabled = true;
    try {
      const { takeTheBox } = await import("./pay-client");
      const { tx } = await takeTheBox(`${import.meta.env.BASE_URL}api/take`, card, (m) => say(m));
      status.replaceChildren(
        "Paid. You're in the queue. ",
        h(
          "a",
          { href: `${EXPLORER_TX}${tx}`, target: "_blank", rel: "noopener noreferrer" },
          "View transaction",
        ),
      );
      status.classList.remove("error");
      form.reset();
    } catch (err) {
      const code = (err as { code?: number }).code;
      say(
        code === 4001
          ? "Cancelled in your wallet."
          : (err as Error).message || "Something went wrong.",
        true,
      );
    } finally {
      submit.disabled = false;
    }
  });
}

async function main() {
  source = await pickSource(() => {
    boardsDirty = true;
  });
  const live = source.view().mode === "live";
  $("demo-flag").textContent = live
    ? "Testnet preview: no real money yet."
    : "Preview: demo data, no payments yet.";
  if (live) setupTakeDialog();
  new ResizeObserver(() => {
    resize();
    tick();
  }).observe(canvas);
  resize();
  reducedMotion.addEventListener("change", start);
  document.fonts?.ready.then(() => tick());
  start();
}

main();
