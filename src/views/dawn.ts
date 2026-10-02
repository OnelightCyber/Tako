import { Bridge, type SquadJob, type SquadReport } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { h, clear } from "./dom";
import { fit } from "./extra";
import { proIcon } from "./pro-icons";
import { shortTask } from "./squad";
import type { ViewActions, ViewHost } from "./views";

export const DawnUi = {
  onListen: () => {},
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n > 1 ? many : one}`;
}

export function nightJobs(report: SquadReport | null): SquadJob[] {
  if (!report) return [];
  return report.jobs.map((id) => State.squad.find((j) => j.id === id)).filter((j): j is SquadJob => !!j);
}

export function dawnSentence(report: SquadReport | null): string {
  if (!report) return "Rien à signaler cette nuit.";
  const jobs = nightJobs(report);
  const ready = jobs.filter((j) => j.status === "done").length;
  const merged = jobs.filter((j) => j.status === "merged").length;
  const stuck = report.empty + report.failed;
  const parts: string[] = [];
  const total = report.done + report.empty + report.failed;
  parts.push(`Cette nuit, j'ai lancé ${plural(total, "tâche", "tâches")}.`);
  if (ready) parts.push(`${plural(ready, "est prête", "sont prêtes")} à relire et à fusionner.`);
  if (merged) parts.push(`${plural(merged, "est déjà fusionnée", "sont déjà fusionnées")}.`);
  if (stuck) parts.push(`${plural(stuck, "s'est arrêtée", "se sont arrêtées")} en route.`);
  const blocked = jobs.find((j) => (j.status === "empty" || j.status === "failed") && j.note);
  if (blocked) parts.push(`Par exemple : ${shortTask(blocked.task, 60)}.`);
  return parts.join(" ");
}

export function buildDawn(actions: ViewActions): ViewHost {
  const title = h("div", { class: "dw-title", text: "Rapport de la nuit" });
  const summary = h("div", { class: "dw-summary" });
  const list = h("div", { class: "dw-list" });
  const listen = h("button", { class: "btn secondary" }, proIcon("speaker", 12, 2.2), h("span", { text: "Écouter" }));
  const board = h("button", { class: "btn primary" }, proIcon("rocket", 12, 2.2), h("span", { text: "Mission Control" }));
  listen.addEventListener("click", () => DawnUi.onListen());
  board.addEventListener("click", () => {
    actions.blip();
    actions.setView("squad");
  });
  const row = h("div", { class: "actions" }, board, listen);
  const body = h("div", { class: "stack dw-stack" }, title, summary, list, row);
  const el = h("div", { class: "view fits" }, h("div", { class: "card wash dw-card" }, body));
  let key = "";
  return {
    el,
    sync() {
      const report = State.squadReport;
      const jobs = nightJobs(report);
      const next = `${report?.at ?? 0}~${jobs.map((j) => `${j.id}:${j.status}`).join("|")}`;
      if (next !== key) {
        key = next;
        summary.textContent = dawnSentence(report);
        clear(list);
        for (const job of jobs.slice(0, 5)) {
          const ok = job.status === "done" || job.status === "merged";
          const icon = ok ? proIcon("check", 12, 2.6) : proIcon("info", 12, 2.2);
          const line = h("div", { class: `dw-job ${ok ? "ok" : "stuck"}` }, h("i", {}, icon), h("span", { class: "dw-task", text: shortTask(job.task, 60) }));
          if (job.files) line.append(h("span", { class: "dw-stats", text: `+${job.added} −${job.removed}` }));
          if (job.status === "done") {
            const merge = h("button", { class: "link-btn", text: "Fusionner" });
            merge.addEventListener("click", async () => {
              try {
                await Bridge.squadAction(job.id, "merge");
                Sound.play("approve");
              } catch (err) {
                Sound.play("error");
                State.noteMessage = String(err).replace(/^Error:\s*/, "");
                actions.setView("note");
              }
            });
            line.append(merge);
          }
          list.append(line);
        }
      }
      if (report && !report.seen && State.view === "dawn" && State.mode === "expanded") {
        report.seen = true;
        State.dawnPending = false;
        void Bridge.squadReportSeen();
      }
      if (State.view === "dawn") fit("dawn", el, body);
    },
  };
}
