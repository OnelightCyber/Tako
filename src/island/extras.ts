import { onEvent, type SystemStats, type Track, type UsageAlert, type UsageReport } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const VISIBLE_STATS_VIEWS = new Set(["overview", "system"]);

export function registerExtras(island: Island) {
  void onEvent<Track>("media", (track) => {
    const before = State.media;
    State.media = track.active ? track : null;
    const relevant = State.mode !== "hidden" || before?.playing !== track.playing;
    if (relevant) State.notify();
  });

  void onEvent<SystemStats>("system-stats", (stats) => {
    const first = State.stats == null;
    State.stats = stats;
    if (first || (State.mode === "expanded" && VISIBLE_STATS_VIEWS.has(State.view))) State.notify();
  });

  void onEvent<UsageReport>("usage-updated", (report) => {
    State.usage = report;
  });

  void onEvent<UsageAlert>("usage-alert", (alert) => {
    if (State.paused) return;
    State.usageAlert = alert;
    Sound.play("rate");
    if (!State.pendingApproval) island.alert("usage");
    State.notify();
  });

  void onEvent<number>("usage-recharged", () => {
    if (State.paused) return;
    Sound.play("love");
    if (State.mode !== "expanded" && !State.pendingApproval) {
      State.noteMessage = "Session de 5 h rechargée — limite remise à zéro.";
      island.alert("note");
    }
    State.notify();
  });

  void onEvent("mission-open", () => {
    if (State.paused) return;
    island.openMission();
  });
}
