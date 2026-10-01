/**
 * Minimal admin page: reports, queue, kill switch. Every action uses the admin token, which is
 * kept only in this tab's sessionStorage. All text goes in via textContent.
 */
import "./style.css";
import type { Snapshot } from "./sources";

const API = `${import.meta.env.BASE_URL}api`;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
let token = "";
try {
  token = sessionStorage.getItem("bb-admin") ?? "";
} catch {
  token = "";
}

function say(msg: string, error = false) {
  const s = $("admin-status");
  s.textContent = msg;
  s.classList.toggle("error", error);
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (res.status === 401) throw new Error("Wrong admin token.");
  if (!res.ok) throw new Error(`Request failed (${res.status}).`);
  return res.json();
}

function li(...parts: (string | Node)[]) {
  const el = document.createElement("li");
  el.style.display = "block";
  el.append(...parts);
  return el;
}

function button(label: string, onClick: () => void, cls = "secondary") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function remove(id: string, label: string) {
  const reason = ($("kill-reason") as HTMLInputElement).value || "removed by admin";
  if (!confirm(`Remove ${label}? Reason: ${reason}`)) return;
  try {
    await api("/admin/remove", { method: "POST", body: JSON.stringify({ id, reason }) });
    say(`Removed ${label}.`);
    await refresh();
  } catch (e) {
    say((e as Error).message, true);
  }
}

async function refresh() {
  const state = (await (await fetch(`${API}/state`)).json()) as Snapshot;
  const label = (c: { name: string; ticker?: string }) =>
    c.ticker ? `$${c.ticker} (${c.name})` : c.name;
  $("current").textContent = state.current
    ? `${label(state.current.card)} · ${state.current.card.link}`
    : "Empty";
  $("queue").replaceChildren(
    ...(state.queue.length
      ? state.queue.map((q) =>
          li(
            `${label(q.card)} · ${q.card.link} `,
            button("Remove", () => remove(q.id, label(q.card))),
          ),
        )
      : [li("Nobody queued.")]),
  );
  const reports = (await api("/admin/reports")) as {
    takeoverId: string;
    card: { name: string; ticker?: string; link: string };
    status: string;
    removed: boolean;
    count: number;
    categories: string[];
    notes: string[];
  }[];
  $("reports").replaceChildren(
    ...(reports.length
      ? reports.map((r) =>
          li(
            `${label(r.card)} · ${r.count} report${r.count > 1 ? "s" : ""} (${r.categories.join(", ")})`,
            r.removed ? " · removed" : ` · ${r.status} `,
            r.notes.length ? ` · "${r.notes.slice(0, 3).join('" "')}"` : "",
            r.removed || r.status === "finished"
              ? ""
              : button("Remove", () => remove(r.takeoverId, label(r.card))),
          ),
        )
      : [li("No reports.")]),
  );
}

async function unlock() {
  try {
    await api("/admin/reports");
    try {
      sessionStorage.setItem("bb-admin", token);
    } catch {
      // private mode: keep it in memory only
    }
    $("token-form").hidden = true;
    $("panel").hidden = false;
    await refresh();
  } catch (e) {
    say((e as Error).message, true);
  }
}

$("token-form").addEventListener("submit", (e) => {
  e.preventDefault();
  token = ($("token") as HTMLInputElement).value.trim();
  unlock();
});

$("kill").addEventListener("click", async () => {
  const reason = ($("kill-reason") as HTMLInputElement).value || "removed by admin";
  if (!confirm(`Remove the current holder now? Reason: ${reason}`)) return;
  try {
    await api("/admin/kill", { method: "POST", body: JSON.stringify({ reason }) });
    say("Current holder removed.");
    await refresh();
  } catch (e) {
    say((e as Error).message, true);
  }
});

if (token) unlock();
