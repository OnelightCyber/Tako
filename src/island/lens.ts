import { Bridge, onEvent, type LensInfo } from "../core/bridge";
import { middle, type HudSpec } from "../core/hud";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { ChatBus } from "../views/chat";
import type { Island } from "./island";

const COOLDOWN_MS: Record<LensInfo["kind"], number> = {
  error: 8_000,
  english: 90_000,
  tracking: 10_000,
  address: 10_000,
};
const MISSION_MAX = 3800;

const last = new Map<string, number>();

export interface Carrier {
  name: string;
  url: string;
}

export function carrier(code: string): Carrier {
  const c = code.trim().toUpperCase();
  const q = encodeURIComponent(c);
  if (/^1Z[0-9A-Z]{16}$/.test(c)) return { name: "UPS", url: `https://www.ups.com/track?loc=fr_FR&tracknum=${q}` };
  if (/^TBA\d{12}$/.test(c)) return { name: "Amazon", url: "https://www.amazon.fr/gp/your-account/order-history" };
  if (/^\d[A-Z]\d{11}$/.test(c) || /^[A-Z]{2}\d{9}FR$/.test(c)) return { name: "La Poste", url: `https://www.laposte.fr/outils/suivre-vos-envois?code=${q}` };
  if (/^JD\d{18}$/.test(c)) return { name: "DHL", url: `https://www.dhl.com/fr-fr/home/suivi.html?tracking-id=${q}` };
  return { name: "Colis", url: `https://t.17track.net/fr#nums=${q}` };
}

export function firstLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const telling = lines.find((l) => /error|erreur|exception|panic|failed|fatal|cannot|undefined/i.test(l));
  return telling ?? lines[0] ?? text.trim();
}

export function mapsUrl(address: string, directions: boolean): string {
  const q = encodeURIComponent(address.replace(/\s+/g, " ").trim());
  return directions ? `https://www.google.com/maps/dir/?api=1&destination=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function recentProject(): string | null {
  const recent = [...State.sessions].sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0))[0];
  return recent?.sessionCwd ?? State.settings.recentProjects?.[0] ?? null;
}

function askInChat(island: Island, query: string, hint: string) {
  if (!ChatBus.ask || ChatBus.busy) {
    island.setView("prompt");
    return;
  }
  State.isPinned = true;
  island.setView("prompt");
  void ChatBus.ask(query, { hint }).finally(() => {
    if (State.pendingApproval) return;
    State.isPinned = false;
    island.dropPin();
  });
}

function errorSpec(island: Island, text: string): HudSpec {
  const explain = () => askInChat(island, "Explique cette erreur", `Voici une erreur que je viens de copier :\n\n\`\`\`\n${text}\n\`\`\`\n\nExplique la cause la plus probable et comment la corriger, brièvement.`);
  const project = recentProject();
  const actions = [{ label: "Expliquer", primary: true, run: explain }];
  if (project) {
    actions.push({
      label: "Réparer",
      primary: false,
      run: () => {
        State.missionDraft = `Corrige cette erreur : ${text.replace(/\s+/g, " ").trim()}`.slice(0, MISSION_MAX);
        island.setView("mission");
      },
    });
  }
  return {
    key: "lens", banner: true, tone: "#F4505E", icon: "wrench", title: "Erreur copiée",
    detail: middle(firstLine(text), 140), meta: "Lentille", ms: 7000, priority: 2, actions,
  };
}

function englishSpec(island: Island, text: string): HudSpec {
  const translate = () => askInChat(island, "Traduis ce texte en français", `Texte à traduire en français (réponds uniquement par la traduction) :\n\n${text}`);
  return {
    key: "lens", banner: true, tone: "#38BDF8", icon: "languages", title: "Texte en anglais",
    detail: middle(text.replace(/\s+/g, " ").trim(), 140), meta: "Lentille", ms: 5200, priority: 1,
    actions: [{ label: "Traduire", primary: true, run: translate }],
  };
}

function trackingSpec(text: string): HudSpec {
  const c = carrier(text);
  const follow = () => void Bridge.openUrl(c.url);
  return {
    key: "lens", tone: "#F5A524", icon: "package", title: c.name === "Colis" ? "Numéro de suivi" : `Colis ${c.name}`,
    detail: text.trim().toUpperCase(), ms: 6000, priority: 2, onClick: follow,
    actions: [{ label: "Suivre", primary: true, run: follow }],
  };
}

function addressSpec(text: string): HudSpec {
  const route = () => void Bridge.openUrl(mapsUrl(text, true));
  const map = () => void Bridge.openUrl(mapsUrl(text, false));
  return {
    key: "lens", banner: true, tone: "#22C55E", icon: "mapPin", title: "Adresse copiée",
    detail: middle(text.replace(/\s+/g, " ").trim(), 120), meta: "Lentille", ms: 6000, priority: 2,
    actions: [{ label: "Itinéraire", primary: true, run: route }, { label: "Carte", run: map }],
  };
}

function specFor(island: Island, lens: LensInfo): HudSpec | null {
  switch (lens.kind) {
    case "error":
      return errorSpec(island, lens.text);
    case "english":
      return lens.text.length >= 60 ? englishSpec(island, lens.text) : null;
    case "tracking":
      return trackingSpec(lens.text);
    case "address":
      return addressSpec(lens.text);
    default:
      return null;
  }
}

function onLens(island: Island, lens: LensInfo) {
  if (!State.settings.lensEnabled || State.gameMode || State.paused || State.mode === "expanded") return;
  const now = Date.now();
  if (now - (last.get(lens.kind) ?? 0) < COOLDOWN_MS[lens.kind]) return;
  const spec = specFor(island, lens);
  if (!spec) return;
  last.set(lens.kind, now);
  if (island.hud(spec)) Sound.play("peek");
}

export function testLens(island: Island, kind: string) {
  const samples: Record<string, LensInfo> = {
    error: { kind: "error", text: "TypeError: Cannot read properties of undefined (reading 'map')\n    at renderList (src/app.ts:42:17)" },
    english: { kind: "english", text: "The meeting has been moved to Thursday, and you will need to bring the slides with you." },
    tracking: { kind: "tracking", text: "6A12345678901" },
    address: { kind: "address", text: "12 rue de la Paix 75002 Paris" },
  };
  const lens = samples[kind] ?? samples.error;
  const spec = specFor(island, lens);
  if (spec && island.hud(spec)) Sound.play("peek");
}

export function registerLens(island: Island) {
  void onEvent<LensInfo>("lens", (lens) => onLens(island, lens));
}
