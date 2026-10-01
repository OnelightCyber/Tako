import { Bridge, IS_TAURI, type UsageLine, type UsageReport } from "../core/bridge";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export function resetDate(text: string, now = new Date()): Date | null {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  let hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const meridiem = m[5]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const date = new Date(now.getFullYear(), month, Number(m[2]), hour, minute);
  if (date.getTime() < now.getTime() - 86_400_000) date.setFullYear(date.getFullYear() + 1);
  return date;
}

export function countdown(text: string, now = new Date()): string {
  const date = resetDate(text, now);
  if (!date) return text;
  const mins = Math.max(0, Math.round((date.getTime() - now.getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ${String(mins % 60).padStart(2, "0")}`;
  const days = Math.floor(hours / 24);
  return `${days} j ${hours % 24} h`;
}

export function tone(percent: number): string {
  if (percent >= 85) return "#F4505E";
  if (percent >= 60) return "#F5A524";
  return "#34D399";
}

export function shortLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("session")) return "5 h";
  if (l.includes("all models")) return "Semaine";
  const inner = /\(([^)]+)\)/.exec(label);
  if (l.includes("week") && inner) return inner[1];
  return label;
}

export function longLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("session")) return "Session de 5 h";
  if (l.includes("all models")) return "Semaine, tous modèles";
  const inner = /\(([^)]+)\)/.exec(label);
  if (l.includes("week") && inner) return `Semaine, ${inner[1]}`;
  return label;
}

export function ring(percent: number, size = 26, stroke = 3.2): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "ring");
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const track = document.createElementNS(ns, "circle");
  track.setAttribute("cx", String(size / 2));
  track.setAttribute("cy", String(size / 2));
  track.setAttribute("r", String(r));
  track.setAttribute("class", "ring-track");
  track.setAttribute("stroke-width", String(stroke));
  const bar = document.createElementNS(ns, "circle");
  bar.setAttribute("cx", String(size / 2));
  bar.setAttribute("cy", String(size / 2));
  bar.setAttribute("r", String(r));
  bar.setAttribute("class", "ring-bar");
  bar.setAttribute("stroke-width", String(stroke));
  bar.setAttribute("stroke", tone(percent));
  bar.setAttribute("stroke-dasharray", `${c}`);
  bar.setAttribute("stroke-dashoffset", `${c}`);
  bar.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  requestAnimationFrame(() => bar.setAttribute("stroke-dashoffset", `${c * (1 - Math.min(100, percent) / 100)}`));
  svg.append(track, bar);
  return svg;
}

export function mainLines(lines: UsageLine[]): UsageLine[] {
  const session = lines.find((l) => l.label.toLowerCase().includes("session"));
  const week = lines.find((l) => l.label.toLowerCase().includes("all models")) ?? lines.find((l) => l !== session);
  return [session, week].filter((l): l is UsageLine => !!l);
}

export async function fetchUsage(force: boolean): Promise<UsageReport | null> {
  const report = await Bridge.usageGet(force);
  if (!report && !IS_TAURI && import.meta.env.DEV) {
    const { demoUsage } = await import("../../dev/usage-demo");
    return demoUsage();
  }
  return report;
}

export function usageError(error: string | null | undefined): string {
  if (!error) return "Aucune limite";
  if (error.includes("not installed")) return "Claude Code n'est pas installé";
  if (error.includes("too long")) return "Claude Code ne répond pas";
  if (error.includes("No usage")) return "Pas de limite à afficher";
  return error;
}
