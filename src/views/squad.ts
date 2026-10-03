import { Bridge, type SquadJob } from "../core/bridge";
import { baseName } from "../core/activity";
import { colorForProject, type BotStateName } from "../core/layout";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
import { createMiniBot, pruneMiniBots, syncMiniBotStates } from "../mascot/minibots";
import { h, clear } from "./dom";
import { contentHeight, islandBox, setSizeHint } from "./fit";
import { proIcon, type ProIconName } from "./pro-icons";
import type { ViewActions, ViewHost } from "./views";

const LABEL: Record<SquadJob["status"], string> = {
  queued: "En attente",
  running: "Au travail",
  waiting: "Attend ta réponse",
  done: "Prête à relire",
  empty: "Rien changé",
  failed: "Échec",
  merged: "Fusionnée",
  discarded: "Jetée",
};

const BOT: Record<SquadJob["status"], BotStateName> = {
  queued: "sleeping",
  running: "working",
  waiting: "approval",
  done: "finished",
  empty: "idle",
  failed: "error",
  merged: "finished",
  discarded: "idle",
};

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

export function shortTask(task: string, max = 44): string {
  const line = task.split(/\r?\n/).find((l) => l.trim())?.trim() ?? task.trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function squadJobFor(cwd: string | null | undefined): SquadJob | null {
  if (!cwd) return null;
  const c = norm(cwd);
  return State.squad.find((j) => c === norm(j.worktree) || c.startsWith(`${norm(j.worktree)}\\`)) ?? null;
}

export function isWorktree(path: string): boolean {
  return /[\\/]\.claude[\\/]worktrees[\\/]/i.test(path);
}

function liveTask(job: SquadJob): AgentTask | undefined {
  return job.session ? State.sessionTask(job.session) : undefined;
}

function botTask(job: SquadJob): AgentTask {
  const live = liveTask(job);
  return {
    id: `squad:${job.id}:${job.status}`,
    name: shortTask(job.task),
    color: colorForProject(job.id),
    state: job.status === "running" && live ? live.state : BOT[job.status],
    stepIndex: 0,
    steps: [],
    source: "claudeCode",
    isIntegration: false,
  };
}

function stepOf(job: SquadJob): string {
  if (job.status === "running") return liveTask(job)?.steps.at(-1) ?? "Démarrage…";
  if (job.status === "queued") return job.night ? `Cette nuit, dès ${State.settings.nightHour} h` : "Attend un agent libre";
  if (job.status === "merged") return job.note ? `Fusionnée · ${job.note}` : "Fusionnée";
  return job.note;
}

function stats(job: SquadJob): string {
  if (!job.files) return "";
  return `+${job.added} −${job.removed} · ${job.files} fichier${job.files > 1 ? "s" : ""}`;
}

function act(icon: ProIconName, title: string, run: () => void, kind = ""): HTMLElement {
  const b = h("button", { class: `sq-act ${kind}`.trim(), title }, proIcon(icon, 12, 2.2), h("span", { text: title }));
  b.addEventListener("mousedown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return b;
}

const CONFIRM_MS = 3000;

function sure(icon: ProIconName, title: string, run: () => void, kind = ""): HTMLElement {
  const label = h("span", { text: title });
  const b = h("button", { class: `sq-act ${kind}`.trim(), title }, proIcon(icon, 12, 2.2), label);
  let armed: number | null = null;
  const disarm = () => {
    if (armed != null) window.clearTimeout(armed);
    armed = null;
    label.textContent = title;
    b.classList.remove("confirm");
  };
  b.addEventListener("mousedown", (e) => e.stopPropagation());
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (armed == null) {
      label.textContent = "Sûr ?";
      b.classList.add("confirm");
      armed = window.setTimeout(disarm, CONFIRM_MS);
      return;
    }
    disarm();
    run();
  });
  return b;
}

interface Card {
  el: HTMLElement;
  shape: string;
  update(job: SquadJob): void;
}

const shapeOf = (job: SquadJob) => `${job.status}:${job.night ? 1 : 0}`;

