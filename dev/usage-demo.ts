import type { UsageReport } from "../src/core/bridge";
import type { Island } from "../src/island/island";
import { State } from "../src/core/state";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function stamp(ms: number): string {
  const d = new Date(Date.now() + ms);
  const hour = d.getHours();
  const minute = d.getMinutes();
  const clock = `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}${hour < 12 ? "am" : "pm"}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock} (Europe/Paris)`;
}

export function demoUsage(): UsageReport {
  return {
    lines: [
      { label: "Current session", percent: 30, resets: stamp(90 * 60_000) },
      { label: "Current week (all models)", percent: 50, resets: stamp(5.6 * 86_400_000) },
      { label: "Current week (Fable)", percent: 12, resets: stamp(5.6 * 86_400_000) },
    ],
    subscription: true,
    fetchedAt: Math.floor(Date.now() / 1000) - 120,
    error: null,
  };
}

export function runUsageDemo(island: Island) {
  const show = () => {
    State.isPinned = true;
    island.alert("prompt");
    State.chatHistory.push(
      { id: 1, role: "user", content: "/usage" },
      { id: 2, role: "assistant", content: "", usage: demoUsage() },
    );
    State.notify();
  };
  let greeted = false;
  let waited = 0;
  const tick = () => {
    waited += 250;
    if (State.view === "greeting") greeted = true;
    else if (greeted || waited > 15_000) return show();
    window.setTimeout(tick, 250);
  };
  tick();
}
