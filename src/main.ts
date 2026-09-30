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
import { DEMO_REIGN_SECONDS, type Reign, reignAt, upcoming } from "./core/schedule";
import {
  DEMO_CORNER_CLUB,
  DEMO_HOLDERS,
  DEMO_LONGEST_REIGN,
  DEMO_STATS,
  type Holder,
} from "./fake-data";
import { boxLabel, dexscreenerUrl, formatDuration, initials, shortAddress } from "./format";

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

function drawBox(holder: Holder, phase: Phase, t: number) {
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

function holderRow(holder: Holder, extra: Child[] = []): HTMLLIElement {
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

function reignCorners(r: Reign): number {
  return cornerHits(initialPhase(r.seed), 0, (r.endMs - r.startMs) / 1000).length;
}

function renderQueue(now: number) {
  const list = $("queue");
  const rows = upcoming(now, DEMO_HOLDERS.length, 4).map((r) => {
    const secs = (r.startMs - now) / 1000;
    return holderRow(DEMO_HOLDERS[r.holder], [
      h("span", { class: "badge" }, `in ${formatDuration(secs)}`),
    ]);
  });
  list.replaceChildren(...rows);
}

function renderRecent(now: number) {
  const cur = reignAt(now, DEMO_HOLDERS.length);
  const rows: HTMLLIElement[] = [];
  for (let i = 1; i <= 10; i++) {
    const r = reignAt(cur.startMs - i * DEMO_REIGN_SECONDS * 1000, DEMO_HOLDERS.length);
    const corners = reignCorners(r);
    rows.push(
      holderRow(DEMO_HOLDERS[r.holder], [
        h(
          "span",
          { class: "badge" },
          `${formatDuration(DEMO_REIGN_SECONDS)}${corners ? ` · ◢ ${corners}` : ""}`,
        ),
      ]),
    );
  }
  $("recent").replaceChildren(...rows);
}

function renderBoards() {
  $("stat-takeovers").textContent = DEMO_STATS.takeovers.toLocaleString("en-US");
  $("stat-holders").textContent = DEMO_STATS.uniqueHolders.toLocaleString("en-US");
  $("corner-club").replaceChildren(
    ...DEMO_CORNER_CLUB.map((c) =>
      h(
        "li",
        {},
        h("span", { class: "name" }, c.ticker ? `$${c.ticker}` : c.name),
        h("span", { class: "badge" }, `◢ ${c.corners}`),
      ),
    ),
  );
  $("longest").replaceChildren(
    ...DEMO_LONGEST_REIGN.map((c) =>
      h(
        "li",
        {},
        h("span", { class: "name" }, c.ticker ? `$${c.ticker}` : c.name),
        h("span", { class: "badge" }, formatDuration(c.seconds)),
      ),
    ),
  );
}

function renderNowHolding(holder: Holder, reign: Reign, now: number, corners: number) {
  const left = formatDuration((reign.endMs - now) / 1000);
  $("now-holding").replaceChildren(
    "Now holding: ",
    h("strong", {}, boxLabel(holder)),
    ` · ${left} left in demo reign${corners ? ` · ◢ ${corners} corner${corners > 1 ? "s" : ""}` : ""}`,
  );
}

// ---------- main loop ----------

let reign = reignAt(Date.now(), DEMO_HOLDERS.length);
let phase = initialPhase(reign.seed);
let lastT = (Date.now() - reign.startMs) / 1000;
let cornersThisReign = cornerHits(phase, 0, lastT).length;
let lastSidebarSecond = -1;

function tick() {
  const now = Date.now();
  if (now >= reign.endMs) {
    reign = reignAt(now, DEMO_HOLDERS.length);
    phase = initialPhase(reign.seed);
    lastT = 0;
    cornersThisReign = 0;
    renderRecent(now);
  }
  const t = (now - reign.startMs) / 1000;
  const hits = cornerHits(phase, lastT, t);
  if (hits.length) {
    cornersThisReign += hits.length;
    showCorner(hits[hits.length - 1]);
  }
  lastT = t;

  const holder = DEMO_HOLDERS[reign.holder];
  drawBox(holder, phase, t);

  const sec = Math.floor(now / 1000);
  if (sec !== lastSidebarSecond) {
    lastSidebarSecond = sec;
    renderQueue(now);
    renderNowHolding(holder, reign, now, cornersThisReign);
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

document.documentElement.style.setProperty("--grain-url", makeGrain());
new ResizeObserver(() => {
  resize();
  tick();
}).observe(canvas);
resize();
renderBoards();
renderRecent(Date.now());
reducedMotion.addEventListener("change", start);
document.fonts?.ready.then(() => tick());
start();
