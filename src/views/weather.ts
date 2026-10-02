import type { WeatherInfo } from "../core/bridge";
import type { ProIconName } from "./pro-icons";

export function weatherIcon(w: WeatherInfo): ProIconName {
  const c = w.code;
  if (c === 0) return w.isDay ? "sun" : "moon";
  if (c <= 2) return w.isDay ? "cloudSun" : "cloud";
  if (c === 3) return "cloud";
  if (c === 45 || c === 48) return "fog";
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 95) return "storm";
  return "rain";
}

export function weatherLabel(code: number): string {
  if (code === 0) return "Ciel dégagé";
  if (code === 1) return "Plutôt dégagé";
  if (code === 2) return "Partiellement nuageux";
  if (code === 3) return "Couvert";
  if (code === 45 || code === 48) return "Brouillard";
  if (code >= 51 && code <= 57) return "Bruine";
  if (code >= 61 && code <= 67) return "Pluie";
  if (code >= 71 && code <= 77) return "Neige";
  if (code >= 80 && code <= 82) return "Averses";
  if (code === 85 || code === 86) return "Averses de neige";
  if (code >= 95) return "Orage";
  return "Météo";
}

export function weatherTone(w: WeatherInfo): string {
  const icon = weatherIcon(w);
  if (icon === "sun") return "#FBBF24";
  if (icon === "moon") return "#C4B5FD";
  if (icon === "storm") return "#A78BFA";
  if (icon === "snow") return "#E0F2FE";
  if (icon === "rain") return "#60A5FA";
  return "#CBD5E1";
}
