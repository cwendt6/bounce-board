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

// ---------- film grain texture, generated once ----------

function makeGrain(): string {
  const c = document.createElement("canvas");
  c.width = c.height = 160;
  const ctx = c.getContext("2d");
  if (!ctx) return "none";
  const img = ctx.createImageData(c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return `url(${c.toDataURL()})`;
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

function drawBox(holder: CardView, phase: Phase, t: number) {
  const scale = canvas.width / SCREEN_W;
  const p = positionAt(phase, t);
  const x = p.x * scale;
  const y = p.y * scale;
  const w = BOX_W * scale;
  const hgt = BOX_H * scale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // A colored transparency sheet on the projector: translucent fill, darker outline.
  ctx.fillStyle = `${holder.color}cc`;
  roundRect(x, y, w, hgt, hgt * 0.12);
  ctx.fill();
  ctx.lineWidth = Math.max(1, scale * 0.012);
  ctx.strokeStyle = "rgba(40, 28, 10, 0.75)";
  ctx.stroke();

  // Logo placeholder: circle with initials (real logos arrive with payments).
  const r = hgt * 0.32;
  const cx = x + hgt * 0.5;
  const cy = y + hgt * 0.5;
  ctx.fillStyle = "rgba(30, 22, 10, 0.85)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = holder.color;
  ctx.font = `${Math.round(r * 1.05)}px VT323, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials(holder.name), cx, cy + r * 0.06);

  // Label, shrunk to fit.
  const label = boxLabel(holder);
  const left = x + hgt * 0.95;
  const maxW = w - hgt * 1.1;
  let size = hgt * 0.42;
  ctx.font = `${Math.round(size)}px VT323, monospace`;
  while (ctx.measureText(label).width > maxW && size > 8) {
    size -= 1;
    ctx.font = `${Math.round(size)}px VT323, monospace`;
  }
  ctx.fillStyle = "#1e160a";
  ctx.textAlign = "left";
  ctx.fillText(label, left, cy + size * 0.05);
}

// ---------- corner flash ----------

const flash = $("corner-flash");
let flashTimer = 0;

function showCorner(hit: CornerHit) {
  flash.textContent = `CORNER! (${hit.corner.replace("-", " ")})`;
  flash.classList.add("on");
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => flash.classList.remove("on"), 2500);
}

// ---------- sidebars ----------

function holderRow(holder: CardView, extra: Child[] = []): HTMLLIElement {
  const logo = h("span", { class: "logo", "aria-hidden": "true" }, initials(holder.name));
  logo.style.background = holder.color;
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
      h("span", { class: "badge" }, `◢ ${c.corners}`),
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
        `${formatDuration(r.heldMs / 1000)}${r.corners ? ` · ◢ ${r.corners}` : ""}`,
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
  color: "#f2c14e",
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
  drawBox(cur?.card ?? EMPTY_CARD, phase, cur ? t : t % 3600);

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

async function main() {
  document.documentElement.style.setProperty("--grain-url", makeGrain());
  source = await pickSource(() => {
    boardsDirty = true;
  });
  const live = source.view().mode === "live";
  $("demo-flag").textContent = live
    ? "Testnet preview: no real money yet."
    : "Preview: demo data, no payments yet.";
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
