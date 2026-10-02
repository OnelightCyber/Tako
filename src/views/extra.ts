import { vizEl } from "./viz";
import { h, svg, clear, dot } from "./dom";
import { proIcon, type ProIconName } from "./pro-icons";
import { fileBadge } from "./highlight";
import { renderDiff } from "./session";
import { contentHeight, islandBox, setSizeHint } from "./fit";
import { Bridge } from "../core/bridge";
import { baseName } from "../core/activity";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { countdown, resetDate, tone } from "../usage/gauge";
import type { ViewActions, ViewHost } from "./views";

const FILLED = {
  toggle: "M7 4.5v15l12.5-7.5z",
  pause: "M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z",
  next: "M5 5l9 7-9 7zM16 5h3v14h-3z",
  previous: "M19 5l-9 7 9 7zM5 5h3v14H5z",
};

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()} h ${String(d.getMinutes()).padStart(2, "0")}`;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function card(wash: Wash, ...children: Node[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(label: string, kind: "primary" | "secondary" | "danger", onClick: () => void, icon?: ProIconName): HTMLButtonElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    icon ? proIcon(icon, 12, 2.2) : null,
    h("span", { text: label }),
  ) as HTMLButtonElement;
}

export interface LiveRing {
  el: SVGSVGElement;
  set(percent: number | null): void;
}

export function liveRing(size: number, stroke: number): LiveRing {
  const ns = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(ns, "svg");
  el.setAttribute("viewBox", `0 0 ${size} ${size}`);
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  el.setAttribute("class", "ring");
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const circle = (cls: string) => {
    const k = document.createElementNS(ns, "circle");
    k.setAttribute("cx", String(size / 2));
    k.setAttribute("cy", String(size / 2));
    k.setAttribute("r", String(r));
    k.setAttribute("class", cls);
    k.setAttribute("stroke-width", String(stroke));
    return k;
  };
  const track = circle("ring-track");
  const bar = circle("ring-bar");
  bar.setAttribute("stroke-dasharray", String(c));
  bar.setAttribute("stroke-dashoffset", String(c));
  bar.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  el.append(track, bar);
  return {
    el,
    set(percent) {
      const p = percent == null ? 0 : Math.max(0, Math.min(100, percent));
      bar.setAttribute("stroke-dashoffset", String(c * (1 - p / 100)));
      bar.setAttribute("stroke", percent == null ? "rgba(255,255,255,0.15)" : tone(p));
    },
  };
}

export function contextPercent(task: AgentTask | null | undefined): number | null {
  const c = task?.context;
  if (!c || !c.window) return null;
  return Math.min(100, Math.round((c.used / c.window) * 100));
}

export function contextBadge(task: AgentTask): HTMLElement | null {
  const percent = contextPercent(task);
  if (percent == null || !task.context) return null;
  const ring = liveRing(14, 2.4);
  ring.set(percent);
  return h(
    "span",
    { class: "ctx-badge", title: `Contexte : ${compact(task.context.used)} / ${compact(task.context.window)} tokens` },
    ring.el,
    h("span", { text: `${percent} %` }),
  );
}

export function fit(view: IslandViewName, el: HTMLElement, body: HTMLElement, extraW = 0) {
  const box = islandBox(el);
  if (!box) return;
  setSizeHint(view, extraW ? box.w + extraW : 0, box.h - body.clientHeight + contentHeight(body));
}

export function buildReview(actions: ViewActions): ViewHost {
  const name = h("div", { class: "s-name" });
  const sub = h("div", { class: "s-sub", text: "veut modifier un fichier" });
  const counts = h("div", { class: "rv-counts" });
  const queue = h("div", { class: "rv-queue" });
  const allow = btn("Valider", "primary", () => actions.decide("allow"), "check");
  const deny = btn("Refuser", "secondary", () => actions.decide("deny"), "x");
  const all = h("button", { class: "link-btn rv-all", text: "Tout valider pour ce tour", onclick: () => actions.decide("all") });
  const left = h("div", { class: "s-left rv-left" }, name, sub, counts, h("div", { class: "rv-actions" }, allow, deny), all, queue);

  const badge = h("span", { class: "p-badge" });
  const file = h("span", { class: "p-name" });
  const path = h("span", { class: "p-path" });
  const head = h("div", { class: "p-head" }, badge, file, h("i", { class: "p-dot running" }), path);
  const body = h("div", { class: "p-body" });
  const panel = h("div", { class: "s-panel" }, head, body);
  const el = h("div", { class: "view session review" }, h("div", { class: "card session-card rv-card" }, left, panel));

  let key = "";
  return {
    el,
    sync() {
      const req = State.pendingApproval;
      if (!req || req.kind !== "review") return;
      const fresh = Date.now() - (req.shownAt ?? 0) < 700;
      allow.classList.toggle("guard", fresh);
      all.classList.toggle("guard", fresh);
      const task = State.tasks.find((t) => t.id === req.taskId);
      name.textContent = task?.name ?? "Claude Code";
      const preview = req.review;
      const target = preview?.path || req.command;
      const fileName = baseName(target);
      clear(counts);
      if (preview?.created) counts.append(h("span", { class: "rv-new", text: "nouveau fichier" }));
      if (preview && !preview.unknown && !preview.unreadable) {
        counts.append(h("span", { class: "add", text: `+${preview.added}` }), h("span", { class: "del", text: `−${preview.removed}` }));
      }
      queue.textContent = State.approvalQueue.length ? `+${State.approvalQueue.length} en attente` : "";
      if (key !== req.requestId) {
        key = req.requestId;
        const b = fileBadge(fileName);
        badge.textContent = b.label;
        badge.style.background = `${b.color}26`;
        badge.style.color = b.color;
        file.textContent = fileName;
        path.textContent = target;
        path.title = target;
        clear(body);
        if (preview?.lines?.length) {
          renderDiff(body, preview.lines, true, b.ext, false);
          if (preview.truncated) body.append(h("div", { class: "plain dim", text: "… diff coupé, trop long pour l'aperçu" }));
        } else {
          const why = preview?.unreadable ? "Fichier binaire ou trop gros pour l'aperçu." : "Aperçu indisponible pour cette modification.";
          body.append(h("div", { class: "plain dim", text: why }));
        }
      }
      if (State.view === "review") {
        let longest = 0;
        for (const tx of Array.from(body.querySelectorAll<HTMLElement>(".code-rows .tx"))) longest = Math.max(longest, (tx.textContent ?? "").length);
        const box = islandBox(el);
        if (box) {
          const wanted = longest ? longest * 6.6 + 62 : 0;
          const w = wanted ? box.w - panel.clientWidth + wanted : 0;
          setSizeHint("review", w, box.h - body.clientHeight + contentHeight(body));
        }
      }
    },
  };
}

type FinishMode = "idle" | "writing" | "editing" | "committing" | "confirmUndo" | "undoing";

export function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div", { class: "who-row" });
  const title = h("div", { class: "title fin-title" });
  const stats = h("div", { class: "fin-stats" });
  const editor = h("textarea", { class: "fin-editor", rows: "3", spellcheck: "false" }) as HTMLTextAreaElement;
  const row = h("div", { class: "actions fin-actions" });
  const note = h("div", { class: "fin-note" });
  const body = h("div", { class: "stack fin-stack" }, who, title, stats, editor, row, note);
  const el = h("div", { class: "view" }, card("green", body));

  let mode: FinishMode = "idle";
  let noteText = "";
  let noteKind: "" | "ok" | "err" = "";
  let committed = "";
  let key = "";
  let shownFor = "";

  const say = (text: string, kind: "" | "ok" | "err" = "") => {
    noteText = text;
    noteKind = kind;
    key = "";
    State.notify();
  };
  const setMode = (m: FinishMode) => {
    const wasEditing = mode === "editing";
    mode = m;
    key = "";
    if (m === "editing") {
      void Bridge.focusWindow(true);
      window.setTimeout(() => editor.focus(), 120);
    } else if (wasEditing) {
      void Bridge.focusWindow(false);
    }
    State.notify();
  };

  async function writeMessage(task: AgentTask) {
    if (!task.sessionId || !task.sessionCwd) return;
    setMode("writing");
    say("");
    try {
      editor.value = await Bridge.sessionCommitMessage(task.sessionId, task.sessionCwd);
      setMode("editing");
    } catch (err) {
      setMode("idle");
      say(String(err).replace(/^Error:\s*/, ""), "err");
    }
  }

  async function commit(task: AgentTask) {
    if (!task.sessionId || !task.sessionCwd) return;
    setMode("committing");
    try {
      const hash = await Bridge.sessionCommit(task.sessionId, task.sessionCwd, editor.value);
      committed = hash;
      Sound.play("approve");
      setMode("idle");
      say(`Commit ${hash} créé`, "ok");
    } catch (err) {
      setMode("editing");
      say(String(err).replace(/^Error:\s*/, ""), "err");
    }
  }

  async function undo(task: AgentTask) {
    if (!task.sessionId) return;
    setMode("undoing");
    try {
      const report = await Bridge.sessionUndo(task.sessionId);
      const restored = report.restored.length;
      const skipped = report.skipped.length;
      const summary = await Bridge.sessionSummary(task.sessionId, task.sessionCwd ?? "");
      const before = task.turn;
      if (summary) task.turn = { ...summary, tokens: before?.tokens ?? 0, outputTokens: before?.outputTokens ?? 0, durationMs: before?.durationMs ?? summary.durationMs };
      else if (before) task.turn = { ...before, undone: true };
      Sound.play("blip");
      setMode("idle");
      say(
        `${restored} fichier${restored > 1 ? "s" : ""} restauré${restored > 1 ? "s" : ""}${skipped ? ` · ${skipped} ignoré${skipped > 1 ? "s" : ""} (modifié${skipped > 1 ? "s" : ""} depuis)` : ""}`,
        skipped ? "err" : "ok",
      );
    } catch (err) {
      setMode("idle");
      say(String(err).replace(/^Error:\s*/, ""), "err");
    }
  }

  return {
    el,
    sync() {
      const task = State.focusTask;
      if (!task) return;
      if (shownFor !== task.id + (task.turn?.durationMs ?? "")) {
        if (shownFor.split("~")[0] !== task.id) {
          mode = "idle";
          noteText = "";
          committed = "";
        }
        shownFor = task.id + (task.turn?.durationMs ?? "");
      }
      const turn = task.turn;
      const ctx = contextPercent(task);
      const k = [task.id, task.finalMessage, turn?.files.length, turn?.added, turn?.removed, turn?.undone, turn?.tokens, mode, noteText, committed, ctx].join("~");
      if (k !== key) {
        key = k;
        clear(who);
        who.append(dot(task.color, 8), h("span", { class: "n", text: task.name }), h("span", { text: task.origin === "mission" ? "mission terminée" : "Claude Code a fini" }));
        if (turn) who.append(h("span", { class: "fin-dim", text: `· ${duration(turn.durationMs)}` }));
        title.textContent = task.finalMessage || "Terminé.";

        clear(stats);
        if (turn && turn.files.length) {
          stats.append(
            h("span", { class: "fin-chip" }, proIcon("file", 11, 2.2), h("span", { text: `${turn.files.length} fichier${turn.files.length > 1 ? "s" : ""}` })),
            h("span", { class: "fin-chip" }, h("span", { class: "add", text: `+${turn.added}` }), h("span", { class: "del", text: `−${turn.removed}` })),
          );
        }
        if (turn && turn.tokens) stats.append(h("span", { class: "fin-chip", title: `${compact(turn.outputTokens)} écrits` }, proIcon("bolt", 11, 2.2), h("span", { text: `${compact(turn.tokens)} tokens` })));
        if (ctx != null) stats.append(h("span", { class: "fin-chip" }, h("span", { text: `contexte ${ctx} %` })));
        if (turn?.undone) stats.append(h("span", { class: "fin-chip warn", text: "annulé" }));

        editor.style.display = mode === "editing" || mode === "committing" ? "" : "none";
        editor.disabled = mode === "committing";

        clear(row);
        const files = !!turn && turn.files.length > 0 && !turn.undone;
        if (mode === "editing" || mode === "committing") {
          row.append(
            btn(mode === "committing" ? "Commit…" : "Committer", "primary", () => void commit(task), "commit"),
            btn("Annuler", "secondary", () => setMode("idle")),
          );
        } else if (mode === "confirmUndo" || mode === "undoing") {
          row.append(
            btn(mode === "undoing" ? "Annulation…" : "Oui, tout annuler", "danger", () => void undo(task), "undo"),
            btn("Non", "secondary", () => setMode("idle")),
          );
        } else {
          if (files && turn?.git && !committed) {
            row.append(btn(mode === "writing" ? "Claude écrit le message…" : "Commit", "primary", () => {
              if (mode === "idle") void writeMessage(task);
            }, "commit"));
          }
          if (files) {
            row.append(btn("Voir le diff", "secondary", () => {
              if (task.sessionId) void Bridge.sessionDiff(task.sessionId, task.name).catch((e) => say(String(e).replace(/^Error:\s*/, ""), "err"));
            }, "code"));
            row.append(btn("Annuler", "secondary", () => setMode("confirmUndo"), "undo"));
          } else {
            row.append(btn("Ouvrir", "primary", () => actions.openTerminal(), "external"));
          }
          row.append(btn("OK", "secondary", () => actions.collapse()));
        }
        note.textContent = noteText;
        note.className = `fin-note ${noteKind}`;
      }
      if (State.view === "finished") fit("finished", el, body);
    },
  };
}

export function buildMission(actions: ViewActions): ViewHost {
  const input = h("input", { class: "chat-input", type: "text", placeholder: "Décris la mission pour Claude Code…", maxlength: "4000" }) as HTMLInputElement;
  const go = h("button", { class: "send-btn", title: "Lancer" }, proIcon("rocket", 14, 2));
  const bar = h("div", { class: "chat-bar" }, input, go);
  const chips = h("div", { class: "ms-projects" });
  const status = h("div", { class: "ms-status" });
  const head = h("div", { class: "ms-head" }, proIcon("rocket", 13, 2.2), h("b", { text: "Nouvelle mission" }), h("span", { text: "Claude Code s'ouvre dans un terminal, Tako suit tout en live." }));
  const body = h("div", { class: "stack ms-stack" }, head, bar, chips, status);
  const el = h("div", { class: "view" }, card(null, body));

  let selected: string | null = null;
  let custom: string | null = null;
  let busy = false;
  let key = "";

  const projects = (): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (p?: string | null) => {
      if (!p) return;
      const k = p.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(p);
    };
    add(custom);
    add(State.focusTask?.sessionCwd);
    for (const t of State.sessions) add(t.sessionCwd);
    for (const p of State.settings.recentProjects ?? []) add(p);
    return out.slice(0, 4);
  };

  const setStatus = (text: string, kind: "" | "ok" | "err" = "") => {
    status.textContent = text;
    status.className = `ms-status ${kind}`;
    State.notify();
  };

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
    setStatus("Lancement…");
    try {
      await Bridge.missionStart(task, selected);
      Sound.play("send");
      input.value = "";
      setStatus("Mission lancée — la session apparaît dès que Claude démarre.", "ok");
      window.setTimeout(() => {
        if (State.view === "mission") actions.collapse();
      }, 1600);
    } catch (err) {
      setStatus(String(err).replace(/^Error:\s*/, ""), "err");
    } finally {
      busy = false;
    }
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
      const k = `${list.join("|")}~${selected}`;
      if (k !== key) {
        key = k;
        clear(chips);
        for (const p of list) {
          const chip = h("button", { class: `ms-chip${p === selected ? " on" : ""}`, title: p }, proIcon("folder", 11, 2.2), h("span", { text: baseName(p) }));
          chip.addEventListener("click", () => {
            selected = p;
            key = "";
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
            key = "";
            State.notify();
          }
        });
        chips.append(other);
      }
      if (State.view === "mission") fit("mission", el, body);
    },
    focus() {
      if (State.missionDraft) {
        input.value = State.missionDraft;
        State.missionDraft = null;
        setStatus("Vérifie la mission et le dossier, puis lance-la.");
      }
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  };
}

function control(action: "toggle" | "next" | "previous", size: number): HTMLButtonElement {
  const b = h("button", { class: `mu-btn ${action}`, title: action === "toggle" ? "Lecture / pause" : action === "next" ? "Suivant" : "Précédent" }) as HTMLButtonElement;
  b.append(svg(FILLED[action], size));
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    Sound.play("blip");
    if (action === "toggle" && State.media) {
      State.media = { ...State.media, playing: !State.media.playing, positionMs: livePosition(), atMs: Date.now() };
      State.notify();
    }
    void Bridge.mediaControl(action);
  });
  return b;
}

export function livePosition(): number {
  const m = State.media;
  if (!m) return 0;
  const pos = m.playing ? m.positionMs + (Date.now() - m.atMs) : m.positionMs;
  return m.durationMs ? Math.min(pos, m.durationMs) : pos;
}

function setArt(box: HTMLElement, art: string | null, size: number) {
  const current = box.dataset.art ?? "";
  if (current === (art ?? "")) return;
  box.dataset.art = art ?? "";
  clear(box);
  if (art && art.startsWith("data:image/")) {
    box.append(h("img", { src: art, alt: "" }));
  } else {
    box.append(proIcon("music", Math.round(size * 0.42), 1.8));
  }
}

export function buildMusic(): ViewHost {
  const art = h("div", { class: "mu-art" });
  const title = h("div", { class: "mu-title" });
  const artist = h("div", { class: "mu-artist" });
  const fill = h("i");
  const bar = h("div", { class: "mu-bar" }, fill);
  const elapsed = h("span");
  const total = h("span");
  const times = h("div", { class: "mu-times" }, elapsed, total);
  const play = control("toggle", 18);
  const controls = h("div", { class: "mu-controls" }, control("previous", 14), play, control("next", 14));
  const viz = vizEl(5, "mu-viz");
  const info = h("div", { class: "mu-info" }, h("div", { class: "mu-head" }, title, viz), artist, bar, times, controls);
  const el = h("div", { class: "view" }, card(null, h("div", { class: "mu-body" }, art, info)));

  const progress = () => {
    const m = State.media;
    if (!m || !m.durationMs) {
      fill.style.width = "0%";
      elapsed.textContent = "";
      total.textContent = "";
      return;
    }
    const pos = livePosition();
    fill.style.width = `${Math.min(100, (pos / m.durationMs) * 100)}%`;
    elapsed.textContent = mmss(pos);
    total.textContent = `\u2212${mmss(Math.max(0, m.durationMs - pos))}`;
  };
  window.setInterval(() => {
    if (State.view === "music" && State.mode === "expanded" && State.media?.playing) progress();
  }, 500);

  return {
    el,
    sync() {
      const m = State.media;
      setArt(art, m?.active ? m.art : null, 92);
      title.textContent = m?.active ? m.title : "Rien ne joue";
      viz.style.display = m?.active ? "" : "none";
      viz.classList.toggle("paused", !m?.playing);
      artist.textContent = m?.active ? [m.artist, m.app].filter(Boolean).join(" · ") : "Lance une musique ou une vidéo.";
      clear(play);
      play.append(svg(m?.playing ? FILLED.pause : FILLED.toggle, 18));
      controls.classList.toggle("off", !m?.active);
      progress();
    },
  };
}

export interface MediaPill {
  el: HTMLElement;
  update(): void;
}

export function mediaPill(actions: ViewActions): MediaPill {
  const art = h("div", { class: "pill-art" });
  const label = h("span", { class: "lbl media" });
  const eq = vizEl(3, "pill-viz");
  const el = h("div", { class: "pill media-pill", title: "Musique", onclick: () => actions.setView("music") }, art, label, eq);
  return {
    el,
    update() {
      const m = State.media;
      setArt(art, m?.art ?? null, 22);
      label.textContent = m?.title ?? "";
      eq.classList.toggle("paused", !m?.playing);
    },
  };
}

export function statsPill(actions: ViewActions): MediaPill {
  const bars = ["cpu", "ram", "gpu"].map(() => h("i"));
  const meter = h("div", { class: "sys-mini" }, ...bars);
  const label = h("span", { class: "lbl sys" });
  const el = h("div", { class: "pill sys-pill", title: "Ton PC", onclick: () => actions.setView("system") }, meter, label);
  return {
    el,
    update() {
      const s = State.stats;
      const values = [s?.cpu ?? 0, s?.ram ?? 0, s?.gpu ?? 0];
      bars.forEach((b, i) => {
        b.style.height = `${Math.max(8, values[i])}%`;
        b.style.background = tone(values[i]);
      });
      label.textContent = s ? `CPU ${Math.round(s.cpu)} %` : "PC";
    },
  };
}

export function buildSystem(): ViewHost {
  const make = (name: string) => {
    const ring = liveRing(58, 6);
    const value = h("b");
    const sub = h("span", { class: "sys-sub" });
    const el = h("div", { class: "sys-gauge" }, h("div", { class: "sys-ring" }, ring.el, value), h("div", { class: "sys-name", text: name }), sub);
    return { el, ring, value, sub };
  };
  const cpu = make("Processeur");
  const ram = make("Mémoire");
  const gpu = make("Carte graphique");
  const el = h("div", { class: "view" }, card(null, h("div", { class: "sys-body" }, cpu.el, ram.el, gpu.el)));
  return {
    el,
    sync() {
      const s = State.stats;
      cpu.ring.set(s ? s.cpu : null);
      cpu.value.textContent = s ? `${Math.round(s.cpu)}%` : "—";
      cpu.sub.textContent = "";
      ram.ring.set(s ? s.ram : null);
      ram.value.textContent = s ? `${Math.round(s.ram)}%` : "—";
      ram.sub.textContent = s ? `${s.ramUsedGb.toFixed(1)} / ${s.ramTotalGb.toFixed(0)} Go` : "";
      gpu.ring.set(s?.gpu ?? null);
      gpu.value.textContent = s?.gpu != null ? `${Math.round(s.gpu)}%` : "—";
      gpu.sub.textContent = s?.gpu != null ? "3D" : "indisponible";
    },
  };
}

export function buildUsageAlert(actions: ViewActions): ViewHost {
  const ring = liveRing(64, 6.5);
  const value = h("b");
  const title = h("div", { class: "title" });
  const sub = h("div", { class: "sub" });
  const row = h("div", { class: "actions" }, btn("OK", "secondary", () => actions.collapse()));
  const body = h("div", { class: "stack ua-stack" }, title, sub, row);
  const el = h("div", { class: "view" }, card("amber", h("div", { class: "ua-ring" }, ring.el, value), body));
  return {
    el,
    sync() {
      const a = State.usageAlert;
      if (!a) return;
      ring.set(a.percent);
      value.textContent = `${a.percent}%`;
      title.textContent = `${a.kind === "session" ? "Session de 5 h" : "Semaine"} à ${a.percent} %`;
      const reset = resetDate(a.resets);
      const hit = a.forecastAt ? a.forecastAt * 1000 : null;
      if (hit && (!reset || hit < reset.getTime())) {
        sub.textContent = `À ce rythme, limite atteinte vers ${clock(hit)}. Reset dans ${countdown(a.resets)}.`;
      } else {
        sub.textContent = `Reset dans ${countdown(a.resets)}.`;
      }
    },
  };
}
