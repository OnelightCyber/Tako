import { Bridge, type HookStatus } from "../core/bridge";
import type { Settings } from "../core/state";
import type { ProIconName } from "../views/pro-icons";
import type { Tone } from "./ui";

export type PageId =
  | "home"
  | "general"
  | "appearance"
  | "claude"
  | "chat"
  | "voice"
  | "squad"
  | "usage"
  | "live"
  | "notifications"
  | "lens"
  | "system"
  | "network"
  | "game"
  | "integrations"
  | "about";

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string;
}

export interface Ctx {
  settings: Settings;
  version: string;
  hooks: HookStatus;
  cc: { found: boolean; path: string; version: string };
  hasKey: boolean;
  present: Record<string, boolean>;
  update: UpdateInfo | null;
}

export interface NavItem {
  id: PageId;
  label: string;
  icon: ProIconName;
  tone: Tone;
}

export const NAV: { group: string; items: NavItem[] }[] = [
  { group: "", items: [{ id: "home", label: "Accueil", icon: "home", tone: "orange" }] },
  {
    group: "Tako",
    items: [
      { id: "general", label: "Général", icon: "sliders", tone: "gray" },
      { id: "appearance", label: "Apparence", icon: "sparkles", tone: "purple" },
    ],
  },
  {
    group: "Claude",
    items: [
      { id: "claude", label: "Claude Code", icon: "code", tone: "orange" },
      { id: "chat", label: "Chat & agent", icon: "chat", tone: "blue" },
      { id: "voice", label: "Assistant vocal", icon: "mic", tone: "orange" },
      { id: "squad", label: "Mission Control", icon: "rocket", tone: "indigo" },
      { id: "usage", label: "Utilisation", icon: "gauge", tone: "amber" },
    ],
  },
  {
    group: "Îlot dynamique",
    items: [
      { id: "live", label: "Activités en direct", icon: "layers", tone: "green" },
      { id: "notifications", label: "Notifications", icon: "bell", tone: "red" },
      { id: "lens", label: "Lentille", icon: "clipboard", tone: "cyan" },
      { id: "system", label: "Système", icon: "cpu", tone: "cyan" },
      { id: "network", label: "Réseau & sécurité", icon: "shield", tone: "indigo" },
      { id: "game", label: "Mode jeu", icon: "gamepad", tone: "pink" },
    ],
  },
  {
    group: "Plus",
    items: [
      { id: "integrations", label: "Intégrations", icon: "plug", tone: "purple" },
      { id: "about", label: "À propos", icon: "info", tone: "gray" },
    ],
  },
];

export function navItem(id: PageId): NavItem {
  for (const g of NAV) {
    const found = g.items.find((i) => i.id === id);
    if (found) return found;
  }
  return NAV[0].items[0];
}

export const app = {
  ctx: null as unknown as Ctx,
  go: (_id: PageId, _focus?: string) => {},
  toast: (_text: string, _kind: "ok" | "err" = "ok") => {},
  refresh: () => {},
};

export async function save(message = "Enregistré") {
  await Bridge.saveSettings(app.ctx.settings);
  app.toast(message);
  app.refresh();
}

export function set<K extends keyof Settings>(key: K, value: Settings[K], message?: string) {
  app.ctx.settings[key] = value;
  void save(message);
}

export function errText(err: unknown): string {
  return String(err).replace(/^Error:\s*/, "");
}
