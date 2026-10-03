import { Bridge, onEvent, type SquadBoard, type SquadJob } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { DawnUi, dawnSentence } from "../views/dawn";
import { shortTask } from "../views/squad";
import { announce } from "./voice";
import type { Island } from "./island";

const ACTIVE_MS = 60_000;

const seen = new Map<string, string>();
let first = true;

function notify(island: Island, job: SquadJob, was: string | undefined) {
  if (job.night || (State.mode === "expanded" && State.view === "squad")) return;
  const title = shortTask(job.task, 44);
  const open = () => island.setView("squad");
  switch (job.status) {
    case "done":
      island.hud({
        key: `squad-${job.id}`, banner: true, tone: "#34D399", icon: "rocket", title: "Mission prête à relire",
        detail: `${title} · +${job.added} −${job.removed}`, meta: "Mission Control", ms: 7000, priority: 2, onClick: open,
        actions: [{ label: "Relire", primary: true, run: open }],
      });
      Sound.play("finish");
      break;
    case "waiting":
      island.hud({
        key: `squad-${job.id}`, banner: true, tone: "#F5A524", icon: "message", title: "Une mission attend ta réponse",
        detail: title, meta: "Mission Control", ms: 8000, priority: 2, onClick: open,
        actions: [{ label: "Répondre", primary: true, run: () => void Bridge.squadAction(job.id, "open") }],
      });
      Sound.play("approval");
      break;
    case "failed":
      island.hud({
        key: `squad-${job.id}`, banner: true, tone: "#F4505E", icon: "rocket", title: "Mission en échec",
        detail: job.note || title, meta: "Mission Control", ms: 6500, priority: 2, onClick: open,
      });
      Sound.play("error");
      break;
    case "empty":
      if (was === "running") {
        island.hud({ key: `squad-${job.id}`, tone: "#9398a1", icon: "rocket", title: "Mission finie sans changement", detail: title, ms: 4000, priority: 1, onClick: open });
      }
      break;
    default:
      break;
  }
}

function apply(island: Island, board: SquadBoard | null) {
  if (!board) return;
  State.squad = board.jobs;
  State.squadReport = board.report;
  State.nightArmed = board.nightArmed;
  for (const job of board.jobs) {
    const was = seen.get(job.id);
    seen.set(job.id, job.status);
    if (!first && was !== job.status) notify(island, job, was);
  }
  for (const id of [...seen.keys()]) {
    if (!board.jobs.some((j) => j.id === id)) seen.delete(id);
  }
  first = false;
  if (board.report && !board.report.seen) State.dawnPending = true;
  State.notify();
}

async function maybeDawn(island: Island) {
  if (!State.dawnPending || State.gameMode || State.paused || State.mode === "expanded") return;
  const idle = await Bridge.idleMs();
  if (idle == null || idle > ACTIVE_MS || !State.dawnPending) return;
  State.dawnPending = false;
  island.alert("dawn");
  if (State.settings.voiceEnabled && State.settings.nightBriefing) {
    window.setTimeout(() => void announce(dawnSentence(State.squadReport)), 700);
  }
}

export function nightDeny(cwd: string | null | undefined): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  const c = norm(cwd ?? "");
  if (!c) return false;
  return State.squad.some((j) => {
    const w = norm(j.worktree);
    return j.night && j.status !== "queued" && (c === w || c.startsWith(`${w}\\`));
  });
}

export function registerSquad(island: Island) {
  DawnUi.onListen = () => void announce(dawnSentence(State.squadReport));
  void Bridge.squadBoard().then((b) => apply(island, b));
  void onEvent<SquadBoard>("squad", (b) => apply(island, b));
  void onEvent<null>("squad-dawn", () => {
    State.dawnPending = true;
    void maybeDawn(island);
  });
  window.setInterval(() => void maybeDawn(island), 15_000);
}