export function buildSquad(actions: ViewActions): ViewHost {
  const input = h("input", { class: "chat-input", type: "text", placeholder: "Décris une tâche : un Claude s'en occupe dans sa propre copie du projet…", maxlength: "4000" }) as HTMLInputElement;
  const go = h("button", { class: "send-btn", title: "Lancer" }, proIcon("rocket", 14, 2));
  const now = h("button", { class: "sq-when on", text: "Maintenant" });
  const tonight = h("button", { class: "sq-when", text: "Cette nuit" });
  const when = h("div", { class: "sq-whens" }, now, tonight);
  const bar = h("div", { class: "chat-bar" }, input, go);
  const counts = h("span", { class: "sq-counts" });
  const head = h("div", { class: "sq-head" }, proIcon("rocket", 13, 2.2), h("b", { text: "Mission Control" }), counts, h("div", { class: "grow" }), when);
  const chips = h("div", { class: "ms-projects" });
  const status = h("div", { class: "ms-status" });
  const night = h("div", { class: "sq-night" });
  const grid = h("div", { class: "sq-grid" });
  const classic = h("button", { class: "link-btn sq-classic", text: "Mission dans un terminal" });
  classic.addEventListener("click", () => actions.setView("mission"));
  const foot = h("div", { class: "sq-foot" }, status, h("div", { class: "grow" }), classic);
  const body = h("div", { class: "stack sq-stack" }, head, bar, chips, night, grid, foot);
  const el = h("div", { class: "view" }, h("div", { class: "card sq-card" }, body));

  let selected: string | null = null;
  let custom: string | null = null;
  let atNight = false;
  let busy = false;
  let chipKey = "";
  const cards = new Map<string, Card>();
  const empty = h("div", { class: "sq-empty" },
    h("b", { text: "Plusieurs Claude, en même temps." }),
    h("span", { text: "Chacun travaille dans sa propre copie du projet (un worktree git) : rien ne touche ton dossier tant que tu n'as pas relu et fusionné." }));

  const setStatus = (text: string, kind: "" | "ok" | "err" = "") => {
    status.textContent = text;
    status.className = `ms-status ${kind}`;
  };

  const projects = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (p?: string | null) => {
      if (!p || isWorktree(p)) return;
      const k = norm(p);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(p);
    };
    add(custom);
    add(State.focusTask?.sessionCwd);
    for (const t of State.sessions) add(t.sessionCwd);
    for (const p of State.settings.recentProjects ?? []) add(p);
    for (const j of State.squad) add(j.repo);
    return out.slice(0, 4);
  };

  const setWhen = (n: boolean) => {
    atNight = n;
    now.classList.toggle("on", !n);
    tonight.classList.toggle("on", n);
    input.placeholder = n ? "Une tâche pour la nuit : Claude l'enchaîne pendant que tu dors…" : "Décris une tâche : un Claude s'en occupe dans sa propre copie du projet…";
    State.notify();
  };
  now.addEventListener("click", () => setWhen(false));
  tonight.addEventListener("click", () => setWhen(true));

  async function launch() {
    if (busy) return;
    const task = input.value.trim();
    if (!task) {
      input.focus();
      return;
    }
    if (!selected) {
      setStatus("Choisis le dossier du projet.", "err");
      return;
    }
    busy = true;
    setStatus(atNight ? "Ajout à la nuit…" : "Création de la copie du projet…");
    try {
      const board = await Bridge.squadAdd(selected, task, atNight);
      State.squad = board.jobs;
      State.nightArmed = board.nightArmed;
      input.value = "";
      Sound.play("send");
      setStatus(atNight ? "Ajoutée pour cette nuit." : "C'est parti : un Claude s'en occupe.", "ok");
    } catch (err) {
      setStatus(String(err).replace(/^Error:\s*/, ""), "err");
    } finally {
      busy = false;
      State.notify();
    }
  }

  async function run(job: SquadJob, action: "stop" | "discard" | "merge" | "diff" | "open") {
    try {
      const out = await Bridge.squadAction(job.id, action);
      if (action === "merge") {
        Sound.play("approve");
        setStatus(`Fusionnée dans ${job.base}${out ? ` · ${out}` : ""}.`, "ok");
      } else if (action === "discard") {
        Sound.play("blip");
        setStatus("Mission jetée, sa copie est supprimée.");
      }
    } catch (err) {
      Sound.play("error");
      setStatus(String(err).replace(/^Error:\s*/, ""), "err");
    }
    State.notify();
  }

  function renderCard(first: SquadJob): Card {
    let job = first;
    const status = h("span", { class: `sq-state ${job.status}`, text: LABEL[job.status] });
    const step = h("span", { class: "sq-step" });
    const stat = h("span", { class: "sq-stats" });
    const meta = h("div", { class: "sq-meta" }, status, step, stat);
    const row = h("div", { class: "sq-acts" });
    const does = (action: "stop" | "discard" | "merge" | "diff" | "open") => () => void run(job, action);
    switch (job.status) {
      case "queued":
        row.append(sure("x", "Retirer", does("discard")));
        break;
      case "running":
        row.append(act("review", "Diff", does("diff")), act("terminal", "Ouvrir", does("open")), act("stop", "Arrêter", does("stop")));
        break;
      case "waiting":
        row.append(act("message", "Répondre", does("open"), "primary"), act("stop", "Arrêter", does("stop")));
        break;
      case "done":
        row.append(act("commit", "Fusionner", does("merge"), "primary"), act("review", "Diff", does("diff")), act("terminal", "Continuer", does("open")), sure("trash", "Jeter", does("discard"), "danger"));
        break;
      case "empty":
        row.append(act("terminal", "Ouvrir", does("open")), sure("trash", "Jeter", does("discard"), "danger"));
        break;
      case "failed":
        row.append(sure("trash", "Jeter", does("discard"), "danger"));
        break;
      default:
        break;
    }
    const task = h("div", { class: "sq-task" });
    const el = h(
      "div",
      { class: `sq-job ${job.status}` },
      h("div", { class: "sq-top" }, createMiniBot(botTask(job), 18), task, job.night ? h("i", { class: "sq-moon", title: "Cette nuit" }, proIcon("moon", 11, 2.2)) : null),
      meta,
      row,
    );
    const update = (next: SquadJob) => {
      job = next;
      el.title = job.task;
      task.textContent = shortTask(job.task, 80);
      const st = stepOf(job);
      step.textContent = st;
      step.style.display = st ? "" : "none";
      const counts = stats(job);
      stat.textContent = counts;
      stat.style.display = counts ? "" : "none";
      syncMiniBotStates([botTask(job)]);
    };
    update(job);
    return { el, shape: shapeOf(job), update };
  }

  go.addEventListener("click", () => void launch());
  input.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter") {
      e.preventDefault();
      void launch();
    } else if (k === "Escape") {
      e.preventDefault();
      actions.collapse();
    }
    e.stopPropagation();
  });

  return {
    el,
    sync() {
      const list = projects();
      if (!selected || !list.some((p) => p === selected)) selected = list[0] ?? null;
      const ck = `${list.join("|")}~${selected}`;
      if (ck !== chipKey) {
        chipKey = ck;
        clear(chips);
        for (const p of list) {
          const chip = h("button", { class: `ms-chip${p === selected ? " on" : ""}`, title: p }, proIcon("folder", 11, 2.2), h("span", { text: baseName(p) }));
          chip.addEventListener("click", () => {
            selected = p;
            chipKey = "";
            State.notify();
          });
          chips.append(chip);
        }
        const other = h("button", { class: "ms-chip ghost" }, h("span", { text: list.length ? "Autre dossier…" : "Choisir le dossier du projet…" }));
        other.addEventListener("click", async () => {
          const picked = await Bridge.pickFolder();
          if (picked) {
            custom = picked;
            selected = picked;
            chipKey = "";
            State.notify();
          }
        });
        chips.append(other);
      }

      const open = State.squad.filter((j) => j.status !== "discarded");
      const working = open.filter((j) => j.status === "running" || j.status === "waiting").length;
      const ready = open.filter((j) => j.status === "done").length;
      const parts = [working ? `${working} au travail` : "", ready ? `${ready} à relire` : ""].filter(Boolean);
      counts.textContent = parts.join(" · ");

      const nightJobs = open.filter((j) => j.night && j.status === "queued");
      night.style.display = atNight || nightJobs.length ? "" : "none";
      clear(night);
      if (atNight || nightJobs.length) {
        night.append(proIcon("moon", 12, 2.2), h("span", { text: nightJobs.length ? `${nightJobs.length} tâche${nightJobs.length > 1 ? "s" : ""} cette nuit, dès ${State.settings.nightHour} h` : `La nuit commence à ${State.settings.nightHour} h` }));
        night.append(h("span", { class: "sq-policy", text: State.settings.nightPolicy === "auto" ? "· mode auto de Claude" : "· modifs et tests seulement" }));
        if (nightJobs.length) {
          const start = h("button", { class: "link-btn", text: "Lancer maintenant" });
          start.addEventListener("click", () => {
            void Bridge.squadNightNow();
            Sound.play("send");
            setStatus("L'équipe de nuit démarre.", "ok");
          });
          night.append(h("div", { class: "grow" }), start);
        }
      }

      const order: SquadJob["status"][] = ["waiting", "done", "running", "queued", "empty", "failed", "merged"];
      const sorted = [...open].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.created - a.created);
      const ids = new Set(sorted.map((j) => j.id));
      let removed = false;
      for (const [id, c] of cards) {
        if (ids.has(id)) continue;
        c.el.remove();
        cards.delete(id);
        removed = true;
      }
      if (!sorted.length) {
        if (!empty.isConnected) grid.append(empty);
      } else {
        empty.remove();
        sorted.forEach((job, i) => {
          let c = cards.get(job.id);
          if (c && c.shape !== shapeOf(job)) {
            c.el.remove();
            cards.delete(job.id);
            removed = true;
            c = undefined;
          }
          if (c) c.update(job);
          else {
            c = renderCard(job);
            cards.set(job.id, c);
          }
          if (grid.children[i] !== c.el) grid.insertBefore(c.el, grid.children[i] ?? null);
        });
      }
      if (removed) pruneMiniBots();
      grid.classList.toggle("scroll", grid.scrollHeight > grid.clientHeight + 4);
      if (State.view === "squad") {
        const box = islandBox(el);
        if (box) {
          const natural = contentHeight(body) - grid.offsetHeight + contentHeight(grid);
          setSizeHint("squad", 0, box.h - body.clientHeight + natural);
        }
      }
    },
    focus() {
      input.focus();
    },
  };
}
