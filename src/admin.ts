/**
 * Minimal admin page: reports, queue, kill switch. Every action uses the admin token, which is
 * kept only in this tab's sessionStorage. All text goes in via textContent.
 */
import "./style.css";
import type { Snapshot } from "./sources";

const API = `${import.meta.env.BASE_URL}api`;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
let token = "";
/** The holder the admin is looking at; the kill switch only removes this one. */
let currentId: string | null = null;
let currentLabel = "";
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
  if (res.status === 409) {
    await refresh();
    throw new Error(
      "The holder changed before your kill, so nothing was removed. The page now shows the new holder.",
    );
  }
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

const label = (c: { name: string; ticker?: string }) =>
  c.ticker ? `$${c.ticker} (${c.name})` : c.name;

/** The live holder and queue. The kill switch needs only this, not the reports. */
async function loadState() {
  const res = await fetch(`${API}/state`);
  if (!res.ok) throw new Error(`Couldn't load the board (${res.status}).`);
  const state = (await res.json()) as Snapshot;
  currentId = state.current?.id ?? null;
  currentLabel = state.current ? label(state.current.card) : "";
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
}

async function refresh() {
  await loadState();
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
  const killButton = $("kill") as HTMLButtonElement;
  if (killButton.disabled) return;
  killButton.disabled = true; // one kill at a time: a double click must not open two dialogs
  try {
    const reason = ($("kill-reason") as HTMLInputElement).value || "removed by admin";
    // Load the live holder first: this page doesn't poll, so what it shows may be old.
    await loadState();
    const id = currentId;
    if (!id) {
      say("Nobody is holding the box.", true);
      return;
    }
    if (!confirm(`Remove ${currentLabel} now? Reason: ${reason}`)) return;
    // The server only removes this exact holder, so a change during the dialog is safe.
    await api("/admin/kill", { method: "POST", body: JSON.stringify({ id, reason }) });
    say("Current holder removed.");
  } catch (e) {
    say((e as Error).message, true);
    return;
  } finally {
    killButton.disabled = false;
  }
  await refresh().catch((e: Error) => say(e.message, true));
});

if (token) unlock();
