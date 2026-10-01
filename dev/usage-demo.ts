import type { UsageReport, UsageSample } from "../src/core/bridge";
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

export function demoHistory(): UsageSample[] {
  const out: UsageSample[] = [];
  const now = Math.floor(Date.now() / 1000);
  let week = 0;
  for (let h = 24 * 13; h >= 0; h -= 2) {
    const t = now - h * 3600;
    const day = new Date(t * 1000).getDay();
    if (day === 1 && new Date(t * 1000).getHours() < 2) week = 0;
    const busy = new Date(t * 1000).getHours();
    if (busy >= 9 && busy <= 23) week = Math.min(100, week + (day === 0 || day === 6 ? 1 : 2));
    const monday = new Date(t * 1000);
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
    const resets = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][monday.getMonth()]} ${monday.getDate()}, 7am (Europe/Paris)`;
    out.push({ t, session: (busy * 7) % 100, week, sessionResets: `s${Math.floor(h / 5)}`, weekResets: resets });
  }
  return out;
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
